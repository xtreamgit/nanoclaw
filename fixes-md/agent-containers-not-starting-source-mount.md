# Fix: Agent Containers Not Starting + Why the Previous Fix Didn't Fully Work

**Date:** May 2, 2026
**Related fix:** [context-compaction-protocol-drift.md](context-compaction-protocol-drift.md)
**Affected component:** `container/agent-runner/src/` (source mount architecture), session lifecycle

---

## Symptom

Only 4 of 10 expected agent containers appear in Docker Desktop: `dm-with-saul`, `victor`,
`aleck`, and `mara`. The remaining agents (Harper, Kai, Steve, Roman, Morgan, Jean Luc)
never spin up, even though their sessions and inbound databases exist and Saul claims he
sent them messages.

---

## Investigation

### What Saul was doing

Saul's outbound.db showed zero `channel_type = 'agent'` messages after 18:37. Every
message after that point went to `channel_type = 'telegram'` as plain text. At 18:50 Saul
wrote: *"Pings sent to all 9 agents"* — but the outbound DB proved no `<message>` blocks
were emitted. The 6 non-running agents' inbound DBs had no recent messages. Their
containers never started because Saul never actually sent to them.

### Why Victor, Aleck, and Mara started

Saul **did** emit proper `<message to="name">` blocks for those three earlier in the
session (seqs 1137, 1203, 1209, 1213). Those blocks were processed by the host, routed,
and their containers spawned. The drift happened after those exchanges — Saul stopped using
the protocol for subsequent pings.

### Saul's own incorrect diagnosis

Saul told Hector: *"The 4 containers that work all have custom images."* This was wrong.
Only Saul has a custom image (`ag-1777520861575-n3h33w` with Google Workspace MCP
packages). Victor, Aleck, and Mara all use `:latest` — the same image as the 6
non-starting agents. The image was not the differentiator; whether Saul sent actual
`<message>` blocks was.

---

## Why the Previous Fix Didn't Fully Work

The [previous fix](context-compaction-protocol-drift.md) made two code changes:

1. **Per-message routing reminder** — appended to every human-turn prompt so the model
   always sees the `<message>` protocol instruction, even after compaction.
2. **Compaction detection + continuation reset** — clears the session on compaction so the
   next turn starts fresh.

Both changes are correct. **The problem was deployment.**

### The source mount architecture

The agent-runner source code is **not baked into the Docker image**. The Dockerfile only
installs dependencies:

```dockerfile
COPY agent-runner/package.json agent-runner/bun.lock ./
RUN bun install
```

At container startup, `container-runner.ts` mounts the host's source directory into every
container read-only:

```typescript
// src/container-runner.ts:301-303
const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });
```

Bun reads and JIT-compiles the TypeScript files at import time when the container starts.
A running container has those files loaded in memory — it does not hot-reload them.

**Consequence:** editing source files on the host takes effect only when a new container
starts. The running Saul container had loaded the old `poll-loop.ts` at 11:10 and kept
running with the old code even after the fix was written to disk at ~11:45.

### The image rebuild was unnecessary and misleading

Running `./container/build.sh` and `docker build` does not deploy source code changes.
The images contain only the bun dependency tree, not the TypeScript source. Both the `:latest`
and Saul-specific images kept showing `Created: 2026-04-30T06:12:08` — not because the
cache wasn't busted, but because BuildKit normalizes the creation timestamp for
reproducible builds. The creation date is not a reliable indicator of whether source
changes were included.

### The BuildKit cache issue

Even when the builder cache is pruned (`docker builder prune -f`), the images are rebuilt
from the Dockerfile but the source files are not in the image to begin with — so there is
nothing to invalidate. The CLAUDE.md warning about stale build context applies to the apt/npm
package install layers, not to source code (which is mounted at runtime).

### Session drift without compaction

The prior fix document focused on context compaction as the trigger for protocol drift.
This incident showed that drift can also happen through accumulated session length alone,
without a compaction event. Saul's session ran for ~7 hours after the continuation was
cleared. No compaction message appeared, but the model still stopped using `<message>`
blocks — likely because the conversation context grew large enough that the instruction was
no longer in the most-recent portion of the context window.

---

## The Fix

### Immediate recovery

1. **Clear the session continuation** — forces a clean session start on the next message:
   ```bash
   SESS_DIR="data/v2-sessions/<agent-group-id>/<session-id>"
   sqlite3 "$SESS_DIR/outbound.db" \
     "DELETE FROM session_state WHERE key LIKE 'continuation:%';"
   ```
   Equivalent user action: type `/clear` in the agent's Telegram DM.

2. **Kill the running container** — forces NanoClaw to spawn a new container that mounts
   the current source files (including any code fixes written since the container started):
   ```bash
   docker kill <container-name>
   ```
   NanoClaw detects the exit and spawns a fresh container on the next inbound message.

### Why this works

The new container mounts `/container/agent-runner/src/` from the current host filesystem.
The fixes to `poll-loop.ts` (per-message reminder, compaction detection) are already on
disk. The fresh container loads them at startup, and the cleared continuation means the
first turn starts with no session history — the model reads the system prompt fresh.

---

## Key Architecture Facts to Remember

| Fact | Implication |
|------|-------------|
| Source code is mounted RO at runtime, not in the image | Editing source files takes effect on next container start, not immediately |
| Image rebuilds don't deploy source changes | Never rebuild images to "deploy" a poll-loop or destinations fix |
| Running containers load source at startup | Kill + restart required for code changes to reach a live agent |
| Session drift can occur without compaction | Long sessions (4+ hours) can lose protocol compliance even without a compaction event |
| `/clear` in Telegram resets the continuation | Fastest operator fix when an agent stops routing to other agents |

---

## How to Deploy Source Code Changes Going Forward

```bash
# 1. Edit the source files (already on host)
# 2. No image rebuild needed
# 3. Kill any running containers that use the old code:
docker kill $(docker ps --format '{{.Names}}' | grep nanoclaw)
# 4. Send a message to any agent — NanoClaw auto-spawns fresh containers
```

To rebuild images (only needed when apt/npm packages change in the Dockerfile):
```bash
docker builder prune -f   # only if package layer is stale
./container/build.sh
```
