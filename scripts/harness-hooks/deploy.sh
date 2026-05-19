#!/usr/bin/env bash
# Deploy harness-check hooks to all agent group directories.
#
# Run this after adding a new agent or after pulling this script from upstream.
# Safe to re-run — overwrites existing copies with the canonical versions.
#
# Usage:
#   bash scripts/harness-hooks/deploy.sh [group-name]
#
# With no argument, deploys to all groups under groups/.
# With a group name, deploys only to that group.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GROUPS_DIR="$REPO_ROOT/groups"

deploy_to_group() {
  local group="$1"
  local gdir="$GROUPS_DIR/$group"

  if [ ! -d "$gdir" ]; then
    echo "ERROR: group directory not found: $gdir" >&2
    return 1
  fi

  mkdir -p "$gdir/harness-checks"
  cp "$SCRIPT_DIR/check_journal_mode.sh" "$gdir/harness-checks/"
  cp "$SCRIPT_DIR/verify_send.sh"        "$gdir/harness-checks/"
  chmod +x "$gdir/harness-checks/"*.sh

  mkdir -p "$gdir/.claude"
  cp "$SCRIPT_DIR/settings.json.template" "$gdir/.claude/settings.json"

  echo "✓ $group"
}

if [ "${1:-}" != "" ]; then
  deploy_to_group "$1"
else
  for gdir in "$GROUPS_DIR"/*/; do
    group="$(basename "$gdir")"
    deploy_to_group "$group"
  done
fi

echo "Harness hooks deployed."
