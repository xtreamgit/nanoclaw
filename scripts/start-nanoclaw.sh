#!/bin/bash
# Wrapper that ensures Docker is running and port 3000 is free before starting NanoClaw.
# Used as the launchd ProgramArguments entrypoint instead of node directly.

set -euo pipefail

NANOCLAW_DIR="/Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw"
NODE="/opt/homebrew/bin/node"
DOCKER="/usr/local/bin/docker"
LSOF="/usr/sbin/lsof"
MAX_WAIT=300   # seconds to wait for Docker before giving up
POLL_INTERVAL=10

log() { echo "[start-nanoclaw] $(date '+%H:%M:%S') $*" >&2; }

# ── 0. Resolve ports from .env ───────────────────────────────────────────────
WEBHOOK_PORT=3000
TASK_INJECT_PORT=3001
if [ -f "$NANOCLAW_DIR/.env" ]; then
  port_line=$(grep -E '^WEBHOOK_PORT=' "$NANOCLAW_DIR/.env" | tail -1)
  if [ -n "$port_line" ]; then WEBHOOK_PORT="${port_line#WEBHOOK_PORT=}"; fi
  ti_line=$(grep -E '^TASK_INJECT_PORT=' "$NANOCLAW_DIR/.env" | tail -1)
  if [ -n "$ti_line" ]; then TASK_INJECT_PORT="${ti_line#TASK_INJECT_PORT=}"; fi
fi

# ── 1. Wait for Docker ───────────────────────────────────────────────────────
elapsed=0
until "$DOCKER" info >/dev/null 2>&1; do
  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    log "Docker not available after ${MAX_WAIT}s — aborting. Start Docker Desktop and launchd will retry."
    exit 1
  fi
  log "Waiting for Docker... (${elapsed}s elapsed)"
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done
log "Docker is ready."

# ── 2. Clear any stale processes holding NanoClaw ports ─────────────────────
clear_port() {
  local port="$1"
  local stale
  stale=$("$LSOF" -ti :"$port" 2>/dev/null || true)
  if [ -n "$stale" ]; then
    log "Port $port held by PID $stale — sending SIGTERM."
    kill -TERM "$stale" 2>/dev/null || true
    sleep 4
    if kill -0 "$stale" 2>/dev/null; then
      log "PID $stale still alive after SIGTERM — force-killing."
      kill -9 "$stale" 2>/dev/null || true
    fi
    log "Port $port cleared."
  fi
}
clear_port "$WEBHOOK_PORT"
clear_port "$TASK_INJECT_PORT"

# ── 3. Start NanoClaw ────────────────────────────────────────────────────────
log "Starting NanoClaw (webhook=$WEBHOOK_PORT, task-inject=$TASK_INJECT_PORT)."
export WEBHOOK_PORT
exec "$NODE" "$NANOCLAW_DIR/dist/index.js"
