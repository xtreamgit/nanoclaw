import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import type { AlertThresholds } from './config.js';
import type { AlertRecord } from './store.js';

/**
 * Returns the (zero or more) alerts that *should* fire right now, given
 * the current contents of token_usage, routing_blocks, and the orchestrator
 * log. Cooldown / dispatch is the caller's job — these are pure read-only
 * threshold checks.
 *
 * Defensive against missing tables (routing_blocks may be absent on an
 * un-upgraded install) — silently returns no alerts in that case.
 */
export function evaluate(thresholds: AlertThresholds, db: Database.Database = getDb()): AlertRecord[] {
  const out: AlertRecord[] = [];
  out.push(...checkCostSpike(thresholds, db));
  out.push(...checkRoutingBurst(thresholds, db));
  out.push(...checkAgentRegression(thresholds, db));
  return out;
}

/**
 * Day-to-date cost across all agents vs the daily cap. Day boundary is
 * "since midnight UTC" — simple, no DST surprises, and the cap is a
 * coarse signal so granular timezone alignment doesn't matter.
 */
export function checkCostSpike(thresholds: AlertThresholds, db: Database.Database = getDb()): AlertRecord[] {
  if (!hasTable(db, 'token_usage')) return [];
  const since = startOfUtcDayIso();
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM token_usage WHERE recorded_at >= ?`)
    .get(since) as { spend: number };
  if (row.spend < thresholds.costCapUsdDaily) return [];
  return [
    {
      triggerType: 'cost_spike',
      pairKey: '__global__',
      payload: {
        windowStart: since,
        spendUsd: round2(row.spend),
        capUsd: thresholds.costCapUsdDaily,
      },
    },
  ];
}

/**
 * Per-(sender,recipient) routing block count inside the burst window.
 * One alert per pair that crosses threshold — multiple pairs in one
 * sweep get multiple alerts.
 */
export function checkRoutingBurst(thresholds: AlertThresholds, db: Database.Database = getDb()): AlertRecord[] {
  if (!hasTable(db, 'routing_blocks')) return [];
  const since = new Date(Date.now() - thresholds.routingBurstWindowMs).toISOString();
  const rows = db
    .prepare(
      `SELECT
         rb.sender_id, rb.recipient_id,
         COALESCE(s.name, rb.sender_id)    AS sender_name,
         COALESCE(r.name, rb.recipient_id) AS recipient_name,
         SUM(rb.blocked_count) AS total
       FROM routing_blocks rb
       LEFT JOIN agent_groups s ON s.id = rb.sender_id
       LEFT JOIN agent_groups r ON r.id = rb.recipient_id
       WHERE rb.last_blocked_at >= ?
       GROUP BY rb.sender_id, rb.recipient_id`,
    )
    .all(since) as Array<{
    sender_id: string;
    recipient_id: string;
    sender_name: string;
    recipient_name: string;
    total: number;
  }>;
  return rows
    .filter((r) => r.total >= thresholds.routingBurstThreshold)
    .map((r) => ({
      triggerType: 'routing_burst' as const,
      pairKey: `${r.sender_id}:${r.recipient_id}`,
      payload: {
        windowStart: since,
        sender: r.sender_name,
        recipient: r.recipient_name,
        blockedCount: r.total,
        threshold: thresholds.routingBurstThreshold,
      },
    }));
}

/**
 * Agent regression: an agent that recently was active (≥ minRecent spawns
 * in the recent window) has gone silent for silentHours. Uses the orchestrator's
 * spawn log via session start_at — sessions table tracks the last activation.
 *
 * Only checks agents with at least one historical spawn. Brand-new agents that
 * have never run can't "regress" by this definition.
 */
export function checkAgentRegression(thresholds: AlertThresholds, db: Database.Database = getDb()): AlertRecord[] {
  if (!hasTable(db, 'sessions')) return [];
  const recentCutoff = new Date(Date.now() - thresholds.agentRegressionRecentDays * 24 * 60 * 60 * 1000).toISOString();
  const silenceCutoff = new Date(Date.now() - thresholds.agentRegressionSilentHours * 60 * 60 * 1000).toISOString();

  // sessions.last_active is the most-recent activation timestamp per session.
  // We aggregate per agent: total recent activations (sessions touched inside
  // the window) and the absolute most-recent activation. An agent is "regressed"
  // if the recent count is high but the absolute most-recent is silent. Single
  // grouped scan, no subquery needed.
  const rows = db
    .prepare(
      `SELECT
         s.agent_group_id,
         COALESCE(g.name, s.agent_group_id) AS name,
         MAX(s.last_active) AS last_active,
         SUM(CASE WHEN s.last_active >= ? THEN 1 ELSE 0 END) AS recent_spawns
       FROM sessions s
       LEFT JOIN agent_groups g ON g.id = s.agent_group_id
       GROUP BY s.agent_group_id`,
    )
    .all(recentCutoff) as Array<{
    agent_group_id: string;
    name: string;
    last_active: string | null;
    recent_spawns: number;
  }>;

  return rows
    .filter(
      (r) =>
        r.recent_spawns >= thresholds.agentRegressionMinRecent &&
        r.last_active !== null &&
        r.last_active < silenceCutoff,
    )
    .map((r) => ({
      triggerType: 'agent_regression' as const,
      pairKey: r.agent_group_id,
      payload: {
        agent: r.name,
        recentSpawns: r.recent_spawns,
        lastActive: r.last_active,
        silenceThresholdHours: thresholds.agentRegressionSilentHours,
        recentWindowDays: thresholds.agentRegressionRecentDays,
      },
    }));
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name) as
    | { name: string }
    | undefined;
  return !!row;
}

function startOfUtcDayIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
