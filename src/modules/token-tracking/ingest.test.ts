import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listJsonlFiles, parseLine, readNewLines, runIngest } from './ingest.js';
import { computeCostUsd, priceFor } from './pricing.js';

/**
 * The ingest module touches the real filesystem (Claude Code JSONL) and a
 * real sqlite DB. Per test we materialize a tiny fake-sessions tree under
 * a temp dir and pass an in-memory DB. We deliberately avoid mocking
 * `fs` — the path-walking + offset bookkeeping are exactly the parts a
 * mock would obscure.
 */

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_group_id     TEXT NOT NULL,
      session_id         TEXT,
      message_id         TEXT,
      model              TEXT NOT NULL,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd           REAL NOT NULL DEFAULT 0,
      recorded_at        TEXT NOT NULL,
      ingested_at        TEXT NOT NULL,
      UNIQUE(agent_group_id, message_id)
    );
    CREATE TABLE token_ingest_state (
      file_path     TEXT PRIMARY KEY,
      byte_offset   INTEGER NOT NULL DEFAULT 0,
      rows_ingested INTEGER NOT NULL DEFAULT 0,
      last_run_at   TEXT NOT NULL
    );
  `);
  return db;
}

function makeJsonlFile(
  root: string,
  agentGroupId: string,
  project: string,
  sessionId: string,
  lines: string[],
): string {
  const dir = path.join(root, agentGroupId, '.claude-shared', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
  return file;
}

const ASSISTANT_LINE = (overrides: Partial<{
  msgId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  ts: string;
}> = {}) =>
  JSON.stringify({
    timestamp: overrides.ts ?? '2026-05-15T16:00:00.000Z',
    sessionId: 'sess-test',
    message: {
      id: overrides.msgId ?? 'msg-test-1',
      model: overrides.model ?? 'claude-sonnet-4-6',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      usage: {
        input_tokens: overrides.input ?? 1000,
        output_tokens: overrides.output ?? 500,
        cache_read_input_tokens: overrides.cacheRead ?? 0,
        cache_creation_input_tokens: overrides.cacheWrite ?? 0,
      },
    },
  });

describe('parseLine', () => {
  const meta = { agentGroupId: 'ag-1', sessionIdFromPath: 'sess-x' };

  it('extracts a usage row from an assistant message', () => {
    const row = parseLine(ASSISTANT_LINE({ input: 2000, output: 1000 }), meta);
    expect(row).not.toBeNull();
    expect(row!.agentGroupId).toBe('ag-1');
    expect(row!.model).toBe('claude-sonnet-4-6');
    expect(row!.inputTokens).toBe(2000);
    expect(row!.outputTokens).toBe(1000);
    // 2000 * $3/Mtok + 1000 * $15/Mtok = $0.006 + $0.015 = $0.021
    expect(row!.costUsd).toBeCloseTo(0.021, 6);
  });

  it('returns null for a user message', () => {
    const userLine = JSON.stringify({
      timestamp: '2026-05-15T16:00:00.000Z',
      type: 'user',
      message: { content: 'hi' },
    });
    expect(parseLine(userLine, meta)).toBeNull();
  });

  it('returns null for an assistant message without usage', () => {
    const noUsage = JSON.stringify({
      timestamp: '2026-05-15T16:00:00.000Z',
      message: { id: 'm', model: 'claude-sonnet-4-6' },
    });
    expect(parseLine(noUsage, meta)).toBeNull();
  });

  it('returns null for usage with all-zero counts', () => {
    const zero = ASSISTANT_LINE({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(parseLine(zero, meta)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseLine('{not json', meta)).toBeNull();
  });

  it('falls back to path-derived session when JSONL line lacks one', () => {
    const noSession = JSON.stringify({
      timestamp: '2026-05-15T16:00:00.000Z',
      message: {
        id: 'm-1',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 100 },
      },
    });
    const row = parseLine(noSession, meta);
    expect(row?.sessionId).toBe('sess-x');
  });
});

describe('listJsonlFiles', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-ingest-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds JSONLs across multiple agents and projects', () => {
    makeJsonlFile(tmp, 'ag-1', '-workspace-agent', 'sess-1', [ASSISTANT_LINE()]);
    makeJsonlFile(tmp, 'ag-2', '-workspace-agent', 'sess-2', [ASSISTANT_LINE()]);
    makeJsonlFile(tmp, 'ag-2', '-other-project', 'sess-3', [ASSISTANT_LINE()]);
    const found = listJsonlFiles(tmp);
    expect(found).toHaveLength(3);
  });

  it('returns empty when sessions root does not exist', () => {
    expect(listJsonlFiles('/nonexistent/path')).toEqual([]);
  });

  it('skips agent dirs without a .claude-shared/projects layout', () => {
    fs.mkdirSync(path.join(tmp, 'ag-1', 'something-else'), { recursive: true });
    expect(listJsonlFiles(tmp)).toEqual([]);
  });
});

describe('readNewLines', () => {
  let tmp: string;
  const meta = { agentGroupId: 'ag-1', sessionIdFromPath: 'sess-x' };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-readlines-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the whole file from offset 0', () => {
    const file = makeJsonlFile(tmp, 'ag-1', '-p', 'sess', [
      ASSISTANT_LINE({ msgId: 'm-1' }),
      ASSISTANT_LINE({ msgId: 'm-2' }),
    ]);
    const result = readNewLines(file, 0, meta);
    expect(result.rows).toHaveLength(2);
    expect(result.newOffset).toBe(fs.statSync(file).size);
  });

  it('reads only new lines on second pass', () => {
    const file = makeJsonlFile(tmp, 'ag-1', '-p', 'sess', [ASSISTANT_LINE({ msgId: 'm-1' })]);
    const first = readNewLines(file, 0, meta);
    expect(first.rows).toHaveLength(1);
    fs.appendFileSync(file, ASSISTANT_LINE({ msgId: 'm-2' }) + '\n');
    const second = readNewLines(file, first.newOffset, meta);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].messageId).toBe('m-2');
  });

  it('leaves a partial trailing line for the next pass', () => {
    const file = makeJsonlFile(tmp, 'ag-1', '-p', 'sess', []);
    fs.writeFileSync(file, ASSISTANT_LINE({ msgId: 'm-1' }) + '\n' + '{partial-no-newline');
    const result = readNewLines(file, 0, meta);
    expect(result.rows).toHaveLength(1);
    // newOffset should land right after the \n of the complete line, NOT
    // include the partial bytes — so the partial gets retried next time.
    expect(result.newOffset).toBeLessThan(fs.statSync(file).size);
  });

  it('handles file truncation by restarting from offset 0', () => {
    const file = makeJsonlFile(tmp, 'ag-1', '-p', 'sess', [
      ASSISTANT_LINE({ msgId: 'm-1' }),
      ASSISTANT_LINE({ msgId: 'm-2' }),
    ]);
    const sizeBefore = fs.statSync(file).size;
    fs.writeFileSync(file, ASSISTANT_LINE({ msgId: 'm-fresh' }) + '\n');
    const result = readNewLines(file, sizeBefore, meta);
    // sizeBefore was past the new file's end → reset to 0 → read everything.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].messageId).toBe('m-fresh');
  });
});

describe('runIngest', () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-ingest-run-'));
    db = makeDb();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  it('end-to-end: ingest, second run with new lines, attribution', () => {
    makeJsonlFile(tmp, 'ag-saul', '-workspace-agent', 'sess-1', [
      ASSISTANT_LINE({ msgId: 'm-1', input: 1000, output: 500 }),
      ASSISTANT_LINE({ msgId: 'm-2', input: 2000, output: 1000 }),
    ]);
    makeJsonlFile(tmp, 'ag-mara', '-workspace-agent', 'sess-2', [
      ASSISTANT_LINE({ msgId: 'm-3', input: 500, output: 250 }),
    ]);

    const stats1 = runIngest(tmp, db);
    expect(stats1.rowsIngested).toBe(3);

    const totals = db
      .prepare(
        `SELECT agent_group_id, SUM(input_tokens) AS i, SUM(output_tokens) AS o, ROUND(SUM(cost_usd), 6) AS c
         FROM token_usage GROUP BY agent_group_id ORDER BY agent_group_id`,
      )
      .all() as Array<{ agent_group_id: string; i: number; o: number; c: number }>;
    expect(totals).toHaveLength(2);
    expect(totals[0].agent_group_id).toBe('ag-mara');
    expect(totals[0].i).toBe(500);
    expect(totals[1].agent_group_id).toBe('ag-saul');
    expect(totals[1].i).toBe(3000);

    // Append a new line to one file; second run should pick up only the delta.
    const saulFile = path.join(
      tmp, 'ag-saul', '.claude-shared', 'projects', '-workspace-agent', 'sess-1.jsonl',
    );
    fs.appendFileSync(saulFile, ASSISTANT_LINE({ msgId: 'm-4', input: 100, output: 100 }) + '\n');

    const stats2 = runIngest(tmp, db);
    expect(stats2.rowsIngested).toBe(1);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM token_usage`).get() as { n: number };
    expect(total.n).toBe(4);
  });

  it('handles re-runs idempotently (unique constraint dedupes)', () => {
    makeJsonlFile(tmp, 'ag-1', '-workspace-agent', 'sess', [ASSISTANT_LINE({ msgId: 'm-1' })]);
    runIngest(tmp, db);
    // Wipe the offset state to simulate a corruption recovery, then re-run.
    db.prepare(`DELETE FROM token_ingest_state`).run();
    const stats = runIngest(tmp, db);
    expect(stats.rowsSkippedByDedup).toBe(1);
    expect(stats.rowsIngested).toBe(0);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM token_usage`).get() as { n: number };
    expect(total.n).toBe(1);
  });
});

describe('pricing', () => {
  it('uses Sonnet 4.6 as the canonical model', () => {
    const p = priceFor('claude-sonnet-4-6');
    expect(p.inputPerMtok).toBe(3.0);
    expect(p.outputPerMtok).toBe(15.0);
  });

  it('strips date suffixes and matches the family', () => {
    const p = priceFor('claude-sonnet-4-6-20260315');
    expect(p.inputPerMtok).toBe(3.0);
  });

  it('falls back to Sonnet rate for unknown models (conservative)', () => {
    const p = priceFor('claude-future-99-1');
    expect(p.inputPerMtok).toBe(3.0);
  });

  it('computes cost correctly with cache tokens', () => {
    // Sonnet: 1000 input * $3 + 500 output * $15 + 10000 cache_read * $0.30 +
    //         2000 cache_write * $3.75   (all per Mtok)
    //       = 0.003 + 0.0075 + 0.003 + 0.0075 = 0.021
    const cost = computeCostUsd('claude-sonnet-4-6', {
      input: 1000,
      output: 500,
      cacheRead: 10000,
      cacheWrite: 2000,
    });
    expect(cost).toBeCloseTo(0.021, 6);
  });
});
