import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Token-usage tracking tables.
 *
 * `token_usage` — one row per assistant message that returned a usage block.
 *   Source data: each agent's per-session Claude Code JSONL at
 *   data/v2-sessions/<agent_group_id>/.claude-shared/projects/<project>/<session>.jsonl.
 *   The ingest module (src/modules/token-tracking/) tails those files and
 *   appends rows here. Cost is computed at ingest time using a static
 *   pricing table (see pricing.ts) — that means historical rows reflect the
 *   pricing in effect at ingest, not at API call time. Acceptable trade-off
 *   for an estimation surface; for invoice-grade attribution Anthropic's
 *   own usage report is authoritative.
 *
 * `token_ingest_state` — bookkeeping for incremental ingest.
 *   Each JSONL file's last-processed byte offset is kept here so re-runs
 *   only see new lines. file_path is the host-side absolute path.
 */
export const moduleTokenTracking: Migration = {
  version: 15,
  name: 'token-tracking',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE token_usage (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_group_id           TEXT NOT NULL,
        session_id               TEXT,
        message_id               TEXT,
        model                    TEXT NOT NULL,
        input_tokens             INTEGER NOT NULL DEFAULT 0,
        output_tokens            INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens        INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens       INTEGER NOT NULL DEFAULT 0,
        cost_usd                 REAL NOT NULL DEFAULT 0,
        recorded_at              TEXT NOT NULL,
        ingested_at              TEXT NOT NULL,
        UNIQUE(agent_group_id, message_id)
      );
      CREATE INDEX idx_token_usage_agent_time ON token_usage(agent_group_id, recorded_at);
      CREATE INDEX idx_token_usage_recorded   ON token_usage(recorded_at);
      CREATE INDEX idx_token_usage_model      ON token_usage(model, recorded_at);

      CREATE TABLE token_ingest_state (
        file_path     TEXT PRIMARY KEY,
        byte_offset   INTEGER NOT NULL DEFAULT 0,
        rows_ingested INTEGER NOT NULL DEFAULT 0,
        last_run_at   TEXT NOT NULL
      );
    `);
  },
};
