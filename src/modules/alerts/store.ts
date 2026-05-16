import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';

export type TriggerType = 'cost_spike' | 'routing_burst' | 'agent_regression';

export interface AlertRecord {
  triggerType: TriggerType;
  pairKey: string;
  payload: Record<string, unknown>;
}

/**
 * Has a (trigger, pair) fired within `cooldownMs`? If so, the daemon
 * should suppress this round's alert rather than dispatching again.
 *
 * "Most recent" lookup against the (trigger_type, pair_key, fired_at DESC)
 * index — O(log n) regardless of history size.
 */
export function isInCooldown(
  triggerType: TriggerType,
  pairKey: string,
  cooldownMs: number,
  db: Database.Database = getDb(),
): boolean {
  const cutoff = new Date(Date.now() - cooldownMs).toISOString();
  const row = db
    .prepare(
      `SELECT fired_at FROM alert_history
       WHERE trigger_type = ? AND pair_key = ? AND fired_at >= ?
       ORDER BY fired_at DESC LIMIT 1`,
    )
    .get(triggerType, pairKey, cutoff) as { fired_at: string } | undefined;
  return !!row;
}

/** Record that an alert fired. delivered/error captured by the dispatcher. */
export function recordAlert(
  record: AlertRecord,
  delivery: { delivered: boolean; error?: string },
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `INSERT OR REPLACE INTO alert_history
       (trigger_type, pair_key, fired_at, payload, delivered, delivery_error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    record.triggerType,
    record.pairKey,
    new Date().toISOString(),
    JSON.stringify(record.payload),
    delivery.delivered ? 1 : 0,
    delivery.error ?? null,
  );
}
