import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Routing guard tables: per-pair sliding-window counters + blocked-send log.
 *
 * Owned by the `routing-guard` module (src/modules/routing-guard/). The guard
 * sits in front of agent-to-agent message delivery and refuses sends that
 * exceed configured thresholds, preventing runaway loops like the May 10 2026
 * incident where two agents bounced an identical error ~6,000 times in 4.5
 * hours (~$360 in wasted API spend).
 *
 * `routing_send_log`
 *   Sliding-window record of every accepted send. The guard prunes rows older
 *   than the longest active window (1h by default) on each check, so this
 *   table stays small. content_hash is a 16-char hex prefix of sha256 — short
 *   enough to index cheaply, long enough that natural collisions are
 *   negligible at the volumes we expect.
 *
 * `routing_blocks`
 *   Aggregated record of blocked sends. One row per
 *   (sender, recipient, reason, content_hash) — repeat blocks bump the
 *   counter and update last_blocked_at instead of inserting new rows. This
 *   keeps the table small (max ~1k rows ever, in practice) and makes the
 *   "what's currently being throttled" query trivial.
 *
 * Both tables are append-only from the guard's perspective. A periodic
 * cleanup task can prune `routing_send_log` further, but the simple "delete
 * older than window" inside checkAndRecordSend is enough for steady state.
 */
export const moduleRoutingGuard: Migration = {
  version: 14,
  name: 'routing-guard',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE routing_send_log (
        sender_id     TEXT NOT NULL,
        recipient_id  TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        sent_at       TEXT NOT NULL
      );
      CREATE INDEX idx_routing_send_log_pair_time
        ON routing_send_log(sender_id, recipient_id, sent_at);
      CREATE INDEX idx_routing_send_log_dedup
        ON routing_send_log(sender_id, recipient_id, content_hash, sent_at);

      CREATE TABLE routing_blocks (
        sender_id        TEXT NOT NULL,
        recipient_id     TEXT NOT NULL,
        reason           TEXT NOT NULL,
        content_hash     TEXT NOT NULL,
        blocked_count    INTEGER NOT NULL DEFAULT 1,
        first_blocked_at TEXT NOT NULL,
        last_blocked_at  TEXT NOT NULL,
        PRIMARY KEY (sender_id, recipient_id, reason, content_hash)
      );
      CREATE INDEX idx_routing_blocks_recent
        ON routing_blocks(last_blocked_at);
    `);
  },
};
