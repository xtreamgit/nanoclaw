# Alerts Module — Phase 4 of the Agent-Health Dashboard

**Status:** Shipped May 16, 2026
**Depends on:** `routing-guard` (Phase 0), `token-tracking` (Phase 2)

---

## Why this exists

The routing guard caps runaway loops at the source. The token-tracking
module attributes spend per agent. But neither one *tells you* when
something's wrong — you have to remember to run `nanoclaw-status`.

Phase 4 closes that gap: a 60s sweep inside the orchestrator evaluates
three threshold checks against the data the other two modules populate,
and pushes a Telegram message via the existing Saul bot when something
crosses the line. Cooldown-gated, so a sustained breach produces one
alert per hour, not one per minute.

---

## Triggers

| Type | What it watches | Default threshold | Pair key | Cooldown |
|---|---|---|---|---|
| `cost_spike` | `SUM(token_usage.cost_usd)` since UTC midnight | $50/day | `__global__` | 1h |
| `routing_burst` | `SUM(routing_blocks.blocked_count)` per (sender, recipient) over 5min | 5 blocks | `<sender>:<recipient>` | 1h |
| `agent_regression` | Agent with ≥3 spawns in last 7d, silent for >24h | 3 spawns / 24h silent | `<agent_id>` | 1h |

All numerics tunable via env (see `config.ts`).

## Env vars

```
COST_CAP_USD_DAILY              50         # cost spike threshold
ROUTING_BURST_THRESHOLD         5          # blocks per pair to trigger
ROUTING_BURST_WINDOW_MS         300000     # 5min default
AGENT_REGRESSION_MIN_RECENT     3
AGENT_REGRESSION_RECENT_DAYS    7
AGENT_REGRESSION_SILENT_HOURS   24
ALERT_COOLDOWN_HOURS            1

ALERT_TELEGRAM_CHAT_ID          <required for dispatch — empty disables>
TELEGRAM_BOT_TOKEN              <reused from existing config>
ALERTS_DISABLED                 "1" to skip the entire cycle (debug)
```

## What an alert looks like

Sent as a Telegram message from the Saul bot, Markdown-formatted:

```
🚨 *Cost cap exceeded*
Day-to-date spend: *$73.42*
Cap: $50
Run `nanoclaw-status` for per-agent breakdown.
```

```
🚨 *Routing-guard burst*
Pair: *Saul* → *Jean Luc*
Blocked sends: *12* (threshold 5)
Guard is suppressing the loop. Investigate before lifting overrides.
```

```
⚠️ *Agent regression*
Agent: *Mara*
Was active 8× in last 7d, silent for >24h
Last active: 2026-05-14T12:00:00Z
```

## Architecture

```
src/modules/alerts/
├── config.ts        env → AlertThresholds; dispatch endpoint config
├── store.ts         alert_history reads/writes + cooldown lookup
├── checks.ts        three pure threshold checks → AlertRecord[]
├── dispatcher.ts    Telegram HTTP send (bypasses channel adapter to avoid
│                    coupling alerts to channel registration timing)
├── sweep.ts         60s periodic cycle: evaluate → cooldown → dispatch → record
├── checks.test.ts   22 unit tests
└── index.ts         public API
```

**Why bypass the channel adapter for dispatch:** the alert path needs to
work even if Telegram channel registration is broken (the most likely
condition that *causes* alerts to be needed). Raw `fetch` to
`api.telegram.org/bot<token>/sendMessage` is 5 lines and has zero
coupling to the rest of the system.

## Schema additions

Migration `module-alerts`:

```sql
CREATE TABLE alert_history (
  trigger_type    TEXT NOT NULL,
  pair_key        TEXT NOT NULL,
  fired_at        TEXT NOT NULL,
  payload         TEXT,                     -- JSON snapshot
  delivered       INTEGER NOT NULL DEFAULT 0,
  delivery_error  TEXT,
  PRIMARY KEY (trigger_type, pair_key, fired_at)
);
```

One row per fire. Cooldown query: "most recent row for
(trigger_type, pair_key) — if it's inside the cooldown window, suppress."

`payload` is freeform JSON capturing the snapshot at fire time. Useful
both for the alert body (formatter reads it) and for post-hoc debugging
of false positives.

## Tested against May 10 incident profile

Reproduction case from `checks.test.ts`:

```ts
block('saul', 'jean-luc', 6, minutesAgo(1));
const alerts = checkRoutingBurst(DEFAULT_THRESHOLDS, db);
expect(alerts[0].payload.blockedCount).toBe(6);
```

In the May 10 scenario the routing guard would have blocked 6,001 of
the 6,004 sends, the burst check would have fired within the first
~5 minutes (when block count crossed 5), and Hector would have gotten
a Telegram ping describing the pair and the count. The combined effect
of routing-guard + this alert: an incident that previously took 4.5
hours and ~$360 to surface to a human is now capped at <$5 of damage
and a minute or two of latency.

## How to silence in an emergency

```bash
ALERTS_DISABLED=1 launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-95375b94
```

Or unset `ALERT_TELEGRAM_CHAT_ID` to keep recording firings to
`alert_history` without paging the operator.

## Future hooks

- **Email backup channel.** If Telegram is the thing that broke, email
  via the Migadu SMTP that's already wired in develom-com. Not added
  yet because today's Telegram errors are intermittent network blips,
  not sustained outages.
- **Adaptive cost cap.** Day-of-week aware (Mondays run heavier batch
  jobs), or a 7-day moving average. Static $50 was chosen for v1 because
  it's easy to reason about; tune after a couple weeks of real data.
- **Hourly digest.** Even when nothing's wrong, a single "all good — $X
  spent, Y agents active" message at end-of-day would give Hector a
  routine pulse without needing to run `nanoclaw-status`.
