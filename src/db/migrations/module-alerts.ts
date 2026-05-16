import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Alert history — cooldown ledger for the routing-guard / token-tracking
 * alert daemon (src/modules/alerts/).
 *
 * One row per (trigger_type, pair_key) per fire. Cooldown logic asks:
 * "what's the most recent fire for this (type, pair)?" — if it's inside
 * the cooldown window, suppress; otherwise insert and dispatch.
 *
 * pair_key examples:
 *   - 'cost_spike'         → '__global__'             (one global cap)
 *   - 'routing_burst'      → '<sender>:<recipient>'   (per pair)
 *   - 'agent_regression'   → '<agent_id>'             (per agent)
 *
 * payload is freeform JSON describing the trigger snapshot — what
 * threshold was crossed, what the actual number was, etc. Useful for
 * the alert message body and for post-hoc debugging of false positives.
 */
export const moduleAlerts: Migration = {
  version: 16,
  name: 'alerts',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE alert_history (
        trigger_type    TEXT NOT NULL,
        pair_key        TEXT NOT NULL,
        fired_at        TEXT NOT NULL,
        payload         TEXT,
        delivered       INTEGER NOT NULL DEFAULT 0,
        delivery_error  TEXT,
        PRIMARY KEY (trigger_type, pair_key, fired_at)
      );
      CREATE INDEX idx_alert_history_recent ON alert_history(fired_at);
      CREATE INDEX idx_alert_history_type_pair ON alert_history(trigger_type, pair_key, fired_at DESC);
    `);
  },
};
