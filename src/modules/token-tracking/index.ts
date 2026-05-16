/**
 * Token-tracking — ingest Claude Code's per-session JSONL logs into a
 * unified `token_usage` table, attributing every assistant message back
 * to the agent that produced it.
 *
 * No instrumentation needed inside containers: Claude Code already writes
 * every assistant turn (with `usage`) to
 *   <sessions>/<agent_group_id>/.claude-shared/projects/<project>/<session>.jsonl
 * The host has direct read access to those files via the same mount the
 * container writes through.
 *
 * Public API:
 *   runIngest(sessionsRoot)  — scan and ingest, returns a stats summary.
 *
 * The orchestrator calls `runIngest` on a periodic sweep (see startup
 * wiring in src/index.ts). The function is also safe to invoke from a
 * one-shot script when you want fresh totals on demand.
 */
export { runIngest } from './ingest.js';
export type { IngestStats } from './ingest.js';
export { computeCostUsd, priceFor } from './pricing.js';
export { startTokenIngestSweep, stopTokenIngestSweep } from './sweep.js';
