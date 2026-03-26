#!/bin/bash
# Meet Server Watchdog — checks health and restarts via launchctl if down
# Intended to be called from cron or OpenClaw heartbeat

SERVICE="ai.openclaw.meet-server"
HEALTH_URL="http://localhost:5005/health"
LOG_DIR="/Users/you/meetmate/logs"
LOG_FILE="$LOG_DIR/watchdog.log"

mkdir -p "$LOG_DIR"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

RESPONSE=$(curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"ok":true'; then
  # Server is healthy — no action needed
  exit 0
fi

echo "$(ts) [WATCHDOG] Health check failed. Response: $RESPONSE" >> "$LOG_FILE"
echo "$(ts) [WATCHDOG] Attempting restart via launchctl kickstart..." >> "$LOG_FILE"

launchctl kickstart -k "gui/$(id -u)/$SERVICE" 2>>"$LOG_FILE"

sleep 8

RESPONSE2=$(curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null)
if echo "$RESPONSE2" | grep -q '"ok":true'; then
  echo "$(ts) [WATCHDOG] ✅ Restart successful. uptime=$(echo "$RESPONSE2" | grep -o '"uptime":[0-9.]*')" >> "$LOG_FILE"
  exit 0
else
  echo "$(ts) [WATCHDOG] ❌ Restart FAILED. Response: $RESPONSE2" >> "$LOG_FILE"
  exit 1
fi
