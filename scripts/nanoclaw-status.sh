#!/usr/bin/env bash
#
# nanoclaw-status — at-a-glance health view of a NanoClaw install.
#
# Reads:
#   - `docker ps` for live containers (filtered by nanoclaw-install label)
#   - data/v2.db for agent_groups + routing_blocks
#   - per-session outbound.db files for outbound traffic counts
#   - logs/nanoclaw.error.log + logs/nanoclaw.log for recent errors
#
# Writes nothing. Safe to run while nanoclaw is operating.
#
# Usage:
#   ./scripts/nanoclaw-status.sh            # last 24h window
#   ./scripts/nanoclaw-status.sh --hours 1  # last hour
#   ./scripts/nanoclaw-status.sh --hours 168 # last week
#   ./scripts/nanoclaw-status.sh --no-color # plain text (for piping/grep)
#
# Phase 1 of the agent-health-dashboard plan
# (docs/agent-health-dashboard-plan.md). Token-cost data is NOT shown here
# yet — it depends on Phase 2 (OneCLI proxy instrumentation) before
# token_usage rows exist to query.

set -euo pipefail

# ─── arg parse ──────────────────────────────────────────────────────────
HOURS=24
USE_COLOR=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours)    HOURS="$2"; shift 2 ;;
    --no-color) USE_COLOR=0; shift ;;
    -h|--help)
      cat <<'HELP'
nanoclaw-status — at-a-glance health view of a NanoClaw install.

Usage:
  nanoclaw-status                    # default 24h window, color
  nanoclaw-status --hours 1          # last hour
  nanoclaw-status --hours 168        # last week
  nanoclaw-status --no-color         # plain text (for piping/grep)

Sections shown:
  1. Live containers     (docker ps filtered to nanoclaw-install label)
  2. Agent activity      (spawn events from current orchestrator log)
  3. Outbound traffic    (per-agent agent/telegram counts in window)
  4. Routing-guard       (blocked sends from routing_blocks table)
  5. Top errors          (most frequent error messages, file-lifetime)
  6. Token cost          (Phase 2 placeholder — token_usage table)

Env vars:
  NANOCLAW_DIR           override install dir (default: ~/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw)
HELP
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Honour TTY: if stdout isn't a terminal, drop colour even if not asked.
[[ -t 1 ]] || USE_COLOR=0

if [[ "$USE_COLOR" == "1" ]]; then
  C_HEAD=$'\e[1;36m'   # cyan bold
  C_OK=$'\e[32m'       # green
  C_WARN=$'\e[33m'     # yellow
  C_ERR=$'\e[31m'      # red
  C_DIM=$'\e[2m'       # dim
  C_RST=$'\e[0m'
else
  C_HEAD=""; C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RST=""
fi

# ─── resolve install dir ────────────────────────────────────────────────
# Default to the canonical install path; override via NANOCLAW_DIR. We
# don't try to derive from the script path because users may symlink
# the script into ~/bin and expect it to find the install via env.
NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw}"
DB="$NANOCLAW_DIR/data/v2.db"
LOGS_DIR="$NANOCLAW_DIR/logs"
SESSIONS_DIR="$NANOCLAW_DIR/data/v2-sessions"

if [[ ! -f "$DB" ]]; then
  echo "${C_ERR}error:${C_RST} v2.db not found at $DB" >&2
  echo "Set NANOCLAW_DIR if your install is elsewhere." >&2
  exit 1
fi

# ISO timestamp for "now minus N hours" — used as a SQLite cutoff. Both
# BSD date (macOS default) and GNU date support `-u` and `-v` / `-d`,
# but the syntaxes differ. Try BSD first; fall back to GNU.
since_iso() {
  local h="$1"
  if date -u -v "-${h}H" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null; then
    return
  fi
  date -u -d "${h} hours ago" +%Y-%m-%dT%H:%M:%SZ
}
SINCE=$(since_iso "$HOURS")

print_header() {
  printf "\n%s== %s %s==%s\n" "$C_HEAD" "$1" \
    "$(printf '=%.0s' $(seq 1 $((60 - ${#1}))))" "$C_RST"
}

# ─── 1. containers ──────────────────────────────────────────────────────
print_header "Live containers"

LIVE_CONTAINERS=$(docker ps --filter "label=nanoclaw-install" \
  --format "{{.Names}}|{{.Status}}|{{.RunningFor}}" 2>/dev/null || true)

if [[ -z "$LIVE_CONTAINERS" ]]; then
  echo "  ${C_DIM}(none running — agents wake on demand)${C_RST}"
else
  printf "  %-50s  %s\n" "NAME" "STATUS"
  while IFS='|' read -r name status _runningfor; do
    # Strip nanoclaw-v2- prefix and timestamp suffix for readability.
    short=$(echo "$name" | sed -E 's/^nanoclaw-v2-//; s/-[0-9]{13,}$//')
    printf "  %-50s  ${C_OK}%s${C_RST}\n" "$short" "$status"
  done <<<"$LIVE_CONTAINERS"
fi

# ─── 2. recent agent activity (last spawn per agent) ────────────────────
print_header "Agent activity (spawn events in current log)"

# Pull spawn events from nanoclaw.log. The log lacks date stamps on each
# line so we can't accurately filter by HOURS — but the file represents
# the current orchestrator process's lifetime, which is usually the most
# relevant window anyway. Format: `[HH:MM:SS.mmm] INFO Spawning container
# ... agentGroup="X"`.
LOG="$LOGS_DIR/nanoclaw.log"
if [[ ! -f "$LOG" ]]; then
  echo "  ${C_DIM}(no log file at $LOG)${C_RST}"
else
  # Single awk pass: strip ANSI escapes (the logger colorizes keys, which
  # would otherwise sit between `agentGroup` and `=` and break the regex),
  # extract agent name via sub, tally per agent, capture last-seen timestamp.
  ROWS=$(awk '
    /Spawning container/ {
      line = $0
      gsub(/\033\[[0-9;]*m/, "", line)   # strip ANSI color codes
      ag = line
      if (!sub(/.*agentGroup="/, "", ag)) next
      sub(/".*$/, "", ag)
      ts = line
      sub(/].*/, "]", ts)
      last_ts[ag] = ts
      cnt[ag]++
    }
    END {
      for (a in cnt) printf "%s|%d|%s\n", a, cnt[a], last_ts[a]
    }
  ' "$LOG" | sort -t'|' -k2 -nr)

  if [[ -z "$ROWS" ]]; then
    echo "  ${C_DIM}(no Spawning container events in current log)${C_RST}"
  else
    printf "  %-25s  %6s  %s\n" "AGENT" "SPAWNS" "LAST"
    while IFS='|' read -r agent count ts; do
      printf "  %-25s  ${C_OK}%6d${C_RST}  %s\n" "$agent" "$count" "$ts"
    done <<<"$ROWS"
  fi
fi

# ─── 3. outbound traffic per agent ──────────────────────────────────────
print_header "Outbound traffic by agent (last ${HOURS}h)"

if [[ ! -d "$SESSIONS_DIR" ]]; then
  echo "  ${C_DIM}(no sessions dir at $SESSIONS_DIR)${C_RST}"
else
  printf "  %-25s  %8s  %8s  %s\n" "AGENT" "AGENT-MSG" "TG-MSG" "TOTAL"
  # Walk each (agent_group)/(session)/outbound.db, join name from v2.db.
  while IFS= read -r outbound_db; do
    # path: .../v2-sessions/<agent_group_id>/<session_id>/outbound.db
    ag_id=$(basename "$(dirname "$(dirname "$outbound_db")")")
    name=$(sqlite3 "$DB" "SELECT name FROM agent_groups WHERE id = '$ag_id';" 2>/dev/null || echo "?")
    [[ -z "$name" ]] && name="(unknown:$ag_id)"

    # Per-channel-type counts. Some sessions have no messages_out yet.
    counts=$(sqlite3 "$outbound_db" "
      SELECT channel_type, COUNT(*)
        FROM messages_out
       WHERE timestamp >= '$SINCE'
       GROUP BY channel_type;
    " 2>/dev/null || true)

    agent_n=0; tg_n=0
    while IFS='|' read -r ch n; do
      [[ -z "$ch" ]] && continue
      case "$ch" in
        agent)    agent_n="$n" ;;
        telegram) tg_n="$n" ;;
      esac
    done <<<"$counts"
    total=$((agent_n + tg_n))

    [[ "$total" == "0" ]] && continue

    color="$C_RST"
    [[ "$agent_n" -gt 100 ]] && color="$C_WARN"
    [[ "$agent_n" -gt 500 ]] && color="$C_ERR"
    printf "  %-25s  ${color}%8d${C_RST}  %8d  %5d\n" \
      "$name" "$agent_n" "$tg_n" "$total"
  done < <(find "$SESSIONS_DIR" -type f -name "outbound.db" 2>/dev/null) | sort -k4 -nr -t' '
fi

# ─── 4. routing-guard blocks ────────────────────────────────────────────
print_header "Routing-guard blocks (last ${HOURS}h)"

# routing_blocks may not exist yet if the routing-guard migration hasn't
# run. Probe gracefully so the script works on un-upgraded installs.
HAS_BLOCKS=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='routing_blocks';" 2>/dev/null || true)

if [[ -z "$HAS_BLOCKS" ]]; then
  echo "  ${C_DIM}(routing_blocks table not present — routing-guard not installed)${C_RST}"
else
  ROWS=$(sqlite3 "$DB" "
    SELECT
      rb.sender_id,
      rb.recipient_id,
      rb.reason,
      rb.blocked_count,
      rb.last_blocked_at,
      COALESCE(s.name,  'agent:'||substr(rb.sender_id, 4, 8)),
      COALESCE(r.name,  'agent:'||substr(rb.recipient_id, 4, 8))
    FROM routing_blocks rb
    LEFT JOIN agent_groups s ON s.id = rb.sender_id
    LEFT JOIN agent_groups r ON r.id = rb.recipient_id
    WHERE rb.last_blocked_at >= '$SINCE'
    ORDER BY rb.last_blocked_at DESC
    LIMIT 20;
  " 2>/dev/null || true)

  if [[ -z "$ROWS" ]]; then
    echo "  ${C_OK}(none — no agent-to-agent loops detected)${C_RST}"
  else
    printf "  %-15s → %-15s  %-12s  %5s  %s\n" "FROM" "TO" "REASON" "COUNT" "LAST"
    while IFS='|' read -r _sid _rid reason count last sname rname; do
      [[ -z "$reason" ]] && continue
      color="$C_WARN"
      [[ "$count" -gt 50 ]] && color="$C_ERR"
      printf "  %-15s → %-15s  ${color}%-12s${C_RST}  ${color}%5d${C_RST}  %s\n" \
        "$sname" "$rname" "$reason" "$count" "$last"
    done <<<"$ROWS"
  fi
fi

# ─── 5. recent errors ───────────────────────────────────────────────────
print_header "Top errors (last ${HOURS}h)"

ERR_LOG="$LOGS_DIR/nanoclaw.error.log"
if [[ ! -f "$ERR_LOG" ]]; then
  echo "  ${C_DIM}(no error log)${C_RST}"
else
  # Extract distinguishing error tokens — the first ~80 chars after `error:`
  # or after the level marker. Group by that, count, sort desc.
  ERRORS=$(awk '
    /\[31mERROR\[39m|"error":|err: Error:|error: / {
      # Find the meaningful slice: prefer "Error: ..." then truncate.
      if (match($0, /Error: [^"\\]{1,80}/)) {
        msg = substr($0, RSTART, RLENGTH)
      } else if (match($0, /error: [^"\\]{1,80}/)) {
        msg = substr($0, RSTART+7, RLENGTH-7)
      } else {
        next
      }
      counts[msg]++
    }
    END {
      for (m in counts) printf "%6d  %s\n", counts[m], m
    }
  ' "$ERR_LOG" | sort -rn | head -5)

  if [[ -z "$ERRORS" ]]; then
    echo "  ${C_OK}(no errors found)${C_RST}"
  else
    while IFS= read -r line; do
      count=$(echo "$line" | awk '{print $1}')
      msg=$(echo "$line" | sed 's/^ *[0-9]* *//')
      color="$C_DIM"
      [[ "$count" -gt 5 ]]  && color="$C_WARN"
      [[ "$count" -gt 50 ]] && color="$C_ERR"
      printf "  ${color}%5dx${C_RST}  %s\n" "$count" "$msg"
    done <<<"$ERRORS"
  fi
fi

# ─── 6. cost (Phase 2 placeholder) ──────────────────────────────────────
print_header "Token cost (last ${HOURS}h)"
HAS_USAGE=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage';" 2>/dev/null || true)
if [[ -z "$HAS_USAGE" ]]; then
  echo "  ${C_DIM}(token_usage table not present — Phase 2 not yet shipped)${C_RST}"
  echo "  ${C_DIM}see docs/agent-health-dashboard-plan.md${C_RST}"
else
  sqlite3 "$DB" "
    SELECT
      printf('  %-25s  \$%8.2f', COALESCE(g.name, 'unknown'), SUM(t.cost_usd))
    FROM token_usage t
    LEFT JOIN agent_groups g ON g.id = t.agent_group_id
    WHERE t.recorded_at >= '$SINCE'
    GROUP BY t.agent_group_id
    ORDER BY SUM(t.cost_usd) DESC;
  " 2>/dev/null
  total=$(sqlite3 "$DB" "SELECT printf('%.2f', COALESCE(SUM(cost_usd), 0)) FROM token_usage WHERE recorded_at >= '$SINCE';" 2>/dev/null)
  printf "  ${C_HEAD}%-25s  \$%8s${C_RST}\n" "TOTAL" "$total"
fi

echo ""
