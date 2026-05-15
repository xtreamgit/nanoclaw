import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetOverridesCacheForTests } from './config.js';
import { checkAndRecordSend } from './guard.js';
import { contentHash } from './store.js';

/**
 * The guard reads thresholds from config.ts (env vars) and writes counters
 * to the routing_send_log / routing_blocks tables. We swap in a fresh
 * in-memory DB per test and pass it explicitly so we don't touch the real
 * data/v2.db. We also clear the overrides cache so a previously-set
 * GUARD_OVERRIDES from another test can't leak in.
 */

function makeDb(): Database.Database {
  const db = new Database(':memory:');
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
  `);
  return db;
}

describe('checkAndRecordSend', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    delete process.env.GUARD_DISABLED;
    delete process.env.GUARD_OVERRIDES;
    _resetOverridesCacheForTests();
  });

  afterEach(() => {
    db.close();
    delete process.env.GUARD_DISABLED;
    delete process.env.GUARD_OVERRIDES;
    _resetOverridesCacheForTests();
  });

  describe('happy path', () => {
    it('allows the first send', () => {
      const decision = checkAndRecordSend(
        { senderId: 'a', recipientId: 'b', content: 'hello' },
        db,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBeUndefined();
    });

    it('records accepted sends in routing_send_log', () => {
      checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: 'hello' }, db);
      const rows = db
        .prepare(`SELECT sender_id, recipient_id, content_hash FROM routing_send_log`)
        .all() as Array<{ sender_id: string; recipient_id: string; content_hash: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].sender_id).toBe('a');
      expect(rows[0].recipient_id).toBe('b');
      expect(rows[0].content_hash).toBe(contentHash('hello'));
    });

    it('does not write to routing_blocks on accept', () => {
      checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: 'hello' }, db);
      const rows = db.prepare(`SELECT COUNT(*) AS n FROM routing_blocks`).get() as { n: number };
      expect(rows.n).toBe(0);
    });
  });

  describe('dedup guard', () => {
    it('allows up to dedupMaxRepeats identical sends', () => {
      // Default is 3 — first three should pass.
      for (let i = 0; i < 3; i++) {
        const decision = checkAndRecordSend(
          { senderId: 'a', recipientId: 'b', content: 'same' },
          db,
        );
        expect(decision.allowed).toBe(true);
      }
    });

    it('blocks the 4th identical send within the window', () => {
      for (let i = 0; i < 3; i++) {
        checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: 'same' }, db);
      }
      const decision = checkAndRecordSend(
        { senderId: 'a', recipientId: 'b', content: 'same' },
        db,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('dedup');
    });

    it('records blocked sends in routing_blocks with incrementing count', () => {
      for (let i = 0; i < 3; i++) {
        checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: 'same' }, db);
      }
      checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: 'same' }, db);
      checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: 'same' }, db);

      const row = db
        .prepare(
          `SELECT reason, blocked_count FROM routing_blocks
           WHERE sender_id='a' AND recipient_id='b'`,
        )
        .get() as { reason: string; blocked_count: number };
      expect(row.reason).toBe('dedup');
      expect(row.blocked_count).toBe(2);
    });

    it('allows different content from the same pair', () => {
      for (let i = 0; i < 3; i++) {
        checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: 'msg-1' }, db);
      }
      const decision = checkAndRecordSend(
        { senderId: 'a', recipientId: 'b', content: 'msg-2' },
        db,
      );
      expect(decision.allowed).toBe(true);
    });

    it('allows same content to a different recipient', () => {
      for (let i = 0; i < 3; i++) {
        checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: 'same' }, db);
      }
      const decision = checkAndRecordSend(
        { senderId: 'a', recipientId: 'c', content: 'same' },
        db,
      );
      expect(decision.allowed).toBe(true);
    });

    it('treats whitespace-only differences as identical', () => {
      checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: 'hello' }, db);
      checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: '  hello  ' }, db);
      checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: '\nhello\n' }, db);
      const decision = checkAndRecordSend(
        { senderId: 'a', recipientId: 'b', content: 'hello' },
        db,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('dedup');
    });
  });

  describe('rate limit', () => {
    it('allows up to rateLimitPerHour sends with varied content', () => {
      // Default is 60 — every send has a unique body so dedup never fires.
      for (let i = 0; i < 60; i++) {
        const decision = checkAndRecordSend(
          { senderId: 'a', recipientId: 'b', content: `unique-${i}` },
          db,
        );
        expect(decision.allowed).toBe(true);
      }
    });

    it('blocks send #61 with reason rate_limit', () => {
      for (let i = 0; i < 60; i++) {
        checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: `unique-${i}` }, db);
      }
      const decision = checkAndRecordSend(
        { senderId: 'a', recipientId: 'b', content: 'one-more' },
        db,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('rate_limit');
    });

    it('counts only sends within the last hour', () => {
      // Backdate 60 sends to just over an hour ago.
      const oldTimestamp = new Date(Date.now() - 61 * 60 * 1000).toISOString();
      for (let i = 0; i < 60; i++) {
        db.prepare(
          `INSERT INTO routing_send_log (sender_id, recipient_id, content_hash, sent_at) VALUES (?, ?, ?, ?)`,
        ).run('a', 'b', `hash-${i}`, oldTimestamp);
      }
      // Fresh send should now be allowed — old ones don't count.
      const decision = checkAndRecordSend(
        { senderId: 'a', recipientId: 'b', content: 'fresh' },
        db,
      );
      expect(decision.allowed).toBe(true);
    });
  });

  describe('reproduces the May 10 incident pattern', () => {
    it('caps an identical-error bounce loop within 5 sends', () => {
      // The runaway sent the same error message ~6,000 times. With dedup at 3,
      // the 4th send blocks; subsequent attempts add to the blocked count
      // without ever reaching the recipient.
      const errorContent =
        '{"text":"Error: Claude Code native binary not found at /pnpm/bin/claude. Please ensure..."}';
      const accepted: boolean[] = [];
      for (let i = 0; i < 100; i++) {
        const decision = checkAndRecordSend(
          { senderId: 'saul', recipientId: 'jean-luc', content: errorContent },
          db,
        );
        accepted.push(decision.allowed);
      }
      const acceptedCount = accepted.filter(Boolean).length;
      expect(acceptedCount).toBe(3);

      const block = db
        .prepare(
          `SELECT reason, blocked_count FROM routing_blocks
           WHERE sender_id='saul' AND recipient_id='jean-luc'`,
        )
        .get() as { reason: string; blocked_count: number };
      expect(block.reason).toBe('dedup');
      expect(block.blocked_count).toBe(97);
    });
  });

  describe('config overrides', () => {
    it('honors per-pair rate limit override', () => {
      process.env.GUARD_OVERRIDES = JSON.stringify({
        'a:b': { rateLimitPerHour: 5 },
      });
      _resetOverridesCacheForTests();

      for (let i = 0; i < 5; i++) {
        const decision = checkAndRecordSend(
          { senderId: 'a', recipientId: 'b', content: `unique-${i}` },
          db,
        );
        expect(decision.allowed).toBe(true);
      }
      const decision = checkAndRecordSend(
        { senderId: 'a', recipientId: 'b', content: 'one-more' },
        db,
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('rate_limit');
    });

    it('does not apply override to other pairs', () => {
      process.env.GUARD_OVERRIDES = JSON.stringify({
        'a:b': { rateLimitPerHour: 5 },
      });
      _resetOverridesCacheForTests();

      for (let i = 0; i < 5; i++) {
        checkAndRecordSend({ senderId: 'a', recipientId: 'b', content: `x-${i}` }, db);
      }
      // Different recipient — uses default 60.
      const decision = checkAndRecordSend(
        { senderId: 'a', recipientId: 'c', content: 'fresh' },
        db,
      );
      expect(decision.allowed).toBe(true);
    });
  });

  describe('GUARD_DISABLED short-circuit', () => {
    it('allows sends without recording when env var is set', () => {
      process.env.GUARD_DISABLED = '1';
      for (let i = 0; i < 200; i++) {
        const decision = checkAndRecordSend(
          { senderId: 'a', recipientId: 'b', content: 'same' },
          db,
        );
        expect(decision.allowed).toBe(true);
      }
      const sendRows = db.prepare(`SELECT COUNT(*) AS n FROM routing_send_log`).get() as { n: number };
      const blockRows = db.prepare(`SELECT COUNT(*) AS n FROM routing_blocks`).get() as { n: number };
      expect(sendRows.n).toBe(0);
      expect(blockRows.n).toBe(0);
    });
  });
});
