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
  VM's disk is one failure domain. It stops if the fresh backup fails (rather
  than bundling the previous one), and the bundle — which holds `.env` — is
  private on the box and removed from its `/tmp` even when the copy fails.

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

Every successful deploy is tagged `deploy/<timestamp>` on GitHub (a deploy
that stops partway prints these same steps with the commit to go back to —
see *A deploy that failed partway* below). To go back:

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

1. checks the logins first. An expired Google login once left gcloud waiting
   on a reauth prompt nobody could see, and a deploy hung for thirty minutes;
   now it stops at once with `gcloud login expired — run: gcloud auth login`.
   `gh` must be installed and logged in too, unless `SKIP_CI=1`;
2. refuses uncommitted or unpushed local changes, and a local checkout that
   is not exactly `origin/master` (behind or diverged) — pull first;
3. waits for the GitHub Actions run for that commit to be green (`SKIP_CI=1`
   skips this — only when CI itself is broken);
4. moves the box to exactly that commit (`git merge --ff-only <sha>`, not a
   pull of whatever master is by then), installs both trees with `npm ci`,
   runs the tests there, builds the UI. A failed install, a non-zero
   `npm test` or a test run with no `Tests:` summary stops it; the logs stay on
   the box in `logs/deploy-npm-ci.log`, `logs/deploy-ui-npm-ci.log` and
   `logs/deploy-test.log`;
5. takes a verified backup;
6. reloads pm2 through `ecosystem.config.js` (restart backoff, at most 10
   restarts before it stops and waits for a person);
7. checks `/dashboard/health` (a few tries, 10 s each) reports
   `status: healthy` and the shipped commit from the running process, then
   that pm2 still has it online, with no new restarts, 15 s later;
8. installs the backup cron and pushes the `deploy/<timestamp>` tag.

Every call to the box has a time limit (300 s; 1200 s for `npm ci`, the tests
and the UI build — `DEPLOY_SSH_TIMEOUT` and `DEPLOY_LONG_TIMEOUT` change them),
and an ssh call that fails or times out stops the deploy with gcloud's error
rather than being read as empty output.

## A deploy that failed partway

Where it stopped decides what state the box is in. deploy.sh prints which of
these it is, and from the merge onward it also prints the commit the server
was on before and the exact rollback commands.

| Stopped at | Server checkout | Running process | Next |
|---|---|---|---|
| logins, local checks, CI | unchanged | old | fix what it names (`gcloud auth login`, `gh auth login`, pull, push) and run again |
| server checks: modified tracked files that could not be discarded, untracked files in the way, `DEPLOY DID NOT APPLY` | unchanged | old | resolve what it lists on the box and run again |
| `npm ci`, tests, UI build, backup | **new commit** | old, still serving | see below — the dangerous one |
| restart, health check, "not staying up" | **new commit** | new and failing, crash-looping, down, or still old | `pm2 list`, `pm2 logs xero-invoice-app --err --lines 100`; roll back now if users are affected |
| backup cron or tag push (`!` warnings, deploy still reported) | new | new, confirmed | nothing urgent: rerun to install the cron, or push the tag by hand |

The dangerous state is the third row. The old process keeps serving, but the
files on disk, and `node_modules` if `npm ci` got that far, belong to the new
commit — which did not pass the checks. Anything that makes pm2 restart the
process (a crash, a reboot of the VM) brings it up on that code. Do not leave
the box like this: either finish or roll back.

A failed ssh call ("gcloud compute ssh failed", "no answer from the server
within …") stops the deploy wherever it was. If it came after the merge the
same help is printed; if it was the merge itself, the checkout may be on
either commit, and `npm run deploy -- --check` says which. Check
`gcloud compute ssh xero-automation --zone=us-central1-a` works by hand
first — an expired login is caught before anything remote runs, so this is
usually the VM or the network.

**To finish:** fix the cause and run `npm run deploy` again. The server is
already on the commit, so the deploy carries on: it installs, tests, backs up
and restarts as usual.

**To roll back:** on the box, as `weika`, in the app directory, with the
previous commit deploy.sh printed (or a `deploy/<timestamp>` tag, as in
*Rollback a deploy* above):

```bash
git checkout <previous commit>
npm ci && npm --prefix ui ci && npm run build:ui
pm2 startOrReload ecosystem.config.js --update-env && pm2 save
curl -sk https://34-45-253-162.sslip.io/dashboard/health    # commit = the previous one
```

The reload is needed even when the process never restarted: `npm ci` may
already have replaced `node_modules` under it. The checkout is then a
detached HEAD at the old commit; the next `npm run deploy` fast-forwards it
as usual, and `npm run deploy -- --check` reports the drift until then.

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
