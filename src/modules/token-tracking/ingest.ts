import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { computeCostUsd } from './pricing.js';
import { getIngestState, insertUsageBatch, upsertIngestState, type TokenUsageRow } from './store.js';

/**
 * Path on the host where each agent's Claude Code data lives. The
 * orchestrator mounts `<sessionsRoot>/<agent_group_id>/.claude-shared`
 * into the container as `/home/node/.claude` (read-write). So the JSONL
 * project files end up at:
 *
 *   <sessionsRoot>/<agent_group_id>/.claude-shared/projects/<project>/<session>.jsonl
 *
 * The agent_group_id is encoded right in the path — that's our cost
 * attribution key, no extra mapping needed.
 */
// agent_group_id is the directory immediately above `.claude-shared`. We
// don't anchor on `/v2-sessions/` further up — that lets tests point at any
// temp dir, and lets the orchestrator's sessionsRoot be configurable.
const SESSION_GLOB_RE =
  /\/(?<agentGroupId>[^/]+)\/\.claude-shared\/projects\/[^/]+\/(?<sessionId>[^/]+)\.jsonl$/;

interface JsonlLine {
  timestamp?: string;
  sessionId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function parseAgentGroupId(filePath: string): { agentGroupId: string; sessionIdFromPath: string } | null {
  const m = SESSION_GLOB_RE.exec(filePath);
  if (!m?.groups) return null;
  return { agentGroupId: m.groups.agentGroupId!, sessionIdFromPath: m.groups.sessionId! };
}

/**
 * List every JSONL file the orchestrator can see for this install.
 * Walks the sessions root once; cheap even with hundreds of agents.
 */
export function listJsonlFiles(sessionsRoot: string): string[] {
  if (!fs.existsSync(sessionsRoot)) return [];
  const out: string[] = [];
  for (const agentGroup of fs.readdirSync(sessionsRoot)) {
    const projectsDir = path.join(sessionsRoot, agentGroup, '.claude-shared', 'projects');
    if (!fs.existsSync(projectsDir)) continue;
    for (const proj of fs.readdirSync(projectsDir)) {
      const projDir = path.join(projectsDir, proj);
      let entries: string[];
      try {
        entries = fs.readdirSync(projDir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (f.endsWith('.jsonl')) out.push(path.join(projDir, f));
      }
    }
  }
  return out;
}

/**
 * Parse a single JSONL line into a usage row, or null if the line doesn't
 * contain billable usage (user messages, system messages, tool results,
 * assistant messages without a usage block all skip).
 *
 * `meta` carries the agent + path-derived session info we couldn't get from
 * the line itself.
 */
export function parseLine(
  rawLine: string,
  meta: { agentGroupId: string; sessionIdFromPath: string },
): TokenUsageRow | null {
  let obj: JsonlLine;
  try {
    obj = JSON.parse(rawLine) as JsonlLine;
  } catch {
    return null;
  }
  const usage = obj.message?.usage;
  const model = obj.message?.model;
  if (!usage || !model) return null;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  // Skip empty rows — these happen on tool-only assistant turns where the
  // SDK reports a usage block with all-zero counts.
  if (input + output + cacheRead + cacheWrite === 0) return null;
  return {
    agentGroupId: meta.agentGroupId,
    sessionId: obj.sessionId ?? meta.sessionIdFromPath,
    messageId: obj.message?.id ?? null,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costUsd: computeCostUsd(model, {
      input,
      output,
      cacheRead,
      cacheWrite,
    }),
    recordedAt: obj.timestamp ?? new Date().toISOString(),
  };
}

/**
 * Read a single JSONL from `byteOffset` to EOF, parsing each complete line.
 * Returns the rows plus the new offset (the start of any partial line at
 * the end, so we re-read it next time once the writer flushes the rest).
 */
export function readNewLines(
  filePath: string,
  byteOffset: number,
  meta: { agentGroupId: string; sessionIdFromPath: string },
): { rows: TokenUsageRow[]; newOffset: number } {
  const stat = fs.statSync(filePath);
  if (stat.size === byteOffset) return { rows: [], newOffset: byteOffset };
  // File got truncated/rotated — start over from the top to be safe.
  if (stat.size < byteOffset) byteOffset = 0;

  const fd = fs.openSync(filePath, 'r');
  try {
    const length = stat.size - byteOffset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, byteOffset);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) {
      // No complete line yet; nothing to commit, leave offset where it was.
      return { rows: [], newOffset: byteOffset };
    }
    const complete = text.slice(0, lastNl);
    const newOffset = byteOffset + Buffer.byteLength(complete, 'utf8') + 1; // +1 for the \n
    const rows: TokenUsageRow[] = [];
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      const row = parseLine(line, meta);
      if (row) rows.push(row);
    }
    return { rows, newOffset };
  } finally {
    fs.closeSync(fd);
  }
}

export interface IngestStats {
  filesScanned: number;
  filesWithNewLines: number;
  rowsIngested: number;
  rowsSkippedByDedup: number;
}

/**
 * One-shot ingest cycle. Walks every JSONL under `sessionsRoot`, reads only
 * the new bytes since the last run, parses out usage rows, writes them to
 * `token_usage`, and advances each file's byte offset.
 *
 * Idempotent and crash-safe: a failure mid-batch leaves the offset untouched,
 * so the next run re-reads the same lines and the (agent_group_id, message_id)
 * unique constraint dedupes them.
 */
export function runIngest(sessionsRoot: string, db?: Database.Database): IngestStats {
  const stats: IngestStats = {
    filesScanned: 0,
    filesWithNewLines: 0,
    rowsIngested: 0,
    rowsSkippedByDedup: 0,
  };
  const files = listJsonlFiles(sessionsRoot);
  for (const filePath of files) {
    stats.filesScanned++;
    const meta = parseAgentGroupId(filePath);
    if (!meta) continue;
    const state = getIngestState(filePath, db);
    const offset = state?.byteOffset ?? 0;
    let result;
    try {
      result = readNewLines(filePath, offset, meta);
    } catch (err) {
      log.warn('token-ingest read failed', { filePath, err: String(err) });
      continue;
    }
    if (result.rows.length === 0 && result.newOffset === offset) continue;
    stats.filesWithNewLines++;
    const inserted = insertUsageBatch(result.rows, db);
    stats.rowsIngested += inserted;
    stats.rowsSkippedByDedup += result.rows.length - inserted;
    upsertIngestState(
      {
        filePath,
        byteOffset: result.newOffset,
        rowsIngested: (state?.rowsIngested ?? 0) + inserted,
      },
      db,
    );
  }
  return stats;
}
