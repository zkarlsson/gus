#!/bin/bash
# Daily backup of OpenClaw config and workspace
# Add to cron: 0 3 * * * /home/openclaw/backup.sh
set -euo pipefail

BACKUP_DIR="/home/openclaw/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/openclaw-backup-$TIMESTAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

tar czf "$BACKUP_FILE" \
    -C /home/openclaw \
    .openclaw \
    clawd \
    2>/dev/null || true

# Keep only the last 7 daily backups
ls -t "$BACKUP_DIR"/openclaw-backup-*.tar.gz 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null || true

echo "Backup created: $BACKUP_FILE"
