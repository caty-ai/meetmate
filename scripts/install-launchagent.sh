#!/bin/bash
# Install a LaunchAgent plist for an AI Meet Participant agent instance.
#
# Usage:
#   ./scripts/install-launchagent.sh --label LABEL --dir WORKING_DIR [--port PORT]
#
# Options:
#   --label LABEL   LaunchAgent label (e.g. ai-meet.agent-name)
#   --dir   DIR     Absolute path to the agent's working directory
#   --port  PORT    Server port (informational — logged, not embedded in plist)
#
# The script will:
#   1. Generate a plist from scripts/launchagent-template.plist
#   2. Install it to ~/Library/LaunchAgents/
#   3. Load the service via launchctl

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$SCRIPT_DIR/launchagent-template.plist"

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
NODE_PATH="$(which node)"

if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH" >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_PATH")"

PLIST_DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

reject_newline "Node path" "$NODE_PATH"
reject_newline "Node directory" "$NODE_DIR"
reject_newline "Log directory" "$LOG_DIR"

LABEL_ESCAPED="$(sed_escape "$LABEL")"
WORKING_DIR_ESCAPED="$(sed_escape "$WORKING_DIR")"
NODE_PATH_ESCAPED="$(sed_escape "$NODE_PATH")"
NODE_DIR_ESCAPED="$(sed_escape "$NODE_DIR")"
LOG_DIR_ESCAPED="$(sed_escape "$LOG_DIR")"

echo "Installing LaunchAgent:"
echo "  Label:      $LABEL"
echo "  Directory:  $WORKING_DIR"
echo "  Node:       $NODE_PATH"
echo "  Log dir:    $LOG_DIR"
[ -n "$PORT" ] && echo "  Port:       $PORT"
echo "  Plist:      $PLIST_DEST"
echo ""

# Unload existing service (unconditional — launchctl list detection is unreliable)
echo "Unloading existing service (if any)..."
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Create log directory
mkdir -p "$LOG_DIR"

# Generate plist from template
sed \
  -e "s|{{LABEL}}|${LABEL_ESCAPED}|g" \
  -e "s|{{WORKING_DIR}}|${WORKING_DIR_ESCAPED}|g" \
  -e "s|{{NODE_PATH}}|${NODE_PATH_ESCAPED}|g" \
  -e "s|{{NODE_DIR}}|${NODE_DIR_ESCAPED}|g" \
  -e "s|{{LOG_DIR}}|${LOG_DIR_ESCAPED}|g" \
  "$TEMPLATE" > "$PLIST_DEST"

if grep -q '{{' "$PLIST_DEST"; then
  echo "Error: unrendered placeholder in $PLIST_DEST" >&2
  rm -f "$PLIST_DEST"
  exit 1
fi

echo "Plist installed."

# Load the service
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "Service loaded. Verifying..."

if launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "✅ $LABEL is running."
else
  echo "⚠️  $LABEL may not have started. Check: launchctl list | grep $LABEL"
fi
