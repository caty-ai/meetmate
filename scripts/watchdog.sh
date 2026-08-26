#!/bin/bash
# Meet Server Watchdog — checks health, restarts if down, notifies on recovery only
# State-based: only sends Slack notification on state transition (down → up)
# Intended to be called from cron or a heartbeat job
#
# Usage: ./watchdog.sh [--service NAME] [--port PORT] [--log-dir DIR]
# Environment variables (args take precedence):
#   WATCHDOG_SERVICE  — native service label / systemd unit name (default: ai-meet.server)
#   WATCHDOG_PORT     — Server port to health-check (default: 5005)
#   WATCHDOG_LOG_DIR  — Log directory (default: ./logs relative to script dir)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Defaults (env vars override, then args override)
SERVICE="${WATCHDOG_SERVICE:-ai-meet.server}"
PORT="${WATCHDOG_PORT:-5005}"
LOG_DIR="${WATCHDOG_LOG_DIR:-$SCRIPT_DIR/../logs}"

# Parse arguments (take precedence over env vars)
while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --port)    PORT="$2";    shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    *)
      echo "Usage: $0 [--service NAME] [--port PORT] [--log-dir DIR]" >&2
      exit 2
      ;;
  esac
done

HEALTH_URL="http://localhost:${PORT}/health"
LOG_FILE="$LOG_DIR/watchdog.log"
STATE_FILE="$LOG_DIR/.watchdog-state"

mkdir -p "$LOG_DIR"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

# Read previous state (healthy / unhealthy / unknown)
PREV_STATE="unknown"
if [ -f "$STATE_FILE" ]; then
  PREV_STATE=$(cat "$STATE_FILE")
fi

RESPONSE=$(curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"ok":true'; then
  # Server is healthy
  if [ "$PREV_STATE" = "unhealthy" ]; then
    # Recovered! Log and notify
    UPTIME=$(echo "$RESPONSE" | grep -o '"uptime":[0-9.]*' | cut -d: -f2)
    echo "$(ts) [WATCHDOG] ✅ Recovered! uptime=${UPTIME}s" >> "$LOG_FILE"
    echo "healthy" > "$STATE_FILE"
    exit 0
  fi
  # Consistently healthy — silent
  echo "healthy" > "$STATE_FILE"
  exit 0
fi

# Server is unhealthy
echo "$(ts) [WATCHDOG] Health check failed. Response: $RESPONSE" >> "$LOG_FILE"

if [ "$PREV_STATE" != "unhealthy" ]; then
  # First failure — log transition
  echo "$(ts) [WATCHDOG] ⚠️ State transition: ${PREV_STATE} → unhealthy" >> "$LOG_FILE"
fi

echo "unhealthy" > "$STATE_FILE"

if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  echo "$(ts) [WATCHDOG] Attempting restart via launchctl kickstart..." >> "$LOG_FILE"
  launchctl kickstart -k "gui/$(id -u)/$SERVICE" 2>>"$LOG_FILE"
elif command -v systemctl >/dev/null 2>&1; then
  # cron/heartbeat environments lack it and systemctl --user cannot reach the user bus without it.
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  echo "$(ts) [WATCHDOG] Attempting restart via systemctl --user restart..." >> "$LOG_FILE"
  systemctl --user restart "$SERVICE" 2>>"$LOG_FILE"
else
  echo "$(ts) [WATCHDOG] no supported service manager (launchctl/systemctl) — cannot restart" >> "$LOG_FILE"
  exit 1
fi

sleep 8

RESPONSE2=$(curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null)
if echo "$RESPONSE2" | grep -q '"ok":true'; then
  UPTIME=$(echo "$RESPONSE2" | grep -o '"uptime":[0-9.]*' | cut -d: -f2)
  echo "$(ts) [WATCHDOG] ✅ Restart successful. uptime=${UPTIME}s" >> "$LOG_FILE"
  echo "healthy" > "$STATE_FILE"
  exit 0
else
  echo "$(ts) [WATCHDOG] ❌ Restart FAILED. Response: $RESPONSE2" >> "$LOG_FILE"
  # State stays unhealthy — next run will retry
  exit 1
fi
