# Runbook

What to do when the box, the database or a deploy goes wrong. Everything here
assumes the layout deploy.sh uses: the app at `/home/weika/xero-invoice-app`
on the `xero-automation` VM, run by pm2 as `xero-invoice-app`.

## What a restore needs (the backup set)

| Item | Where on the box | Why |
|---|---|---|
| `app.db` | `main/data/app.db` (backups in `main/data/backups/`) | users, credentials (encrypted), invoices, connected orgs |
| per-user files | `main/data/users/<id>/` | receipts, invoice PDFs, mail and job queues |
| `.env` | `main/.env` | `ENCRYPTION_KEY` — without it every stored credential in the database is unreadable; `JWT_SECRET` |

Keep `ENCRYPTION_KEY` and `JWT_SECRET` in a password manager as well. Losing
`ENCRYPTION_KEY` means every user reconnects Xero and re-enters their mailbox
password; losing `JWT_SECRET` only logs everyone out.

## Backups

- **Daily, on the box:** deploy.sh installs a cron line that runs
  `node main/db/backup.js` at 19:00 UTC (03:00 Singapore). Each backup is one
  portable `.db` file, checked with `integrity_check` before it counts; the
  newest 14 are kept. Output: `logs/backup.log`.
- **Before every deploy:** deploy.sh takes a verified backup before it restarts
  anything, and refuses to restart if the backup fails.
- **Off the box:** `npm run backup:pull` takes a fresh backup and copies it,
  `main/data/users` and `.env` to `~/xero-backups/<timestamp>/xero-backup.tgz`
  on your machine. Run it after anything important, and at least weekly — the
  VM's disk is one failure domain.

## Restore

On the box, as `weika`, in the app directory:

```bash
pm2 stop xero-invoice-app
cp main/data/backups/app-<timestamp>.db main/data/app.db
rm -f main/data/app.db-wal main/data/app.db-shm      # stale WAL pages from the old file
# if restoring files too, from a pulled set:
#   tar xzf xero-backup.tgz main/data/users main/.env    (run from the app directory)
pm2 start ecosystem.config.js && pm2 save
curl -sk https://34-45-253-162.sslip.io/dashboard/health
```

The database is migrated on boot (`main/db/migrate.js`), so an older backup
opens under newer code.

## Rollback a deploy

Every successful deploy is tagged `deploy/<timestamp>` on GitHub. To go back:

```bash
# on the box
git fetch --tags && git checkout deploy/<timestamp>
npm ci && npm --prefix ui ci && npm run build:ui
pm2 startOrReload ecosystem.config.js --update-env && pm2 save
```

Then `npm run deploy -- --check` from your machine will report the drift until
master is moved back too.

## Deploy

`npm run deploy` (from your machine, with `gcloud` and `gh` logged in):

1. refuses uncommitted or unpushed local changes;
2. waits for the GitHub Actions run for that commit to be green (`SKIP_CI=1`
   skips this — only when CI itself is broken);
3. pulls on the box, installs both trees with `npm ci`, runs the tests there,
   builds the UI;
4. takes a verified backup;
5. reloads pm2 through `ecosystem.config.js` (restart backoff, at most 10
   restarts before it stops and waits for a person);
6. checks `/dashboard/health` reports `status: healthy` and the shipped commit
   from the running process;
7. installs the backup cron and pushes the `deploy/<timestamp>` tag.

## Health and crashes

- `https://34-45-253-162.sslip.io/dashboard/health` returns
  `{ status, commit, timestamp }`. `commit` is what the running process was
  started from; compare with `git rev-parse HEAD` locally.
- A fatal exit posts the reason to Slack (if `SLACK_WEBHOOK_URL` is set) before
  the process exits; pm2 restarts it with backoff. If it stops restarting
  (`max_restarts` reached): `pm2 logs xero-invoice-app --err --lines 100`, fix,
  then `pm2 restart xero-invoice-app`.
- Nothing external watches the health URL yet. A free uptime checker pointed
  at it is the cheapest next step.

## Keys

- Rotate `JWT_SECRET`: change it in `.env`, `pm2 restart`; everyone logs in
  again.
- Rotate `ENCRYPTION_KEY`: there is no re-encryption path yet — changing it
  makes every stored credential unreadable. Do not rotate it without first
  planning a re-encrypt step; ask before doing this.
