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

# ── 2. Clear any stale process holding port 3000 ────────────────────────────
stale_pid=$("$LSOF" -ti :3000 2>/dev/null || true)
if [ -n "$stale_pid" ]; then
  log "Port 3000 held by PID $stale_pid — sending SIGTERM."
  kill -TERM "$stale_pid" 2>/dev/null || true
  sleep 4
  if kill -0 "$stale_pid" 2>/dev/null; then
    log "PID $stale_pid still alive after SIGTERM — force-killing."
    kill -9 "$stale_pid" 2>/dev/null || true
  fi
  log "Port 3000 cleared."
fi

# ── 3. Start NanoClaw ────────────────────────────────────────────────────────
log "Starting NanoClaw."
exec "$NODE" "$NANOCLAW_DIR/dist/index.js"
