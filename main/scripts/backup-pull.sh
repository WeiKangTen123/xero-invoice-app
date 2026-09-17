#!/usr/bin/env bash
#
# Copies the full backup set off the box: the newest verified DB backup, the
# per-user files (receipts, PDFs, queues) and .env — which holds the
# ENCRYPTION_KEY without which the database's stored credentials are
# unreadable. Lands in ~/xero-backups/<timestamp>/xero-backup.tgz.
# Restore steps: docs/RUNBOOK.md.
#
#   npm run backup:pull
set -euo pipefail

INSTANCE="${DEPLOY_INSTANCE:-xero-automation}"
ZONE="${DEPLOY_ZONE:-us-central1-a}"
APP="${DEPLOY_PATH:-/home/weika/xero-invoice-app}"
RUNAS="${DEPLOY_USER:-weika}"
DEST="${BACKUP_DEST:-$HOME/xero-backups}/$(date -u +%Y-%m-%dT%H-%M-%SZ)"

mkdir -p "$DEST"
echo "Taking a fresh, verified DB backup on the box and bundling the set…"
gcloud compute ssh "$INSTANCE" --zone="$ZONE" --command="sudo -u $RUNAS -H bash -lc 'cd $APP && node main/db/backup.js | tail -1 && LATEST=\$(ls -t main/data/backups/*.db | head -1) && tar czf /tmp/xero-backup.tgz \"\$LATEST\" main/data/users main/.env && chmod 644 /tmp/xero-backup.tgz'" 2>/dev/null
gcloud compute scp "$INSTANCE:/tmp/xero-backup.tgz" "$DEST/" --zone="$ZONE" 2>/dev/null
gcloud compute ssh "$INSTANCE" --zone="$ZONE" --command="rm -f /tmp/xero-backup.tgz" 2>/dev/null
echo "Contents:"; tar tzf "$DEST/xero-backup.tgz" | head -6 | sed 's/^/    /'
echo "✓ backup set in $DEST"
