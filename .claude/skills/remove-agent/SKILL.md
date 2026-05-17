---
name: remove-agent
description: Fully removes a decommissioned agent from NanoClaw — backs up v2.db, deletes from central DB (agent_groups, agent_destinations, sessions, messaging_group_agents), removes session data folder, removes groups workspace folder, kills any running container, and removes the agent from Saul's team roster in CLAUDE.local.md.
---

# /remove-agent

Fully decommission an agent from NanoClaw. Run by Claude Code on the host — requires access to the Mac filesystem, sqlite3, and docker.

## Usage

```
/remove-agent <agent-name>
```

Example: `/remove-agent eli`

---

## Step 1 — Validate the argument

The skill argument is the agent folder name (e.g. `eli`). If none was provided, ask: "Which agent should I remove?"

---

## Step 2 — Look up the agent in the central DB

```bash
NANOCLAW_DIR="/Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw"
AGENT_NAME="<agent-name>"
DB="$NANOCLAW_DIR/data/v2.db"

sqlite3 "$DB" "SELECT id, name, folder FROM agent_groups WHERE folder='$AGENT_NAME' OR name='$AGENT_NAME';"
```

If no row is returned, tell the user the agent was not found and stop.

Capture the `id` value (e.g. `ag-1777579209676-7jlyd2`) — needed for all subsequent steps.

---

## Step 3 — Show a summary and confirm

Display what will be deleted:
- Agent group: name, folder, id
- `agent_destinations` rows for this agent
- `sessions` rows for this agent
- `messaging_group_agents` rows for this agent
- Session data folder: `data/v2-sessions/<id>/`
- Workspace folder: `groups/<folder>/` (if it exists)
- Running container (if any)
- Roster row in `groups/dm-with-saul/CLAUDE.local.md`

Ask Hector to confirm before proceeding.

---

## Step 4 — Kill the running container (if any)

```bash
CONTAINER=$(docker ps --format "{{.ID}}\t{{.Names}}" | grep "nanoclaw-v2-${AGENT_NAME}-" | awk '{print $1}')
if [ -n "$CONTAINER" ]; then
  docker kill "$CONTAINER"
  echo "Killed container $CONTAINER"
else
  echo "No running container found for $AGENT_NAME"
fi
```

---

## Step 5 — Back up the central DB

```bash
BACKUP="$NANOCLAW_DIR/data/archive/v2.db.bak-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$NANOCLAW_DIR/data/archive"
cp "$DB" "$BACKUP"
echo "Backup saved: $BACKUP"
```

To restore if something goes wrong: `cp "$BACKUP" "$DB"`

---

## Step 6 — Remove from central DB

```bash
AGENT_ID="<agent-id>"

sqlite3 "$DB" "
DELETE FROM messaging_group_agents WHERE agent_group_id='$AGENT_ID';
DELETE FROM agent_destinations WHERE agent_group_id='$AGENT_ID';
DELETE FROM sessions WHERE agent_group_id='$AGENT_ID';
DELETE FROM agent_groups WHERE id='$AGENT_ID';
"
```

Verify all counts are 0:

```bash
sqlite3 "$DB" "SELECT COUNT(*) || ' messaging_group_agents' FROM messaging_group_agents WHERE agent_group_id='$AGENT_ID';"
sqlite3 "$DB" "SELECT COUNT(*) || ' agent_destinations' FROM agent_destinations WHERE agent_group_id='$AGENT_ID';"
sqlite3 "$DB" "SELECT COUNT(*) || ' sessions' FROM sessions WHERE agent_group_id='$AGENT_ID';"
sqlite3 "$DB" "SELECT COUNT(*) || ' agent_groups' FROM agent_groups WHERE id='$AGENT_ID';"
```

---

## Step 7 — Remove session data folder

```bash
SESSION_DIR="$NANOCLAW_DIR/data/v2-sessions/$AGENT_ID"
if [ -d "$SESSION_DIR" ]; then
  rm -rf "$SESSION_DIR"
  echo "Removed session data: $SESSION_DIR"
else
  echo "No session data folder found"
fi
```

---

## Step 8 — Remove workspace folder

```bash
WORKSPACE_DIR="$NANOCLAW_DIR/groups/$AGENT_NAME"
if [ -d "$WORKSPACE_DIR" ]; then
  rm -rf "$WORKSPACE_DIR"
  echo "Removed workspace: $WORKSPACE_DIR"
else
  echo "No workspace folder found"
fi
```

---

## Step 9 — Remove from Saul's team roster

Edit `groups/dm-with-saul/CLAUDE.local.md` and delete the table row for this agent. The row looks like:

```
| <destination> | <Full Name> | <Role> | <Origin> |
```

---

## Step 10 — Report

Confirm to Hector:
- ✅ DB backup saved: `data/archive/v2.db.bak-<timestamp>`
- ✅ Container killed (or: no container was running)
- ✅ Removed from `agent_groups`, `agent_destinations`, `sessions`, `messaging_group_agents`
- ✅ Session data deleted: `data/v2-sessions/<id>/`
- ✅ Workspace deleted: `groups/<folder>/`
- ✅ Removed from Saul's team roster

---

## Notes

- `NANOCLAW_DIR` = `/Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw`
- This skill runs on the Mac host via Claude Code — not from inside a container
- Removing from `v2.db` is the critical step: the host re-syncs `inbound.db` from `v2.db` on every container restart, so any change made only to `inbound.db` is overwritten on the next wake
- This operation is irreversible. All conversation history in `groups/<folder>/` is deleted.
- After removal, run `claw --list-groups` to confirm the agent no longer appears
