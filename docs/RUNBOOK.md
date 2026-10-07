# Runbook

What to do when the box, the database or a deploy goes wrong. Everything here
assumes the layout deploy.sh uses: the app at `/home/weika/xero-invoice-app`
on the `xero-automation` VM, run by pm2 as `xero-invoice-app`.

## What a restore needs (the backup set)

| Item | Where on the box | Why |
|---|---|---|
| `app.db` | `main/data/app.db` (backups in `main/data/backups/`) | users, credentials (encrypted), invoices, connected orgs |
| per-user files | `main/data/users/<id>/` | receipts, invoice PDFs, mail and job queues |
| `.env` | `main/.env` | the encryption keys (`ENCRYPTION_KEY`, and `ENCRYPTION_KEYS`/`ENCRYPTION_KEY_ID` once a key has been rotated) — without them every stored credential in the database is unreadable; `JWT_SECRET` |

Keep the encryption keys and `JWT_SECRET` in a password manager as well,
including a key retired by a rotation for as long as any backup taken before
that rotation is kept (see *Rotate the encryption key*). Losing the key a
backup was written with means every user reconnects Xero and re-enters their
mailbox password; losing `JWT_SECRET` only logs everyone out.

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
opens under newer code. A backup from before an encryption key rotation needs
the key it was written with back in `.env` before its credentials can be
read — see *Restoring a backup from before a rotation* below.

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
8. smoke-checks the site through the same public address: `/` must be the
   app's HTML, the `/assets/index-*.js` it names must answer 200, and
   `/api/auth/status` must answer JSON. Healthy only says the process runs;
   this says users get the app (a UI build missing from `ui/dist` passes the
   health check and serves a blank page);
9. installs the backup cron and pm2's log rotation, and pushes the
   `deploy/<timestamp>` tag. These are best effort: a failure is a `!`
   line and a note in the final summary, never a failed deploy.

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
| smoke check | **new commit** | **new, already serving users**, healthy and stable — but the page, its script or the API did not come through the site | open the site in a browser; on the box `ls ui/dist/assets` and the nginx config; roll back now if users are affected |
| backup cron, pm2 log rotation or tag push (`!` warnings, deploy still reported) | new | new, confirmed | nothing urgent: rerun to install the cron or the rotation, or push the tag by hand |

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

## Logs

- **The app's own logs** are `logs/combined.log` and `logs/error.log` in the
  app directory, 10MB each and five rotated files kept (`main/utils/logger.js`).
  Admins read them in the app (`GET /api/admin/logs`). Requests are logged there in
  morgan's combined format, except the ones that succeed and say nothing: the
  pipeline status poll, the Invoices page's claim-import poll, health checks
  and static assets. A failure of any of those is still logged.
- **Tokens never reach the log as sent.** Pairing links carry their token in
  the path (`/capture/<token>`, `/api/receipts/capture/<token>/…`,
  `/api/receipts/pair/<token>`) and image, PDF and export links carry
  `?token=`; the Xero sign-in comes back with `?code=` and `?state=`. All of
  these are written as `[redacted]`, in the access log and in the error
  handler's log lines and Slack alerts.
- **pm2's logs** (`~/.pm2/logs/xero-invoice-app-out.log` and `-error.log`)
  hold what the process prints. In production that is only warnings and
  errors (errors on the error log, so `pm2 logs xero-invoice-app --err`
  shows them next to a crash) plus the startup lines (`LOG_CONSOLE_LEVEL=info`
  in `main/.env` puts every line back for a while). deploy.sh installs
  `pm2-logrotate` and sets it on every deploy: rotate at 10M, keep 10,
  compressed (`DEPLOY_PM2_LOG_MAX_SIZE`, `DEPLOY_PM2_LOG_RETAIN` change it).
  To check on the box: `pm2 ls` lists the module, `pm2 conf pm2-logrotate`
  shows its settings. To install it by hand:
  `pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 10M && pm2 set pm2-logrotate:retain 10 && pm2 set pm2-logrotate:compress true`.

## Keys

- Rotate `JWT_SECRET`: change it in `.env`, `pm2 restart`; everyone logs in
  again.
- Rotate the encryption key: never by changing `ENCRYPTION_KEY` in place —
  that makes every stored credential unreadable. Follow the procedure below.

### Rotate the encryption key

Stored secrets (Xero client secrets and refresh tokens, IMAP passwords, Gemini
keys) are AES-256-GCM encrypted in `app.db`. Three variables in `main/.env`
hold the keys:

| Variable | Format | What it does |
|---|---|---|
| `ENCRYPTION_KEY` | 64 hex characters | The original key. Reads every value written before the first rotation (stored as `enc:v1:…`, which names no key). With nothing else set, new values are written with it too, exactly as before rotation existed — a server with only this set needs nothing done. |
| `ENCRYPTION_KEYS` | `id:key,id:key` — each key exactly 64 hex characters, each id 1–32 letters, digits, `.`, `_` or `-` (use the date, e.g. `2026-10`) | The keys added by rotations. Optional until the first one. |
| `ENCRYPTION_KEY_ID` | one id from `ENCRYPTION_KEYS` | The primary key: new values are written with it, as `enc:v2:<id>:…`. Required whenever `ENCRYPTION_KEYS` is set. |

The server refuses to start (`STARTUP REFUSED` in
`pm2 logs xero-invoice-app --err` and on Slack) if any configured key is
malformed, if `ENCRYPTION_KEYS` is set without `ENCRYPTION_KEY_ID` or the
other way round, or if the primary id is not in `ENCRYPTION_KEYS`. The message
names the variable and the id, never the key. **Never reuse an id for a
different key**: the id is written into every value encrypted with it.

Nothing re-encrypts at boot. Configuring a new key only changes what new
writes use; moving the existing values is the script in step 6, run by hand.

Code from before key rotation existed cannot read `enc:v2` values — it would
pass them on as if they were the secret itself. From step 3 on, new values
are written that way, so after it do not roll a deploy back past the commit
that added rotation (`main/scripts/rotate-encryption-key.js` exists in every
commit that has it). Before step 3, rollbacks are unaffected.

On the box, as `weika`, in the app directory:

1. **Generate the new key** and put it in the password manager, with its id,
   before it goes anywhere else:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. **Add it to `main/.env`** and make it the primary. Leave `ENCRYPTION_KEY`
   and any keys already in `ENCRYPTION_KEYS` exactly as they are — they are
   still needed to read what was written with them. First rotation:

   ```
   ENCRYPTION_KEY=<the current key, unchanged>
   ENCRYPTION_KEYS=2026-10:<new key>
   ENCRYPTION_KEY_ID=2026-10
   ```

   A later rotation adds to the list:

   ```
   ENCRYPTION_KEYS=2026-10:<previous key>,2027-04:<new key>
   ENCRYPTION_KEY_ID=2027-04
   ```
3. **Restart** — `pm2 restart xero-invoice-app` — and check
   `/dashboard/health` is healthy. This comes before step 6 because the
   running server must hold the new key before anything is written with it:
   a server still on the old configuration cannot read what the script
   writes. If the boot is refused, fix what the message names and restart.
4. **Take a backup**: `node main/db/backup.js`, then `npm run backup:pull`
   from your machine. It is the way back if the next steps go wrong; like
   every backup from before the rotation, it needs the old key.
5. **Dry run**: `node main/scripts/rotate-encryption-key.js --dry-run`. It
   decrypts every encrypted value, re-encrypts it in memory with the primary
   key and reads it back, and prints counts per table and column. It writes
   nothing. If it refuses, it lists every value it could not decrypt (table,
   column and row id — never a secret); find the missing key before going on.
6. **Rotate**: `node main/scripts/rotate-encryption-key.js`. The same checks,
   then every value not already on the primary key is re-encrypted with it in
   one transaction, and read back from the database and decrypted before it
   commits. Any failure rolls the whole run back: the database is either fully
   on the new key or exactly as it was. It is safe to run again; values
   already on the primary key are left alone. Plaintext values (saved before
   encryption existed) are counted and left as they are.
7. **Check**: run the dry run again — it should end with `Every encrypted
   value is on "<id>"` — and use the app as a user whose Xero is connected
   (or run `node main/scripts/smoke-xero.js`, which only reads from Xero).
8. **Verify a backup taken after the rotation, without the old key.** Keep
   the old key in `.env` until this passes:

   ```bash
   node main/db/backup.js                               # prints the backup's path
   cp main/data/backups/app-<timestamp>.db /tmp/verify.db
   read -rsp 'new key: ' K; echo                        # keeps the key out of shell history
   DB_PATH=/tmp/verify.db ENCRYPTION_KEY= ENCRYPTION_KEYS="2026-10:$K" ENCRYPTION_KEY_ID=2026-10 \
     node main/scripts/rotate-encryption-key.js --dry-run
   unset K; rm -f /tmp/verify.db*
   ```

   Variables given on the command line win over `.env` (the empty
   `ENCRYPTION_KEY=` withholds the old key), and working on a copy leaves the
   backup file itself untouched. It must end with `Every encrypted value is
   on "2026-10"` and exit 0; a value that still needs the old key makes it
   refuse, naming the row. Then `npm run backup:pull` from your machine, so a
   verified post-rotation copy exists off the box too.
9. **Remove the old key** from `main/.env` — the `ENCRYPTION_KEY` line after
   the first rotation, the old `id:key` entry in `ENCRYPTION_KEYS` after a
   later one — then `pm2 restart xero-invoice-app` and check
   `/dashboard/health`. Keep the old key in the password manager.

#### Restoring a backup from before a rotation

Backups taken before a rotation hold values written with the old key: the
daily backups on the box for two weeks, and pulled bundles for as long as
they are kept (a pulled bundle carries the `.env` of its day, so its own
keys travel with it). To restore one after the old key has been removed, put
the old key back first — as `ENCRYPTION_KEY` for `enc:v1` values, or under
its original id in `ENCRYPTION_KEYS` — beside the current keys, then restore
as above and restart. A value whose key is missing fails with a message
naming that key (`encrypted with key "2026-10", which is not in
ENCRYPTION_KEYS`, or `enc:v1, written under ENCRYPTION_KEY, which is not
set`). To bring the restored data onto the current key, run steps 4–9 again.
