import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';

export interface TokenUsageRow {
  agentGroupId: string;
  sessionId: string | null;
  messageId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  recordedAt: string;
}

export interface IngestState {
  filePath: string;
  byteOffset: number;
  rowsIngested: number;
}

/**
 * Insert a batch of usage rows in one transaction. The unique constraint on
 * (agent_group_id, message_id) absorbs duplicates that arise when an ingest
 * run overlaps a partial line we already saw last time — we'd rather ignore
 * the dup than crash mid-batch.
 */
export function insertUsageBatch(rows: TokenUsageRow[], db: Database.Database = getDb()): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO token_usage
       (agent_group_id, session_id, message_id, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, recorded_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  let inserted = 0;
  const txn = db.transaction((batch: TokenUsageRow[]) => {
    for (const r of batch) {
      const result = stmt.run(
        r.agentGroupId,
        r.sessionId,
        r.messageId,
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.costUsd,
        r.recordedAt,
        now,
      );
      if (result.changes > 0) inserted++;
    }
  });
  txn(rows);
  return inserted;
}

export function getIngestState(filePath: string, db: Database.Database = getDb()): IngestState | null {
  const row = db
    .prepare(`SELECT file_path, byte_offset, rows_ingested FROM token_ingest_state WHERE file_path = ?`)
    .get(filePath) as { file_path: string; byte_offset: number; rows_ingested: number } | undefined;
  if (!row) return null;
  return { filePath: row.file_path, byteOffset: row.byte_offset, rowsIngested: row.rows_ingested };
}

export function upsertIngestState(state: IngestState, db: Database.Database = getDb()): void {
  db.prepare(
    `INSERT INTO token_ingest_state (file_path, byte_offset, rows_ingested, last_run_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       byte_offset   = excluded.byte_offset,
       rows_ingested = excluded.rows_ingested,
       last_run_at   = excluded.last_run_at`,
  ).run(state.filePath, state.byteOffset, state.rowsIngested, new Date().toISOString());
}
