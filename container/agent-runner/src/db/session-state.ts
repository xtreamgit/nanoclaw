/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

// ── Ghost-action prevention ──────────────────────────────────────────────────
//
// When context compaction fires mid-turn the new session loses behavioural
// context. Two flags survive in session_state (outbound.db) across the
// continuation reset so the next turn can warn the agent:
//
//   compaction_warning  — set when compaction is detected, cleared after
//                         the warning has been injected into the next prompt.
//   turn_in_progress    — set at turn start, cleared at successful turn end.
//                         If it exists on container startup the previous turn
//                         was interrupted (crash or abrupt kill).

const COMPACTION_WARNING_KEY = 'compaction_warning';
const TURN_IN_PROGRESS_KEY = 'turn_in_progress';

export function setCompactionWarning(): void {
  setValue(
    COMPACTION_WARNING_KEY,
    'Context compaction occurred during the previous turn. ' +
      'Tool calls initiated before compaction may not have completed. ' +
      'Verify any pending actions before proceeding.',
  );
}

/** Returns the warning text and deletes the key so it fires only once. */
export function getAndClearCompactionWarning(): string | null {
  const val = getValue(COMPACTION_WARNING_KEY);
  if (!val) return null;
  deleteValue(COMPACTION_WARNING_KEY);
  return val;
}

export function setTurnInProgress(): void {
  setValue(TURN_IN_PROGRESS_KEY, new Date().toISOString());
}

export function clearTurnInProgress(): void {
  deleteValue(TURN_IN_PROGRESS_KEY);
}

/**
 * Call on container startup (after clearStaleProcessingAcks).
 * If a turn_in_progress flag is present the previous container was killed
 * or crashed mid-turn — return the timestamp so the caller can warn the agent.
 * Always clears the flag regardless of return value.
 */
export function getAndClearInterruptedTurn(): string | null {
  const val = getValue(TURN_IN_PROGRESS_KEY);
  if (!val) return null;
  deleteValue(TURN_IN_PROGRESS_KEY);
  return val;
}
