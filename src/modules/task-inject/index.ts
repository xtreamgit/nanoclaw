/**
 * External task injection endpoint.
 *
 * Allows trusted external systems (e.g. Google ADK RAG agents) to dispatch
 * tasks directly into a NanoClaw agent session over HTTP without going through
 * a channel adapter.
 *
 * Configuration (.env):
 *   TASK_INJECT_SECRET=<shared secret>   required — requests without this are rejected
 *   TASK_INJECT_PORT=3001                optional — default 3001
 *
 * Request:
 *   POST /task-inject
 *   X-Task-Secret: <secret>
 *   Content-Type: application/json
 *   { "group": "dm-with-saul", "prompt": "...", "process_after": "2026-06-18T14:00:00Z" }
 *
 * Response 200:
 *   { "taskId": "injected-...", "session": "sess-..." }
 *
 * Only binds to 127.0.0.1 — must be exposed via a tunnel (Cloudflare, Tailscale,
 * etc.) to reach from external networks.
 */
import http from 'http';

import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const env = readEnvFile(['TASK_INJECT_SECRET', 'TASK_INJECT_PORT', 'TASK_INJECT_HOST']);
const PORT = parseInt(env.TASK_INJECT_PORT ?? '3001', 10);
const SECRET = env.TASK_INJECT_SECRET ?? '';

function generateTaskId(): string {
  return `injected-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface InjectRequest {
  group: string;
  prompt: string;
  process_after?: string;
}

function parseBody(raw: string): InjectRequest | null {
  try {
    const body = JSON.parse(raw);
    if (typeof body.group !== 'string' || typeof body.prompt !== 'string') return null;
    if (body.process_after !== undefined && typeof body.process_after !== 'string') return null;
    return body as InjectRequest;
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/task-inject') {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }

  // Auth — reject before reading body
  if (!SECRET || req.headers['x-task-secret'] !== SECRET) {
    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Unauthorized');
    return;
  }

  // Read body
  let raw = '';
  try {
    for await (const chunk of req) raw += chunk;
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }

  const body = parseBody(raw);
  if (!body) {
    res
      .writeHead(400, { 'Content-Type': 'text/plain' })
      .end('Body must be JSON with group (string) and prompt (string)');
    return;
  }

  // Resolve agent group
  const agentGroup = getAgentGroupByFolder(body.group);
  if (!agentGroup) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Unknown agent group: ${body.group}`);
    return;
  }

  // Find active session
  const session = findSessionByAgentGroup(agentGroup.id);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`No active session for: ${body.group}`);
    return;
  }

  const taskId = generateTaskId();
  const now = new Date().toISOString();

  writeSessionMessage(agentGroup.id, session.id, {
    id: taskId,
    kind: 'task',
    timestamp: now,
    trigger: 1,
    content: JSON.stringify({ prompt: body.prompt }),
    processAfter: body.process_after ?? null,
  });

  if (!body.process_after) {
    await wakeContainer(session);
  }

  log.info('Task injected via external endpoint', {
    taskId,
    group: body.group,
    agentGroupId: agentGroup.id,
    session: session.id,
    scheduled: body.process_after ?? 'immediate',
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ taskId, session: session.id }));
});

// TASK_INJECT_HOST controls the bind address.
// Default: '127.0.0.1' (loopback only).
// Set to '0.0.0.0' when callers run in Docker (they reach the host via
// host.docker.internal, which arrives on a non-loopback interface).
const HOST = env.TASK_INJECT_HOST ?? '127.0.0.1';

if (!SECRET) {
  log.warn('TASK_INJECT_SECRET is not set — task inject endpoint disabled');
} else {
  server.listen(PORT, HOST, () => {
    log.info('Task inject server listening', { port: PORT, host: HOST });
  });
}
