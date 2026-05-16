import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { isGuardDisabled, thresholdsFor } from './config.js';
import { contentHash, countRecent, pruneOlderThanHour, recordBlock, recordSend } from './store.js';

export type BlockReason = 'rate_limit' | 'dedup';

export interface GuardDecision {
  allowed: boolean;
  reason?: BlockReason;
  /** Human-readable reason — safe to log or surface in routing_blocks. */
  message?: string;
}

export interface GuardInput {
  senderId: string;
  recipientId: string;
  content: string;
}

/**
 * Decide whether an agent-to-agent send should proceed, and atomically
 * record the result.
 *
 * Two checks, in order — dedup first because it's the more specific signal:
 *
 *   1. Identical-content dedup. If the same (sender, recipient, content)
 *      has been sent ≥ dedupMaxRepeats times in the last dedupWindowMs,
 *      block. This catches tight error-bounce loops (May 10 2026 incident).
 *
 *   2. Per-pair rate limit. If the (sender, recipient) pair has sent
 *      ≥ rateLimitPerHour in the last hour (any content), block. This
 *      catches slower-drift loops where the message text changes but the
 *      pair is still chatty far beyond normal.
 *
 * On block: increments routing_blocks counter, logs at warn level, returns
 * { allowed: false, reason }. Caller is responsible for skipping the actual
 * delivery.
 *
 * On accept: writes to routing_send_log, returns { allowed: true }.
 *
 * GUARD_DISABLED=1 short-circuits to allow without recording — handy for
 * one-off debugging when the guard itself is suspected.
 */
export function checkAndRecordSend(input: GuardInput, db?: Database.Database): GuardDecision {
  if (isGuardDisabled()) return { allowed: true };

  const { senderId, recipientId, content } = input;
  const thresholds = thresholdsFor(senderId, recipientId);
  const ch = contentHash(content);

  // Cheap incremental cleanup — single indexed DELETE that runs in microseconds
  // when there's nothing to prune. Keeps the table from growing unbounded.
  pruneOlderThanHour(db);

  const counts = countRecent(senderId, recipientId, ch, thresholds.dedupWindowMs, db);

  if (counts.recentDuplicates >= thresholds.dedupMaxRepeats) {
    recordBlock(senderId, recipientId, 'dedup', ch, db);
    log.warn('Outbound DEDUP-BLOCKED', {
      senderId,
      recipientId,
      contentHash: ch,
      recentDuplicates: counts.recentDuplicates,
      threshold: thresholds.dedupMaxRepeats,
      windowMs: thresholds.dedupWindowMs,
    });
    return {
      allowed: false,
      reason: 'dedup',
      message: `identical content sent ${counts.recentDuplicates} times in last ${Math.round(thresholds.dedupWindowMs / 1000)}s`,
    };
  }

  if (counts.hourTotal >= thresholds.rateLimitPerHour) {
    recordBlock(senderId, recipientId, 'rate_limit', ch, db);
    log.warn('Outbound RATE-LIMITED', {
      senderId,
      recipientId,
      contentHash: ch,
      hourTotal: counts.hourTotal,
      threshold: thresholds.rateLimitPerHour,
    });
    return {
      allowed: false,
      reason: 'rate_limit',
      message: `${counts.hourTotal} messages from ${senderId} → ${recipientId} in last hour exceeds limit ${thresholds.rateLimitPerHour}`,
    };
  }

  recordSend(senderId, recipientId, ch, db);
  return { allowed: true };
}
