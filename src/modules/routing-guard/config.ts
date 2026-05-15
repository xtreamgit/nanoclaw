/**
 * Thresholds for the routing guard. Tuned conservatively — normal
 * agent-to-agent coordination rarely exceeds a handful of messages per
 * minute between any single pair, so the limits here are ~10× headroom
 * over typical use while still catching the May 10 2026 runaway
 * (1,642 messages/hour for one pair) within the first ~2 minutes.
 *
 * Per-pair overrides live in the GUARD_OVERRIDES env var as JSON, e.g.:
 *   GUARD_OVERRIDES='{"<sender>:<recipient>":{"rateLimitPerHour":300}}'
 *
 * Set GUARD_DISABLED=1 to bypass the guard entirely (debugging only).
 */
export interface GuardThresholds {
  /** Max accepted sends per (sender, recipient) per rolling hour. */
  rateLimitPerHour: number;
  /** Max accepted sends of identical content per (sender, recipient) per dedupWindowMs. */
  dedupMaxRepeats: number;
  /** Window for the dedup check, in milliseconds. */
  dedupWindowMs: number;
}

export const DEFAULT_THRESHOLDS: GuardThresholds = {
  rateLimitPerHour: 60,
  dedupMaxRepeats: 3,
  dedupWindowMs: 5 * 60 * 1000,
};

let _overrides: Record<string, Partial<GuardThresholds>> | null = null;

function loadOverrides(): Record<string, Partial<GuardThresholds>> {
  if (_overrides !== null) return _overrides;
  const raw = process.env.GUARD_OVERRIDES;
  if (!raw) {
    _overrides = {};
    return _overrides;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<GuardThresholds>>;
    _overrides = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    _overrides = {};
  }
  return _overrides;
}

export function thresholdsFor(senderId: string, recipientId: string): GuardThresholds {
  const overrides = loadOverrides();
  const pair = overrides[`${senderId}:${recipientId}`];
  if (!pair) return DEFAULT_THRESHOLDS;
  return {
    rateLimitPerHour: pair.rateLimitPerHour ?? DEFAULT_THRESHOLDS.rateLimitPerHour,
    dedupMaxRepeats: pair.dedupMaxRepeats ?? DEFAULT_THRESHOLDS.dedupMaxRepeats,
    dedupWindowMs: pair.dedupWindowMs ?? DEFAULT_THRESHOLDS.dedupWindowMs,
  };
}

export function isGuardDisabled(): boolean {
  return process.env.GUARD_DISABLED === '1';
}

/** Test-only: clear the overrides cache so a new env var value is picked up. */
export function _resetOverridesCacheForTests(): void {
  _overrides = null;
}
