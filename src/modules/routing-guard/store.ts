import type Database from 'better-sqlite3';
import { createHash } from 'crypto';

import { getDb } from '../../db/connection.js';

/**
 * Short, indexable hash of message content. 16 hex chars = 64 bits — at the
 * volumes we expect (low thousands of distinct messages per pair per day),
 * birthday-collision risk is negligible and noise from a one-in-a-trillion
 * accidental match would only cause one extra dedup decision in 10^7 messages.
 */
export function contentHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex').slice(0, 16);
}

export interface SendCounts {
  hourTotal: number;
  recentDuplicates: number;
}

/**
 * Count accepted sends from sender→recipient in the rate-limit window
 * (1h hard-coded; matches the threshold in config.ts), plus the count of
 * sends with the same content_hash inside the dedup window.
 *
 * Both counts are taken from the same point-in-time snapshot of
 * routing_send_log so a concurrent insert can't make the totals
 * contradict each other.
 */
export function countRecent(
  senderId: string,
  recipientId: string,
  contentH: string,
  dedupWindowMs: number,
  db: Database.Database = getDb(),
): SendCounts {
  const now = Date.now();
  const hourCutoff = new Date(now - 60 * 60 * 1000).toISOString();
  const dedupCutoff = new Date(now - dedupWindowMs).toISOString();

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM routing_send_log
       WHERE sender_id = ? AND recipient_id = ? AND sent_at >= ?`,
    )
    .get(senderId, recipientId, hourCutoff) as { n: number };

  const dupRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM routing_send_log
       WHERE sender_id = ? AND recipient_id = ? AND content_hash = ? AND sent_at >= ?`,
    )
    .get(senderId, recipientId, contentH, dedupCutoff) as { n: number };

  return { hourTotal: totalRow.n, recentDuplicates: dupRow.n };
}

/** Record an accepted send. Caller has already validated thresholds. */
export function recordSend(
  senderId: string,
  recipientId: string,
  contentH: string,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `INSERT INTO routing_send_log (sender_id, recipient_id, content_hash, sent_at)
     VALUES (?, ?, ?, ?)`,
  ).run(senderId, recipientId, contentH, new Date().toISOString());
}

/**
 * Record a blocked send. Aggregated by (sender, recipient, reason, content_hash):
 * repeat blocks bump the counter rather than inserting a new row, so the table
 * stays small even under sustained loop pressure.
 */
export function recordBlock(
  senderId: string,
  recipientId: string,
  reason: 'rate_limit' | 'dedup',
  contentH: string,
  db: Database.Database = getDb(),
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO routing_blocks
       (sender_id, recipient_id, reason, content_hash, blocked_count, first_blocked_at, last_blocked_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(sender_id, recipient_id, reason, content_hash) DO UPDATE SET
       blocked_count = blocked_count + 1,
       last_blocked_at = excluded.last_blocked_at`,
  ).run(senderId, recipientId, reason, contentH, now, now);
}

/**
 * Periodic cleanup. Cheap to call (single DELETE on an indexed range), so we
 * piggyback it on every checkAndRecordSend rather than spinning up a sweeper.
 * Anything older than 1 hour is past every active window and serves no purpose.
 */
export function pruneOlderThanHour(db: Database.Database = getDb()): void {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM routing_send_log WHERE sent_at < ?`).run(cutoff);
}
