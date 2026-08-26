#!/bin/bash
# Install a per-user meetmate service using the native service manager.
#
# Usage:
#   ./scripts/install-service.sh --label LABEL --dir WORKING_DIR [--port PORT]
#   --port PORT    Server port (informational — logged, not embedded in the unit)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  exec "$SCRIPT_DIR/install-launchagent.sh" "$@"
fi

if [ "$OS" != "Linux" ]; then
  echo "Error: Unsupported operating system: $OS. Supported service paths are launchd on macOS and systemd on Linux." >&2
  exit 1
fi

is_wsl() {
  [ -r /proc/version ] && grep -qi microsoft /proc/version
}

print_wsl_systemd_hint() {
  echo "WSL2 requires systemd. Add the following to /etc/wsl.conf:" >&2
  echo "[boot]" >&2
  echo "systemd=true" >&2
  echo "Then run 'wsl --shutdown' from Windows and reopen WSL." >&2
}

if ! command -v systemctl >/dev/null 2>&1; then
  echo "Error: systemctl was not found in PATH." >&2
  if is_wsl; then
    print_wsl_systemd_hint
  else
    echo "systemd is required to install the meetmate service on Linux." >&2
  fi
  exit 1
fi

SYSTEMD_STATE="$(systemctl --user is-system-running 2>/dev/null || true)"
case "$SYSTEMD_STATE" in
  running|degraded) ;;
  *)
    echo "Error: The systemd user manager is not reachable (state: ${SYSTEMD_STATE:-unknown})." >&2
    if is_wsl; then
      print_wsl_systemd_hint
    else
      echo "Ensure systemd is running and your user session has a systemd user manager." >&2
    fi
    exit 1
    ;;
esac

TEMPLATE="$SCRIPT_DIR/systemd-template.service"

LABEL=""
WORKING_DIR=""
PORT=""

sed_escape() { local s="$1"; s="${s//\\/\\\\}"; s="${s//&/\\&}"; s="${s//|/\\|}"; printf '%s' "$s"; }

reject_newline() {
  local name="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* ]]; then
    echo "Error: $name must not contain a newline." >&2
    exit 1
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --dir)   WORKING_DIR="$2"; shift 2 ;;
    --port)  PORT="$2"; shift 2 ;;
    *)
      echo "Usage: $0 --label LABEL --dir WORKING_DIR [--port PORT]" >&2
      exit 2
      ;;
  esac
done

if [ -z "$LABEL" ] || [ -z "$WORKING_DIR" ]; then
  echo "Error: --label and --dir are required." >&2
  echo "Usage: $0 --label LABEL --dir WORKING_DIR [--port PORT]" >&2
  exit 1
fi

reject_newline "Label" "$LABEL"
reject_newline "Working directory" "$WORKING_DIR"

if [ ! -f "$TEMPLATE" ]; then
  echo "Error: Template not found at $TEMPLATE" >&2
  exit 1
fi

if [ ! -d "$WORKING_DIR" ]; then
  echo "Error: Working directory does not exist: $WORKING_DIR" >&2
  exit 1
fi

# Resolve paths
WORKING_DIR="$(cd "$WORKING_DIR" && pwd)"
LOG_DIR="$WORKING_DIR/logs"
NODE_PATH="$(command -v node || true)"

if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH" >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_PATH")"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_DEST="$UNIT_DIR/${LABEL}.service"

reject_newline "Node path" "$NODE_PATH"
reject_newline "Node directory" "$NODE_DIR"
reject_newline "Log directory" "$LOG_DIR"

LABEL_ESCAPED="$(sed_escape "$LABEL")"
WORKING_DIR_ESCAPED="$(sed_escape "$WORKING_DIR")"
NODE_PATH_ESCAPED="$(sed_escape "$NODE_PATH")"
NODE_DIR_ESCAPED="$(sed_escape "$NODE_DIR")"
LOG_DIR_ESCAPED="$(sed_escape "$LOG_DIR")"

echo "Installing systemd user service:"
echo "  Label:      $LABEL"
echo "  Directory:  $WORKING_DIR"
echo "  Node:       $NODE_PATH"
echo "  Log dir:    $LOG_DIR"
[ -n "$PORT" ] && echo "  Port:       $PORT (informational — logged, not embedded in the unit)"
echo "  Unit:       $UNIT_DEST"
echo ""

mkdir -p "$LOG_DIR" "$UNIT_DIR"

sed \
  -e "s|{{LABEL}}|${LABEL_ESCAPED}|g" \
  -e "s|{{WORKING_DIR}}|${WORKING_DIR_ESCAPED}|g" \
  -e "s|{{NODE_PATH}}|${NODE_PATH_ESCAPED}|g" \
  -e "s|{{NODE_DIR}}|${NODE_DIR_ESCAPED}|g" \
  -e "s|{{LOG_DIR}}|${LOG_DIR_ESCAPED}|g" \
  "$TEMPLATE" > "$UNIT_DEST"

if grep -q '{{' "$UNIT_DEST"; then
  echo "Error: unrendered placeholder in $UNIT_DEST" >&2
  exit 1
fi

echo "Unit installed."

systemctl --user daemon-reload
# enable + restart (not `enable --now`): a reinstall over a running service must
# pick up the freshly rendered unit, mirroring the launchd installer's bootout/bootstrap.
systemctl --user enable "${LABEL}.service"
systemctl --user restart "${LABEL}.service"

echo "Service enabled. Verifying..."

SERVICE_READY=true
# NRestarts resets on our explicit restart above, so any nonzero value here is a startup crash.
for _ in 1 2 3 4 5; do
  sleep 3
  if ! systemctl --user is-active --quiet "${LABEL}.service"; then
    SERVICE_READY=false
    break
  fi
  NRESTARTS="$(systemctl --user show -p NRestarts --value "${LABEL}.service" 2>/dev/null || true)"
  if [ "$NRESTARTS" != "0" ]; then
    SERVICE_READY=false
    break
  fi
done

if [ "$SERVICE_READY" = true ]; then
  echo "✅ $LABEL is running."
else
  echo "Error: $LABEL did not remain active without restarting." >&2
  systemctl --user status "${LABEL}.service" --no-pager -l 2>&1 | tail -20 >&2 || true
  journalctl --user -u "${LABEL}" --no-pager -n 20 >&2 || true
  exit 1
fi

echo "Logs:"
echo "  $LOG_DIR/meet-server.stdout.log"
echo "  $LOG_DIR/meet-server.stderr.log"
echo "Journal: journalctl --user -u ${LABEL}"
echo "NOTE: To keep the service running after logout, run:"
echo "  loginctl enable-linger \$USER"
