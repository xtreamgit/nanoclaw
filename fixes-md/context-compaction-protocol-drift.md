# Fix: Agent Protocol Drift After Context Compaction

**Date:** May 2, 2026
**Affected component:** `container/agent-runner/src/poll-loop.ts`, `container/agent-runner/src/destinations.ts`
**Commit:** `8c901f9`

---

## Problem

### Symptom

An agent (Saul) stops routing messages to other agents. It claims to have sent them — "Sent to both", "Pings sent to all agents" — but no containers ever spin up for the target agents. The host log shows zero `Agent message routed` events. Every entry in the agent's `outbound.db` has `channel_type = 'telegram'`; none have `channel_type = 'agent'`.

### Root Cause

Claude Code compacts session context when a conversation accumulates roughly 100k–130k tokens. During compaction it generates a summary of the conversation and appends it to the session transcript, replacing the full history.

The `<message to="name">...</message>` protocol is defined in the **system prompt** (injected once at container startup via `buildSystemPromptAddendum`). The system prompt itself survives compaction — it is re-sent with every API call. However, the **conversation examples** of correctly using the protocol do not survive. After compaction the model has no in-context demonstration of the behavior and stops following it, while still verbally claiming to send messages.

### Evidence

In Saul's session (`sess-1777520861579-y4b96r`):

| seq | timestamp | event |
|-----|-----------|-------|
| 1137 | 15:42 | Last correct agent message (`channel_type = 'agent'`, to Victor) |
| 1139 | 15:44 | `"Context compacted (132,009 tokens compacted)."` |
| 1141+ | 15:48+ | All messages go to Telegram only; agent claims to send but uses no `<message>` blocks |

After compaction, `dispatchResultText` found zero `<message to="...">` blocks in every response. Because the routing context had `channel_type = telegram`, the fallback path in `poll-loop.ts` sent the plain text (e.g. "Sent to both") back to the Telegram channel, producing the deceptive "I sent it" output.

### Manual Fix (immediate recovery)

Clear the `continuation:claude` row from the session's `outbound.db`. This forces a clean session on the next message so Claude re-reads the full system prompt:

```bash
SESS_DIR="data/v2-sessions/<agent-group-id>/<session-id>"
sqlite3 "$SESS_DIR/outbound.db" \
  "DELETE FROM session_state WHERE key LIKE 'continuation:%';"
```

Equivalent user-facing action: type `/clear` in the agent's DM on Telegram.

---

## Fix

Two complementary changes were made so this cannot silently recur.

### Fix 1 — Per-message routing reminder (`destinations.ts`)

Added `buildRoutingReminder()`, a new exported function that returns a one-line reminder string for any agent that has more than one destination including at least one agent destination:

```
[reminder: to reach another agent use <message to="name">…</message>; text outside those blocks is scratchpad only and goes nowhere]
```

This is appended to **every human-turn prompt** in `formatMessagesWithCommands` (`poll-loop.ts`). Because it is injected into the human turn on every message — not just the system prompt — it appears in the model's immediate context regardless of compaction state.

```typescript
// destinations.ts
export function buildRoutingReminder(): string {
  const all = getAllDestinations();
  if (all.length <= 1) return '';
  if (!all.some((d) => d.type === 'agent')) return '';
  return '[reminder: to reach another agent use <message to="name">…</message>; text outside those blocks is scratchpad only and goes nowhere]';
}

// poll-loop.ts — formatMessagesWithCommands
const reminder = buildRoutingReminder();
return reminder ? `${prompt}\n\n${reminder}` : prompt;
```

### Fix 2 — Compaction detection and automatic continuation reset (`poll-loop.ts`)

When the result text matches `/context compacted/i`, the poll-loop:

1. Calls `clearContinuation(providerName)` to erase the stored session ID from `outbound.db`.
2. Sets `queryContinuation = null` to signal the outer loop.
3. The outer loop sees `result.continuation === null` and resets its own `continuation` variable to `undefined`.

On the next incoming message, `query()` is called with no continuation — a completely fresh Claude Code session starts, re-reads the full system prompt, and has correct behavioral context from the start.

```typescript
// processQuery — result event handler
if (/context compacted/i.test(event.text)) {
  log('Context compaction detected — clearing continuation so next turn starts fresh');
  clearContinuation(providerName);
  queryContinuation = null; // signal outer loop to reset its copy
}
dispatchResultText(event.text, routing);

// runPollLoop — after processQuery returns
if (result.continuation === null) {
  continuation = undefined; // explicitly cleared
} else if (result.continuation && result.continuation !== continuation) {
  continuation = result.continuation;
  setContinuation(config.providerName, continuation);
}
```

### Defense in depth

| Layer | What it does |
|-------|--------------|
| Per-message reminder | Prevents drift — model sees the protocol instruction on every turn |
| Compaction detection | Recovers automatically — next session starts clean even if compaction occurs |
| `/clear` command | Manual escape hatch — always available in any agent's DM |

---

## Files Changed

| File | Change |
|------|--------|
| `container/agent-runner/src/destinations.ts` | Added `buildRoutingReminder()` export |
| `container/agent-runner/src/poll-loop.ts` | Import + append reminder; compaction detection; `QueryResult.continuation` typed as `string \| null \| undefined` |
| `docs/google-workspace-mcp-setup-fixes.md` | Added fix #10 documenting this issue |
