import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_THRESHOLDS } from './config.js';
import { checkAgentRegression, checkCostSpike, checkRoutingBurst, evaluate } from './checks.js';
import { formatMessage } from './dispatcher.js';
import { isInCooldown, recordAlert } from './store.js';

/**
 * Alert checks read from three tables that may or may not exist on an
 * un-upgraded install: token_usage, routing_blocks, sessions. Per-test
 * we materialize an in-memory DB with the schema the check needs and
 * pass it explicitly, so we never touch the real data/v2.db.
 */

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_group_id TEXT NOT NULL, session_id TEXT, message_id TEXT, model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0, recorded_at TEXT NOT NULL, ingested_at TEXT NOT NULL);
    CREATE TABLE routing_blocks (
      sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, reason TEXT NOT NULL,
      content_hash TEXT NOT NULL, blocked_count INTEGER DEFAULT 1,
      first_blocked_at TEXT NOT NULL, last_blocked_at TEXT NOT NULL,
      PRIMARY KEY (sender_id, recipient_id, reason, content_hash));
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, created_at TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL,
      messaging_group_id TEXT, thread_id TEXT, agent_provider TEXT,
      status TEXT, container_status TEXT, last_active TEXT, created_at TEXT NOT NULL);
    CREATE TABLE alert_history (
      trigger_type TEXT NOT NULL, pair_key TEXT NOT NULL,
      fired_at TEXT NOT NULL, payload TEXT,
      delivered INTEGER DEFAULT 0, delivery_error TEXT,
      PRIMARY KEY (trigger_type, pair_key, fired_at));
  `);
  return db;
}

const now = (): string => new Date().toISOString();
const hoursAgo = (h: number): string => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60 * 1000).toISOString();

describe('checkCostSpike', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('returns nothing when day-to-date spend is under the cap', () => {
    db.prepare(
      `INSERT INTO token_usage (agent_group_id, model, cost_usd, recorded_at, ingested_at) VALUES (?,?,?,?,?)`,
    ).run('ag-1', 'sonnet', 49.99, now(), now());
    expect(checkCostSpike(DEFAULT_THRESHOLDS, db)).toHaveLength(0);
  });

  it('fires when day-to-date spend exceeds the cap', () => {
    db.prepare(
      `INSERT INTO token_usage (agent_group_id, model, cost_usd, recorded_at, ingested_at) VALUES (?,?,?,?,?)`,
    ).run('ag-1', 'sonnet', 50.01, now(), now());
    const alerts = checkCostSpike(DEFAULT_THRESHOLDS, db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].triggerType).toBe('cost_spike');
    expect(alerts[0].pairKey).toBe('__global__');
    expect(alerts[0].payload.spendUsd).toBeCloseTo(50.01, 2);
  });

  it('ignores spend from yesterday', () => {
    db.prepare(
      `INSERT INTO token_usage (agent_group_id, model, cost_usd, recorded_at, ingested_at) VALUES (?,?,?,?,?)`,
    ).run('ag-1', 'sonnet', 200, hoursAgo(30), now());
    expect(checkCostSpike(DEFAULT_THRESHOLDS, db)).toHaveLength(0);
  });

  it('sums across multiple agents', () => {
    const stmt = db.prepare(
      `INSERT INTO token_usage (agent_group_id, model, cost_usd, recorded_at, ingested_at) VALUES (?,?,?,?,?)`,
    );
    stmt.run('ag-1', 'sonnet', 30, now(), now());
    stmt.run('ag-2', 'sonnet', 25, now(), now());
    const alerts = checkCostSpike(DEFAULT_THRESHOLDS, db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload.spendUsd).toBe(55);
  });
});

describe('checkRoutingBurst', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  function block(sender: string, recipient: string, count: number, lastAtIso: string): void {
    db.prepare(
      `INSERT INTO routing_blocks
         (sender_id, recipient_id, reason, content_hash, blocked_count,
          first_blocked_at, last_blocked_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(sender, recipient, 'dedup', `h-${Math.random()}`, count, lastAtIso, lastAtIso);
  }

  it('returns nothing when no pairs cross the burst threshold', () => {
    block('a', 'b', 4, minutesAgo(1)); // 4 < 5
    expect(checkRoutingBurst(DEFAULT_THRESHOLDS, db)).toHaveLength(0);
  });

  it('fires when a single pair crosses the burst threshold inside the window', () => {
    block('saul', 'jean-luc', 6, minutesAgo(1));
    const alerts = checkRoutingBurst(DEFAULT_THRESHOLDS, db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].triggerType).toBe('routing_burst');
    expect(alerts[0].pairKey).toBe('saul:jean-luc');
    expect(alerts[0].payload.blockedCount).toBe(6);
  });

  it('aggregates multiple block reasons for the same pair', () => {
    block('a', 'b', 3, minutesAgo(1));
    // Same pair, different reason → still counts toward burst.
    db.prepare(
      `INSERT INTO routing_blocks (sender_id, recipient_id, reason, content_hash,
        blocked_count, first_blocked_at, last_blocked_at) VALUES (?,?,?,?,?,?,?)`,
    ).run('a', 'b', 'rate_limit', 'h-x', 3, minutesAgo(1), minutesAgo(1));
    const alerts = checkRoutingBurst(DEFAULT_THRESHOLDS, db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload.blockedCount).toBe(6);
  });

  it('emits one alert per pair when multiple pairs burst', () => {
    block('a', 'b', 10, minutesAgo(1));
    block('c', 'd', 10, minutesAgo(1));
    const alerts = checkRoutingBurst(DEFAULT_THRESHOLDS, db);
    expect(alerts).toHaveLength(2);
  });

  it('ignores blocks older than the burst window', () => {
    block('a', 'b', 100, minutesAgo(10)); // outside 5-minute window
    expect(checkRoutingBurst(DEFAULT_THRESHOLDS, db)).toHaveLength(0);
  });

  it('resolves agent_groups names when available', () => {
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?,?,?,?)`).run(
      'ag-saul',
      'Saul',
      'saul',
      now(),
    );
    block('ag-saul', 'ag-jl', 6, minutesAgo(1));
    const alerts = checkRoutingBurst(DEFAULT_THRESHOLDS, db);
    expect(alerts[0].payload.sender).toBe('Saul');
    expect(alerts[0].payload.recipient).toBe('ag-jl'); // no name row → falls back to id
  });
});

describe('checkAgentRegression', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    // Seed two agent_groups rows for friendlier output in alert payloads.
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?,?,?,?)`).run(
      'ag-active',
      'Active Agent',
      'active',
      now(),
    );
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?,?,?,?)`).run(
      'ag-regressed',
      'Regressed Agent',
      'regressed',
      now(),
    );
  });
  afterEach(() => db.close());

  function session(id: string, agent: string, lastActive: string): void {
    db.prepare(`INSERT INTO sessions (id, agent_group_id, last_active, created_at) VALUES (?,?,?,?)`).run(
      id,
      agent,
      lastActive,
      now(),
    );
  }

  it('returns nothing for agents that have spawned recently', () => {
    session('s-1', 'ag-active', hoursAgo(1));
    session('s-2', 'ag-active', hoursAgo(2));
    session('s-3', 'ag-active', hoursAgo(3));
    expect(checkAgentRegression(DEFAULT_THRESHOLDS, db)).toHaveLength(0);
  });

  it('fires when previously-active agent has been silent past threshold', () => {
    // 3 spawns inside the recent window, but most recent is 30h ago → silent.
    session('s-1', 'ag-regressed', hoursAgo(30));
    session('s-2', 'ag-regressed', hoursAgo(48));
    session('s-3', 'ag-regressed', hoursAgo(96));
    const alerts = checkAgentRegression(DEFAULT_THRESHOLDS, db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].triggerType).toBe('agent_regression');
    expect(alerts[0].pairKey).toBe('ag-regressed');
    expect(alerts[0].payload.agent).toBe('Regressed Agent');
  });

  it('does not flag agents with fewer than minRecent spawns', () => {
    // Only 2 recent spawns — below the default min of 3.
    session('s-1', 'ag-regressed', hoursAgo(30));
    session('s-2', 'ag-regressed', hoursAgo(48));
    expect(checkAgentRegression(DEFAULT_THRESHOLDS, db)).toHaveLength(0);
  });

  it('does not flag agents that have never been active', () => {
    // No session rows for this agent at all.
    expect(checkAgentRegression(DEFAULT_THRESHOLDS, db)).toHaveLength(0);
  });
});

describe('evaluate (composition)', () => {
  it('aggregates results from all three checks', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO token_usage (agent_group_id, model, cost_usd, recorded_at, ingested_at) VALUES (?,?,?,?,?)`,
    ).run('ag-1', 'sonnet', 99, now(), now());
    db.prepare(
      `INSERT INTO routing_blocks
         (sender_id, recipient_id, reason, content_hash, blocked_count, first_blocked_at, last_blocked_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('a', 'b', 'dedup', 'h', 10, minutesAgo(1), minutesAgo(1));
    const out = evaluate(DEFAULT_THRESHOLDS, db);
    expect(out.map((a) => a.triggerType).sort()).toEqual(['cost_spike', 'routing_burst']);
    db.close();
  });

  it('degrades silently if expected tables are missing', () => {
    const bare = new Database(':memory:');
    // No tables at all → checks should each short-circuit, not throw.
    expect(() => evaluate(DEFAULT_THRESHOLDS, bare)).not.toThrow();
    bare.close();
  });
});

describe('cooldown', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('returns true within the cooldown window', () => {
    recordAlert({ triggerType: 'cost_spike', pairKey: '__global__', payload: {} }, { delivered: true }, db);
    expect(isInCooldown('cost_spike', '__global__', 60 * 60 * 1000, db)).toBe(true);
  });

  it('returns false after the cooldown window', () => {
    db.prepare(
      `INSERT INTO alert_history (trigger_type, pair_key, fired_at, payload, delivered)
       VALUES (?,?,?,?,?)`,
    ).run('cost_spike', '__global__', hoursAgo(2), '{}', 1);
    expect(isInCooldown('cost_spike', '__global__', 60 * 60 * 1000, db)).toBe(false);
  });

  it('per-pair cooldown does not affect other pairs', () => {
    recordAlert({ triggerType: 'routing_burst', pairKey: 'a:b', payload: {} }, { delivered: true }, db);
    expect(isInCooldown('routing_burst', 'a:b', 60 * 60 * 1000, db)).toBe(true);
    expect(isInCooldown('routing_burst', 'c:d', 60 * 60 * 1000, db)).toBe(false);
  });
});

describe('formatMessage', () => {
  it('renders cost_spike with spend + cap', () => {
    const msg = formatMessage({
      triggerType: 'cost_spike',
      pairKey: '__global__',
      payload: { spendUsd: 73.42, capUsd: 50, windowStart: '2026-05-16T00:00:00Z' },
    });
    expect(msg).toContain('Cost cap exceeded');
    expect(msg).toContain('$73.42');
    expect(msg).toContain('$50');
  });

  it('renders routing_burst with the involved pair', () => {
    const msg = formatMessage({
      triggerType: 'routing_burst',
      pairKey: 'saul:jean-luc',
      payload: {
        sender: 'Saul',
        recipient: 'Jean Luc',
        blockedCount: 12,
        threshold: 5,
        windowStart: '2026-05-16T00:00:00Z',
      },
    });
    expect(msg).toContain('Routing-guard burst');
    expect(msg).toContain('Saul');
    expect(msg).toContain('Jean Luc');
    expect(msg).toContain('12');
  });

  it('renders agent_regression with timing info', () => {
    const msg = formatMessage({
      triggerType: 'agent_regression',
      pairKey: 'ag-mara',
      payload: {
        agent: 'Mara',
        recentSpawns: 8,
        recentWindowDays: 7,
        lastActive: '2026-05-14T12:00:00Z',
        silenceThresholdHours: 24,
      },
    });
    expect(msg).toContain('Agent regression');
    expect(msg).toContain('Mara');
    expect(msg).toContain('8');
  });
});
