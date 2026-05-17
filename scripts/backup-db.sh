#!/bin/bash
# Weekly backup of the NanoClaw central database (data/v2.db).
# Runs every Friday at midnight via cron. Backups are stored in data/archive/.

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB="$NANOCLAW_DIR/data/v2.db"
ARCHIVE_DIR="$NANOCLAW_DIR/data/archive"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$ARCHIVE_DIR/v2.db.bak-$TIMESTAMP"

mkdir -p "$ARCHIVE_DIR"

if [ ! -f "$DB" ]; then
  echo "[$TIMESTAMP] ERROR: database not found at $DB" >&2
  exit 1
fi

cp "$DB" "$BACKUP"
echo "[$TIMESTAMP] Backup saved: $BACKUP"
