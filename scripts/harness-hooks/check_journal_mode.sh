#!/bin/bash
# SessionStart hook: assert inbound.db is in DELETE journal mode
# WAL mode causes silent read freeze on VirtioFS mounts — container receives
# zero new messages with no error, no indication anything is wrong.

JOURNAL_MODE=$(cd /app && bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/workspace/inbound.db', { readonly: true });
const row = db.query('PRAGMA journal_mode').get();
console.log(Object.values(row)[0]);
" 2>/dev/null)

if [ "$JOURNAL_MODE" != "delete" ]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  MSG="CRITICAL: inbound.db is in '$JOURNAL_MODE' journal mode at $TIMESTAMP. Container will NOT receive new messages. Host must recreate inbound.db in DELETE mode."
  echo "$MSG" >> /workspace/harness_alerts.log
  echo "$MSG" >&2
  exit 1
fi

echo "[harness-check] inbound.db journal mode: $JOURNAL_MODE — OK"
exit 0
