# Fix: Routing Guard for Runaway Agent-to-Agent Loops

**Date:** May 15, 2026
**Incident date:** May 10, 2026
**Affected component:** `src/modules/agent-to-agent/agent-route.ts` — agent message delivery
**New module:** `src/modules/routing-guard/`

---

## Symptom

On May 10, 2026, between 01:26 and 06:00 UTC, the orchestrator routed
**6,104 agent-to-agent messages** between Saul and Jean Luc. Normal
days see 7–33 such messages. Two-hour peak rate was 1,642/hour
(~27/minute, sustained).

Saul's outbound database (`messages_out`) showed:

| Recipient | Message count | Distinct content |
|---|---|---|
| Jean Luc | 5,982 | mostly 1 message, repeated |
| Victor / Mara / others | 122 | normal |

Of the 5,982 messages to Jean Luc, **6,013 of the 6,104 total had
identical content**: a JSON-wrapped error string starting

> `"Error: Claude Code native binary not found at /pnpm/bin/claude.
> Please ensure Claude Code is installed via native installer or
> specify a vali..."`

Jean Luc's outbound DB showed 5,983 mirror sends back to Saul on the
same day. The two agents were bouncing the same error indefinitely.

---

## Estimated cost

At ~5K input + 3K output tokens per message (conservative), 6,100
messages consumed:

- Input: 30M tokens × $3 / Mtok ≈ **$90**
- Output: 18M tokens × $15 / Mtok ≈ **$270**
- **Total: ~$360 of API spend in 4.5 hours, all wasted on duplicates.**

A circuit breaker capping at 60 sends/hour per pair would have stopped
this within ~2 minutes for under $5.

---

## Root cause (three layers)

| # | Layer | Status |
|---|---|---|
| 1 | `corepack` auto-pulled pnpm 11, which moved global binary install paths. `/pnpm/bin/claude` became invalid → containers failed to start with `"native binary not found"`. | **Fixed:** commit `7cf4a09` pins `pnpm@10.33.0` in the Dockerfile. |
| 2 | Saul's compaction-protocol-drift behavior caused him to retry/relay errors as plain messages instead of debugging the upstream failure. | Partially addressed: commit `8c901f9` ("prevent agent protocol drift after context compaction"). |
| 3 | **No rate limiting or loop detection in the routing layer.** Any future failure mode that produces error-bouncing between two agents would re-create the runaway. | **This fix.** |

Layer 1 plugged the immediate trigger. This document covers Layer 3 —
the systemic gap that made the trigger catastrophic.

---

## Fix: routing guard module

A new module, `src/modules/routing-guard/`, sits in front of
`routeAgentMessage()` in `src/modules/agent-to-agent/agent-route.ts`.
Every cross-agent message passes through `checkAndRecordSend()` before
any side effect (no inbound write, no `wakeContainer`).

### Two complementary guards

**Identical-content dedup (loop killer)**

Every message's content is hashed (SHA-256, 16 hex chars). The guard
counts how many times the same `(sender, recipient, content_hash)`
triple appeared in a sliding window (default: **3 sends per 5 minutes**).
The 4th identical send is dropped. This catches the May 10 pattern
within seconds.

**Per-pair rate limit (volume cap)**

Independently, the guard counts **total** sends per
`(sender, recipient)` in the rolling last hour (default: **60 / hour**).
The 61st is dropped, regardless of content. This catches slower-drift
loops where the message text varies but the pair is still chatty far
beyond normal.

The two guards run in order — dedup first because it's the more
specific signal. Both checks happen against the same point-in-time
snapshot of `routing_send_log` so a concurrent insert cannot make the
counts contradict each other.

### Self-messages bypass the guard

When `targetAgentGroupId === session.agent_group_id`, the message is a
system-injected note back into an agent's own session (e.g.
post-approval prompts). These can't loop on another agent and aren't
counted.

### Configurable

- `GUARD_OVERRIDES` env var: per-pair JSON overrides, e.g.
  `'{"saul:jean-luc":{"rateLimitPerHour":120}}'`.
- `GUARD_DISABLED=1`: bypass the guard entirely (debugging only).

---

## Schema additions

Migration `module-routing-guard` adds two tables:

```sql
CREATE TABLE routing_send_log (
  sender_id     TEXT NOT NULL,
  recipient_id  TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  sent_at       TEXT NOT NULL
);
-- pruned to last hour on every check; stays small under steady state.

CREATE TABLE routing_blocks (
  sender_id        TEXT NOT NULL,
  recipient_id     TEXT NOT NULL,
  reason           TEXT NOT NULL,         -- 'rate_limit' | 'dedup'
  content_hash     TEXT NOT NULL,
  blocked_count    INTEGER NOT NULL DEFAULT 1,
  first_blocked_at TEXT NOT NULL,
  last_blocked_at  TEXT NOT NULL,
  PRIMARY KEY (sender_id, recipient_id, reason, content_hash)
);
-- aggregated; repeat blocks bump the counter rather than inserting rows.
```

`routing_blocks` becomes the "what's currently throttled" table — a
single `SELECT … ORDER BY last_blocked_at DESC` answers it.

---

## Verification

The test that reproduces the incident:

```ts
it('caps an identical-error bounce loop within 5 sends', () => {
  const errorContent =
    '{"text":"Error: Claude Code native binary not found at /pnpm/bin/claude. Please ensure..."}';
  const accepted: boolean[] = [];
  for (let i = 0; i < 100; i++) {
    const decision = checkAndRecordSend(
      { senderId: 'saul', recipientId: 'jean-luc', content: errorContent },
    );
    accepted.push(decision.allowed);
  }
  expect(accepted.filter(Boolean).length).toBe(3); // not 100
});
```

With the guard in place, **3 of 100** attempts pass. Without it, all
100 would have routed (as 6,104 of 6,104 did on May 10). Full suite:
**287/287 tests pass.**

---

## What this does NOT do

- **No container kills.** The guard drops the message; the sending
  container keeps running. If the same agent has unrelated work, it
  continues.
- **No content modification.** Allowed messages pass through verbatim.
- **No inbound enforcement.** All agent-to-agent traffic flows through
  the orchestrator, so a single guard on the routing path is
  sufficient.
- **No automatic alerting (yet).** Blocks are logged at warn-level and
  recorded in `routing_blocks`. The dashboard described in
  `docs/agent-health-dashboard.md` (forthcoming) will surface these in
  near-real-time.

---

## Future work

1. **Token-cost tracking** — `routing_blocks` tells us how many sends
   were *blocked*, not how many tokens normal traffic *consumed*. A
   companion module that hooks into the per-session inbound delivery
   and records `(session_id, model, input_tokens, output_tokens, cost)`
   would close the loop on cost observability.
2. **Out-of-band alerting** — On first block of a new
   `(sender, recipient)` pair, push a Telegram message to the operator.
   Cooldown to one alert per pair per hour to avoid alert spam.
3. **Adaptive thresholds** — Per-agent baselines learned from
   `routing_send_log` history, replacing the static defaults.
