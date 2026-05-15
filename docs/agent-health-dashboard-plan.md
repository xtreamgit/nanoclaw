# Agent Health & Cost Dashboard — Deployment Plan

**Status:** Planning
**Author:** Hector + Claude (May 15, 2026)
**Depends on:** `feat/routing-guard` (merged)

---

## Why

The May 10 runaway cost ~$360 in 4.5 hours and was only caught because
Hector noticed Saul's outbound DB had ballooned. The routing guard
(now merged) will *prevent* the next one — but Hector still has no
real-time visibility into:

| Question | Today |
|---|---|
| What's my Anthropic spend right now / today / this week? | Anthropic console only, account-wide, no per-agent breakdown |
| Which agents are healthiest / most active right now? | `docker ps` + grep through `nanoclaw.log` |
| Are any guard blocks firing? Which pairs? | Manual `sqlite3` query against `routing_blocks` |
| Did any agent crash-loop overnight? | Discover by accident the next morning |

The dashboard closes that gap. Not a "would be nice to have" — without it,
the guard's blocks are silent and we won't know if a *new* failure mode
is being throttled until we look.

---

## Phased rollout

### Phase 1 — Local CLI dashboard (1–2 hours)

Get visibility *now*, no infrastructure. A `nanoclaw-status` shell
script that prints, on demand:

```
$ nanoclaw-status

== Containers (live) ==============================================
  Saul             up 41m   sess-1777520861579-y4b96r
  Mara             stopped  last spawn 2026-05-15 09:30 (3h ago)
  Writer           stopped  last spawn 2026-05-14 16:01 (19h ago)
  Researcher       stopped  last spawn 2026-05-14 16:01 (19h ago)
  ...

== Outbound traffic (last 24h) ====================================
  Saul   → Telegram:    154 msgs
  Saul   → agents:        0 msgs   ← stopped delegating after 17:00
  Mara   → agents:       12 msgs
  ...

== Routing guard blocks (last 24h) ================================
  (none)                                          ← nothing throttled

== Errors (last 24h, top 5) =======================================
  EBADNAME https://smtp.migadu.com               × 47    (cosmetic)
  ETIMEDOUT smtp.migadu.com                      × 8     (since 10:00)
```

**How:** ~150-line bash + `sqlite3` script that joins
`docker ps`, `data/v2.db.agent_groups`, per-session `outbound.db`s,
`routing_blocks`, and `tail` of `logs/nanoclaw.error.log`. Runs in <1s.

**Value:** Hector can run it any time and answer 80% of "what's
happening?" questions without context-switching to the codebase.

**Limit:** No history beyond what's still in DBs/logs. No remote access.
No alerts.

### Phase 2 — Token cost collector (1 day)

The orchestrator and agent containers don't currently know what tokens
each Claude API call consumed. Two viable data sources:

| Source | Pros | Cons |
|---|---|---|
| **OneCLI vault proxy** (recommended) | All Claude API traffic already flows through it; one place to instrument | Requires patching OneCLI; needs token-counting middleware |
| Claude Code's `~/.claude/usage.jsonl` per container | No proxy changes needed | Per-container files; need a sidecar to ship them out |

**Recommendation: instrument OneCLI proxy.** Add a logging middleware
that records `(timestamp, agent_group_id, model, input_tokens, output_tokens, cost_usd)`
for every successful Anthropic API response. Append to a single
`token-usage.jsonl` file on the host or write rows to a new
`token_usage` table in `data/v2.db`.

The proxy already knows the agent identity (it injects per-agent
credentials), so attribution is free.

Cost calculation: hard-code Sonnet/Opus/Haiku pricing in a small lookup
table. Update when Anthropic publishes new prices (rare event).

**New tables (in `data/v2.db`):**

```sql
CREATE TABLE token_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_group_id  TEXT NOT NULL,
  model           TEXT NOT NULL,         -- 'claude-sonnet-4-6', etc.
  input_tokens    INTEGER NOT NULL,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  output_tokens   INTEGER NOT NULL,
  cost_usd        REAL NOT NULL,
  recorded_at     TEXT NOT NULL
);
CREATE INDEX idx_token_usage_agent_time ON token_usage(agent_group_id, recorded_at);
CREATE INDEX idx_token_usage_time ON token_usage(recorded_at);
```

**`nanoclaw-status` extension:** add a `Cost` section showing today /
this week / month-to-date, broken down by agent.

### Phase 3 — Web dashboard (1–2 days)

Once Phase 2 lands, we have queryable per-agent cost + health data
locally. Phase 3 makes it remotely viewable and adds historical charts.

**Tech choice — three options:**

| Stack | Setup time | Cost/mo | Hector's stack fit |
|---|---|---|---|
| **A. Next.js on Cloud Run + BigQuery** | 4–6h | $0–5 | ✅ matches Vercel/GCP preferences in CLAUDE.md |
| **B. Grafana Cloud (free tier) + SQLite Exporter** | 2h | $0 | ⚠️ off-stack but minimal effort |
| **C. Metabase self-hosted on the Mac** | 1h | $0 | ⚠️ local-only, defeats remote viewing |

**Recommendation: A.** A small Next.js app on Cloud Run, reading from
BigQuery. Aligns with the rest of Hector's infrastructure (Vercel,
GCP, develom-com pattern), supports later embedding into the develom-
com admin if we want one place for everything, and BigQuery's free
tier (~10 GB/mo storage, 1 TB/mo queries) easily covers this volume.

**Data flow:**

```
nanoclaw orchestrator (Mac)
    │
    ├─ data/v2.db (token_usage, routing_blocks, agent activity)
    │
    └─ → daily cron → exports last-24h delta to GCS as JSONL
              │
              └─ → BigQuery scheduled query (auto-loads from GCS)
                        │
                        └─ → Looker Studio dashboard (free, GCP-native)
                              + Next.js app on Cloud Run for custom views
```

Why two visualization layers: Looker Studio handles the standard "cost
by agent over time, top routing pairs, error counts" charts in 30
minutes of click-config. The Next.js app handles anything custom
(real-time guard-block stream, per-agent message timeline, ad-hoc
queries). Build Looker first; only build Next.js if Looker hits a wall.

**Dashboard panels (initial set):**

1. **Cost: 7-day spend by day**, stacked by model
2. **Cost: 7-day spend by agent** (table, sortable)
3. **Today's spend** vs configurable cap (gauge, color-coded)
4. **Agent activity:** containers spawned in last 24h (heatmap)
5. **Routing guard:** recent blocks (table — sender, recipient, reason, count, last seen)
6. **Errors:** top error messages in last 24h (table)
7. **Health summary:** count of agents that spawned in last 7 days vs total

### Phase 4 — Real-time alerts (4 hours)

Once dashboards work, layer on alerting. Three trigger types:

| Trigger | Threshold | Action |
|---|---|---|
| **Cost spike** | Daily spend exceeds `COST_CAP_USD_DAILY` (default $50) | Telegram message to Hector + email via Migadu |
| **Routing block burst** | Any (sender, recipient) pair gets ≥5 blocks in 5min | Telegram alert with agent names |
| **Agent health regression** | Agent that spawned ≥3 times in last 7 days hasn't spawned in 24h | Telegram alert |

**Implementation:** A small daemon on the orchestrator host
(`nanoclaw-watcher`) that runs every 60s, queries `token_usage` and
`routing_blocks`, applies thresholds, and pushes alerts via the
existing Telegram bot (reuses the bot token already in nanoclaw's
`.env`). Cooldown table prevents alert storms — at most one alert per
trigger type per pair per hour.

```sql
CREATE TABLE alert_history (
  trigger_type    TEXT NOT NULL,    -- 'cost_spike' | 'routing_burst' | 'health_regression'
  pair_key        TEXT NOT NULL,    -- e.g. 'saul:jean-luc' or '__global__'
  fired_at        TEXT NOT NULL,
  payload         TEXT,             -- JSON snapshot of what triggered it
  PRIMARY KEY (trigger_type, pair_key, fired_at)
);
CREATE INDEX idx_alert_history_recent ON alert_history(fired_at);
```

---

## Cost estimate (GCP)

At Hector's volume (~1k–10k messages/day, ~$5–50/day Anthropic spend):

| Component | Free tier | Estimated cost |
|---|---|---|
| BigQuery storage (~100 MB/yr) | 10 GB | $0 |
| BigQuery queries (~10 MB/day scanned) | 1 TB/mo | $0 |
| Cloud Run (Next.js, ~10 req/day) | 2M req/mo | $0 |
| GCS staging bucket | 5 GB | $0 |
| Looker Studio | unlimited | $0 |
| **Total monthly** | | **$0–2** |

The dashboard pays for itself the first time it catches a runaway.

---

## Decisions (locked May 15, 2026)

1. **OneCLI access for Phase 2:** Unknown — investigate during Phase 2 kickoff. If we can't patch OneCLI, fall back to per-container Claude Code log shipping.
2. **Cost cap default:** **$50/day**. Tunable via `COST_CAP_USD_DAILY` env.
3. **Web dashboard hosting:** **Separate Vercel project** (`agents.develom.com` or similar). Not embedded in `develom.com/admin`.
4. **Distribution:** **Opt-in skill** under `container/skills/agent-monitoring/` (or similar). Users install via the existing self-customize / install-skill flow when they want monitoring; not bundled in default setup.

---

## Build order recommendation

1. **Phase 1 (CLI tool) — this week.** No external deps; gives
   immediate visibility while Phase 2/3 are in flight.
2. **Phase 4 alerts (text-only, against existing data) — next.** The
   routing-guard already populates `routing_blocks`. We can wire an
   alert daemon that watches *just that table* in a few hours and
   start getting real-time loop notifications even before token-cost
   tracking lands.
3. **Phase 2 (token collector) — week 2.** Requires OneCLI changes;
   negotiate with the OneCLI maintainer or fork.
4. **Phase 3 (web dashboard) — week 3.** Once token data is flowing,
   the dashboard work is mostly pulling existing tables into BigQuery
   and pointing Looker Studio at them.

This gets the most-valuable signal (real-time loop alerts) into
Hector's hands within ~6 hours of work, with the heavier infra rolled
in after.
