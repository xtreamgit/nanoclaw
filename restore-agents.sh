#!/usr/bin/env bash
# restore-agents.sh - Register backed-up agent groups in NanoClaw database

DB_PATH="/Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw/data/v2.db"

echo "Registering backed-up agent groups..."

# Jean Luc - Head of Operations
sqlite3 "$DB_PATH" <<EOF
INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
VALUES (
  'ag-1777304452620-wdlzt4',
  'Jean Luc',
  'jean-luc',
  NULL,
  datetime('now')
);
EOF

# Morgan - Senior Project Manager
sqlite3 "$DB_PATH" <<EOF
INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
VALUES (
  'ag-1777256615401-4799t0',
  'Morgan',
  'morgan',
  NULL,
  datetime('now')
);
EOF

# Victor - (check CLAUDE.local.md for role)
sqlite3 "$DB_PATH" <<EOF
INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
VALUES (
  'ag-1777323565662-s6jf52',
  'Victor',
  'victor',
  NULL,
  datetime('now')
);
EOF

# Main - (check CLAUDE.local.md for role)
# Note: main folder doesn't have a container.json with agentGroupId, so we'll generate a new one
MAIN_ID="ag-$(date +%s%3N)-$(openssl rand -hex 3)"
sqlite3 "$DB_PATH" <<EOF
INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
VALUES (
  '$MAIN_ID',
  'Main',
  'main',
  NULL,
  datetime('now')
);
EOF

echo "✓ Agent groups registered"
echo ""
echo "Registered agents:"
sqlite3 "$DB_PATH" "SELECT id, name, folder FROM agent_groups ORDER BY name;"
echo ""
echo "Next steps:"
echo "1. Review each agent's CLAUDE.local.md to understand their roles"
echo "2. Wire agents to messaging channels with: /manage-channels"
echo "3. Build container images: pnpm run build-agent-image <folder-name>"
