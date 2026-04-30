#!/usr/bin/env bash
# wire-agent-destinations.sh - Set up agent-to-agent communication

DB_PATH="/Users/hd/github.com/xtreamgit/claudecode/AGENT-Installs/nanoclaw/data/v2.db"

echo "Setting up agent-to-agent communication..."

# Saul's agent group ID
SAUL_ID="ag-1777520861575-n3h33w"
JEAN_LUC_ID="ag-1777304452620-wdlzt4"
MORGAN_ID="ag-1777256615401-4799t0"
VICTOR_ID="ag-1777323565662-s6jf52"

# Saul → Jean Luc
sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES ('$SAUL_ID', 'jean-luc', 'agent', '$JEAN_LUC_ID', datetime('now'));"

# Saul → Morgan
sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES ('$SAUL_ID', 'morgan', 'agent', '$MORGAN_ID', datetime('now'));"

# Saul → Victor
sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES ('$SAUL_ID', 'victor', 'agent', '$VICTOR_ID', datetime('now'));"

# Jean Luc → Saul (as "parent")
sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES ('$JEAN_LUC_ID', 'parent', 'agent', '$SAUL_ID', datetime('now'));"

# Morgan → Saul (as "parent")
sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES ('$MORGAN_ID', 'parent', 'agent', '$SAUL_ID', datetime('now'));"

# Victor → Saul (as "parent")
sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES ('$VICTOR_ID', 'parent', 'agent', '$SAUL_ID', datetime('now'));"

echo "✓ Agent destinations configured"
echo ""
echo "Saul can now message:"
sqlite3 "$DB_PATH" "SELECT local_name, target_type FROM agent_destinations WHERE agent_group_id = '$SAUL_ID' AND target_type = 'agent';"
echo ""
echo "Agents can reply to Saul via 'parent' destination"
