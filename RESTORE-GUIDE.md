# Agent Restoration Guide

## Summary
You have 4 agent folders from a previous NanoClaw installation that need to be registered in the current database.

## Backed-Up Agents

### 1. **Jean Luc** (`jean-luc/`)
- **Role:** Head of Operations at Develom
- **ID:** `ag-1777304452620-wdlzt4`
- **Features:** Google Drive MCP integration, operational management
- **Files:** CLAUDE.local.md, job-description.md, operations.md, vendors.md, agents.md

### 2. **Morgan** (`morgan/`)
- **Role:** Senior Project Manager
- **ID:** `ag-1777256615401-4799t0`
- **Features:** Google Drive MCP integration
- **Files:** CLAUDE.local.md, job-description.md, projects.md

### 3. **Victor** (`victor/`)
- **Role:** (Check CLAUDE.local.md for details)
- **ID:** `ag-1777323565662-s6jf52`
- **Features:** Google Drive MCP integration
- **Files:** CLAUDE.local.md, job-description.md, google-drive-setup.md, nanoclaw-a2a-fix.md, nanoclaw-research.md

### 4. **Main** (`main/`)
- **Role:** Personal assistant with admin privileges (main control channel)
- **ID:** Will be generated (no container.json found)
- **Features:** Web browsing, scheduling, group management, elevated privileges
- **Files:** CLAUDE.local.md (extensive 313-line configuration)
- **Note:** This appears to be from an older WhatsApp-based NanoClaw setup

## Restoration Steps

### Quick Method (Recommended)
```bash
cd /Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw
chmod +x restore-agents.sh
./restore-agents.sh
```

### Manual Method
If you prefer to register them one by one or customize:

```bash
DB="/Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw/data/v2.db"

# Register Jean Luc
sqlite3 "$DB" "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) \
  VALUES ('ag-1777304452620-wdlzt4', 'Jean Luc', 'jean-luc', NULL, datetime('now'));"

# Register Morgan
sqlite3 "$DB" "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) \
  VALUES ('ag-1777256615401-4799t0', 'Morgan', 'morgan', NULL, datetime('now'));"

# Register Victor
sqlite3 "$DB" "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) \
  VALUES ('ag-1777323565662-s6jf52', 'Victor', 'victor', NULL, datetime('now'));"
```

## After Registration

### 1. Verify Registration
```bash
sqlite3 "$DB" "SELECT id, name, folder FROM agent_groups ORDER BY name;"
```

### 2. Update Container Configs (if needed)
Each agent's `container.json` should have the correct `agentGroupId`. The restore script preserves the original IDs.

### 3. Build Container Images
```bash
cd /Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw
pnpm run build-agent-image jean-luc
pnpm run build-agent-image morgan
pnpm run build-agent-image victor
pnpm run build-agent-image main
```

### 4. Wire to Channels
Use NanoClaw's built-in management:
```
@Andy /manage-channels
```
Or manually create messaging group wiring in the database.

### 5. Test Each Agent
Start a session with each agent to verify they work:
```bash
claw jean-luc "Hello, introduce yourself"
claw morgan "Hello, introduce yourself"
claw victor "Hello, introduce yourself"
```

## Important Notes

- **Version Compatibility:** The `main` agent appears to be from an older WhatsApp-based NanoClaw architecture (references `/workspace/ipc/`, `messages.db`, `registered_groups` table). The current v2 architecture uses a different structure. You may need to update `main/CLAUDE.local.md` to match the current system.

- **Google Drive MCP:** All three agents (Jean Luc, Morgan, Victor) reference Google Drive. Ensure `/Users/hd/.gdrive-mcp` exists with proper credentials.

- **Agent-to-Agent Communication:** Jean Luc references sending messages to "parent" (Saul). You may need to set up agent destinations using the current v2 agent-to-agent system.

- **Memory Files:** Each agent has operational files (operations.md, vendors.md, etc.) that contain their working state from the previous installation.

- **CLAUDE.md Composition:** All agents use the modular CLAUDE.md system with fragments from `.claude-fragments/`. Ensure these fragment files exist in your current installation.

## Troubleshooting

### If an agent won't start:
1. Check container.json is valid JSON
2. Verify agentGroupId matches database
3. Check mount paths exist (e.g., `/Users/hd/.gdrive-mcp`)
4. Review logs: `docker logs <container-name>`

### If database insert fails:
- Use `INSERT OR IGNORE` to avoid duplicates
- Check for unique constraint violations on folder name
- Verify the database path is correct

## Architecture Note

NanoClaw uses a **database-first** discovery model:
- Agent groups are registered in `data/v2.db` → `agent_groups` table
- Filesystem folders in `groups/` contain configuration
- No auto-discovery of folders — explicit registration required
