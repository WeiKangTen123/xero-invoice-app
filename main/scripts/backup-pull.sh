#!/usr/bin/env bash
#
# Copies the full backup set off the box: the newest verified DB backup, the
# per-user files (receipts, PDFs, queues) and .env — which holds the
# ENCRYPTION_KEY without which the database's stored credentials are
# unreadable. Lands in ~/xero-backups/<timestamp>/xero-backup.tgz.
# Restore steps: docs/RUNBOOK.md.
#
#   npm run backup:pull
#
# Because the set holds .env, it is created private (umask 077, mode 600) under
# a name of its own in the box's /tmp, and removed from there whatever happens
# next. It used to be chmod 644, and an scp that failed exited before the
# cleanup, which left the key readable by anyone on the box.
#
# A failed backup used to be hidden too: `backup.js | tail -1` reported tail's
# success, so the set went out with the PREVIOUS backup in it. Now "Backed up"
# must appear in backup.js's output, the test deploy.sh uses (its last line can
# be "Pruned old backup …" after a good backup, so the whole output is read).
#
# The tar stream is written to the file by the ssh login shell rather than by
# $RUNAS, so the file belongs to the user that scp and the cleanup run as,
# whether or not that is the same account.
set -euo pipefail
umask 077

INSTANCE="${DEPLOY_INSTANCE:-xero-automation}"
ZONE="${DEPLOY_ZONE:-us-central1-a}"
APP="${DEPLOY_PATH:-/home/weika/xero-invoice-app}"
RUNAS="${DEPLOY_USER:-weika}"
STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
DEST="${BACKUP_DEST:-$HOME/xero-backups}/$STAMP"
REMOTE_TGZ="/tmp/xero-backup-$STAMP.tgz"

fail() {
  echo "✗ $*" >&2
  [ -s "$ERR" ] && tr -d '\r' < "$ERR" | tail -n 15 | sed 's/^/    /' >&2
  exit 1
}

ERR=$(mktemp)
BUNDLING=0
# Runs however the script ends. The remote rm gets its own time limit: a
# cleanup that hung would be the same bug as the one deploy.sh's preflight
# exists for.
cleanup() {
  local rc=$?
  if [ "$BUNDLING" = 1 ]; then
    "$TIMEOUT" --foreground -k 10 120 gcloud compute ssh "$INSTANCE" --zone="$ZONE" --quiet \
        --command="rm -f $REMOTE_TGZ" </dev/null >/dev/null 2>&1 \
      || echo "✗ could not remove $REMOTE_TGZ from the box. It holds .env — remove it by hand: gcloud compute ssh $INSTANCE --zone=$ZONE --command='rm -f $REMOTE_TGZ'" >&2
  fi
  [ "$rc" -ne 0 ] && rmdir "$DEST" 2>/dev/null   # nothing landed; leave no empty set behind
  rm -f "$ERR"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# GNU timeout: in Git Bash and on Linux it is `timeout`; on a Mac it comes with
# coreutils as `gtimeout`. Every gcloud call has stdin from /dev/null and a
# time limit, so an expired login fails instead of waiting on a prompt.
TIMEOUT=$(command -v timeout || command -v gtimeout || true)
[ -n "$TIMEOUT" ] || fail "this script needs GNU timeout (on a Mac: brew install coreutils)"
"$TIMEOUT" --foreground -k 5 60 gcloud auth print-access-token </dev/null >/dev/null 2>&1 \
  || fail "gcloud login expired — run: gcloud auth login"

mkdir -p "$DEST"
echo "Taking a fresh, verified DB backup on the box and bundling the set…"
BUNDLING=1   # from here a partial bundle may exist on the box; cleanup removes it
"$TIMEOUT" --foreground -k 10 "${BACKUP_SSH_TIMEOUT:-600}" \
  gcloud compute ssh "$INSTANCE" --zone="$ZONE" --quiet \
    --command="umask 077; sudo -u $RUNAS -H bash -lc 'cd $APP && OUT=\$(node main/db/backup.js 2>&1); echo \"\$OUT\" >&2; echo \"\$OUT\" | grep -q \"Backed up\" || exit 3; LATEST=\$(ls -t main/data/backups/*.db | head -1) && tar czf - \"\$LATEST\" main/data/users main/.env' > $REMOTE_TGZ" \
  </dev/null >/dev/null 2>"$ERR" \
  || fail "the backup or the bundle failed on the box — nothing was copied"
tr -d '\r' < "$ERR" | sed -n 's/^\(Backed up.*\)/    \1/p'

"$TIMEOUT" --foreground -k 10 "${BACKUP_SCP_TIMEOUT:-1800}" \
  gcloud compute scp "$INSTANCE:$REMOTE_TGZ" "$DEST/xero-backup.tgz" --zone="$ZONE" --quiet \
  </dev/null >/dev/null 2>"$ERR" \
  || { rm -f "$DEST/xero-backup.tgz"; fail "could not copy the set off the box"; }
chmod 600 "$DEST/xero-backup.tgz" 2>/dev/null || true

echo "Contents:"; tar tzf "$DEST/xero-backup.tgz" | sed -n '1,6s/^/    /p'   # sed, not head: head closing the pipe trips pipefail
echo "✓ backup set in $DEST"
