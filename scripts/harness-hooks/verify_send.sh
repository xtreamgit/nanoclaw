#!/bin/bash
# PostToolUse hook: verify send_message/send_file actually wrote to outbound.db
# Receives tool result JSON on stdin from Claude Code hook system
# Exit 1 = verification failed (injected into agent context as error)

RESULT=$(cat)

# Extract seq number from result text (format: "Message sent to X (id: NNN)")
MSG_SEQ=$(echo "$RESULT" | grep -oP '(?<=id: )\d+' | head -1)

if [ -z "$MSG_SEQ" ]; then
  # No parseable ID — non-standard response, skip verification
  exit 0
fi

# Wait for DB write to propagate
sleep 2

# Query outbound.db by seq
FOUND=$(cd /app && bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/workspace/outbound.db');
const row = db.query('SELECT id FROM messages_out WHERE seq = ?').get(parseInt('$MSG_SEQ'));
console.log(row ? 'found' : 'missing');
" 2>/dev/null)

if [ "$FOUND" != "found" ]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  MSG="CRITICAL: send verification failed — seq $MSG_SEQ not found in outbound.db at $TIMESTAMP"
  echo "$MSG" >> /workspace/send_failures.log
  echo "$MSG" >&2
  exit 1
fi

exit 0
