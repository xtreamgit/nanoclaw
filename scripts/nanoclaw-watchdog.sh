#!/bin/bash
# NanoClaw watchdog — health monitor and auto-recovery.
# Invoked every 60s by launchd StartInterval; checks Docker + NanoClaw,
# auto-restarts NanoClaw when Docker is healthy but NanoClaw is not,
# and sends Telegram alerts when intervention is needed.

NANOCLAW_DIR="/Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw"
DOCKER="/usr/local/bin/docker"
CURL="/usr/bin/curl"
LAUNCHCTL="/bin/launchctl"
LABEL="com.nanoclaw-v2-95375b94"
NANOCLAW_PORT=3000
STATE_FILE="/tmp/nanoclaw-watchdog.state"
LOG="$NANOCLAW_DIR/logs/nanoclaw-watchdog.log"
ALERT_AFTER=2   # send Telegram after this many consecutive failed checks
RESTART_WAIT=50 # max seconds to poll for NanoClaw after kickstart

log() {
  echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

# Load Telegram credentials from .env
telegram_token=""
telegram_chat=""
if [ -f "$NANOCLAW_DIR/.env" ]; then
  telegram_token=$(grep '^TELEGRAM_BOT_TOKEN=' "$NANOCLAW_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
  telegram_chat=$(grep '^ALERT_TELEGRAM_CHAT_ID=' "$NANOCLAW_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
fi

send_telegram() {
  local msg="$1"
  [ -z "$telegram_token" ] || [ -z "$telegram_chat" ] && return 0
  "$CURL" -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${telegram_token}/sendMessage" \
    -F "chat_id=${telegram_chat}" \
    -F "text=${msg}" \
    > /dev/null 2>&1 || true
}

# Read persisted state (survives across invocations; reset on reboot)
prev_failures=0
prev_state="ok"
if [ -f "$STATE_FILE" ]; then
  _f=$(awk -F= '/^failures/{print $2}' "$STATE_FILE" 2>/dev/null)
  _s=$(awk -F= '/^state/{print $2}' "$STATE_FILE" 2>/dev/null)
  prev_failures=${_f:-0}
  prev_state=${_s:-ok}
fi

save_state() {
  printf 'failures=%s\nstate=%s\n' "$1" "$2" > "$STATE_FILE"
}

# ── Health checks ─────────────────────────────────────────────────────────────

log "Checking Docker and NanoClaw health."

docker_ok=0
"$DOCKER" info > /dev/null 2>&1 && docker_ok=1

nanoclaw_ok=0
http_code=$("$CURL" -s -o /dev/null -w "%{http_code}" --connect-timeout 3 \
  "http://localhost:${NANOCLAW_PORT}/" 2>/dev/null) || http_code="000"
[ "$http_code" != "000" ] && nanoclaw_ok=1

# ── All healthy ───────────────────────────────────────────────────────────────

if [ "$docker_ok" -eq 1 ] && [ "$nanoclaw_ok" -eq 1 ]; then
  if [ "$prev_state" != "ok" ]; then
    log "Recovered from ${prev_state} — all systems healthy (Docker up, NanoClaw :${NANOCLAW_PORT} responding)."
    send_telegram "✅ NanoClaw watchdog [$(hostname)]: systems healthy again. Queued sessions recovering via host sweep."
  fi
  save_state 0 "ok"
  exit 0
fi

# ── Something is wrong ────────────────────────────────────────────────────────

failures=$((prev_failures + 1))

if [ "$docker_ok" -eq 0 ]; then
  log "Docker not responding (failure #${failures})."
  save_state "$failures" "docker_down"
  if [ "$failures" -eq "$ALERT_AFTER" ]; then
    send_telegram "⚠️ NanoClaw watchdog [$(hostname)]: Docker daemon is DOWN — NanoClaw cannot run. Start Docker Desktop. (${failures} consecutive checks)"
  fi
  exit 0
fi

# Docker is up but NanoClaw is down — attempt auto-restart
log "NanoClaw not responding on :${NANOCLAW_PORT} (failure #${failures}). Kicking launchd service."
save_state "$failures" "nanoclaw_down"

uid=$(id -u)
"$LAUNCHCTL" kickstart -k "gui/${uid}/${LABEL}" > /dev/null 2>&1 || {
  log "launchctl kickstart returned non-zero — service may already be restarting."
}

# Poll until NanoClaw responds or timeout
waited=0
recovered=0
while [ "$waited" -lt "$RESTART_WAIT" ]; do
  sleep 5
  waited=$((waited + 5))
  code=$("$CURL" -s -o /dev/null -w "%{http_code}" --connect-timeout 3 \
    "http://localhost:${NANOCLAW_PORT}/" 2>/dev/null) || code="000"
  if [ "$code" != "000" ]; then
    recovered=1
    break
  fi
done

if [ "$recovered" -eq 1 ]; then
  log "NanoClaw back up in ${waited}s. Host sweep will resume queued sessions."
  save_state 0 "ok"
  send_telegram "🔄 NanoClaw watchdog [$(hostname)]: NanoClaw was down and has been auto-restarted (up in ${waited}s). Queued sessions resuming via host sweep."
else
  log "NanoClaw did not respond within ${RESTART_WAIT}s after kickstart."
  if [ "$failures" -ge "$ALERT_AFTER" ]; then
    send_telegram "🚨 NanoClaw watchdog [$(hostname)]: NanoClaw is DOWN and failed to auto-recover after kickstart. Manual intervention required. Log: ${LOG}"
  fi
fi
