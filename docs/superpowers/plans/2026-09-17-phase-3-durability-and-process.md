# Phase 3 — Durability and process — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deployment recoverable and the deploy pipeline honest: scheduled, verified, off-box backups with a written restore; tests that never touch real data or logs; CI on Node 22 that the deploy script waits for; a deploy that installs from the lockfile, backs up before restarting, reloads under a committed pm2 config with backoff, and proves the running commit; and the data-loss edges closed (deleted users' files, the 500-row cap).

**Architecture:** One `main/utils/paths.js` owns where data lives (`DATA_DIR`, default `main/data`), so tests can point it at a temp directory. `backup.js` becomes a function that verifies its copy. `deploy.sh` keeps its "server SHA must match" rule and gains: CI wait via `gh`, `npm ci`, a pre-restart backup, `pm2 startOrReload` from `ecosystem.config.js`, a health check that returns the running commit, and a deploy tag. A `docs/RUNBOOK.md` records backup set, restore, rollback and key handling.

**Tech Stack:** Node 22, better-sqlite3 online backup API, pm2, GitHub Actions, `gh` CLI (installed and authenticated locally), gcloud.

**Findings:** audit §1.9, 1.11, hygiene #24, #27–#36; data-layer A4, B8, C1–C3, F1–F2, H1–H3.

**Owner decisions left out on purpose:** rewriting git history to remove `sample_expenses`; the two accounts that still have auto-post on from the old default; `server.MD` (a personal notes file, untracked).

---

### Task 1: One place says where data lives; tests write to a temp dir and log nowhere

**Files:**
- Create: `main/utils/paths.js`, `main/utils/paths.test.js`
- Modify: `main/utils/receipt-store.js:13`, `main/utils/pdf-store.js:4`, `main/queue/email-queue.js:4`, `main/claims/claim-queue.js:28`, `main/db/migrate.js:54`, `main/db/backup.js` (BACKUP_DIR), `main/utils/logger.js`, `main/scripts/jest.setup.js`

- [x] **Step 1: Failing test**

```js
// main/utils/paths.test.js
// Every module that writes files derived its own `../data/users`; under jest
// that meant test receipts landed in the REAL data folder (and, because the
// deploy script runs the suite on the box, in production data).
const path = require('path');
const paths = require('./paths');

test('DATA_DIR is honoured, and defaults to main/data', () => {
  expect(paths.DATA_DIR).toBe(process.env.DATA_DIR);            // jest.setup points it at a temp dir
  expect(paths.usersDir()).toBe(path.join(process.env.DATA_DIR, 'users'));
  expect(paths.userDir('u1')).toBe(path.join(process.env.DATA_DIR, 'users', 'u1'));
  expect(paths.backupsDir()).toBe(path.join(process.env.DATA_DIR, 'backups'));
});

test('under jest the data dir is a temp dir, never the repo', () => {
  expect(paths.DATA_DIR.startsWith(require('os').tmpdir())).toBe(true);
});

test('the stores write under it', () => {
  const rs = require('./receipt-store').forUser('paths-user');
  const name = rs.save('r1', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
  expect(rs.getPath(name).startsWith(paths.userDir('paths-user'))).toBe(true);
});
```
- [x] **Step 2:** `npx jest main/utils/paths.test.js` → FAIL (module missing).
- [x] **Step 3:** `paths.js`:

```js
const path = require('path');
// Where runtime data lives. Overridable so tests (jest.setup.js) and a
// migration to another disk never touch main/data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const usersDir   = () => path.join(DATA_DIR, 'users');
const userDir    = userId => path.join(usersDir(), String(userId));
const backupsDir = () => path.join(DATA_DIR, 'backups');
module.exports = { DATA_DIR, usersDir, userDir, backupsDir };
```
Replace each `path.join(__dirname, '../data/users')` with `require('../utils/paths').usersDir()` (evaluated at require time is fine: `const BASE_DIR = usersDir();`). `migrate.js:54`: `path.join(usersDir(), String(r.user_id), 'receipts', r.receipt_file)`. `backup.js`: `const BACKUP_DIR = backupsDir();`. `jest.setup.js` top:

```js
// Tests must never write into the real data folder or the real logs.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'xero-test-'));
process.env.LOG_LEVEL = 'silent';
```
`logger.js`: under `NODE_ENV === 'test'` use `transports: [new winston.transports.Console({ silent: true })]` (no file transports). `db/index.js` already uses `:memory:` under test.
- [x] **Step 4:** `npm test` → PASS; `ls main/data/users` gains no new `*@test.com`-era directories. Commit: `test: data and logs go to a temp dir under jest — never main/data or logs/`.

---

### Task 2: Backups verify themselves; a pull script brings them off the box

**Files:** `main/db/backup.js`, `main/db/backup.test.js` (new), `main/scripts/backup-pull.sh` (new), `package.json` scripts

- [x] **Step 1: Failing test**

```js
// main/db/backup.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const Database = require('better-sqlite3');
const { run, KEEP_COUNT } = require('./backup');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const db  = new Database(path.join(dir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  return { dir, db };
}

test('a backup is one portable file that passes integrity_check and holds the data', async () => {
  const { dir, db } = tempDb();
  const dest = await run({ db, destDir: path.join(dir, 'backups') });
  expect(fs.existsSync(dest)).toBe(true);
  expect(fs.existsSync(`${dest}-wal`)).toBe(false);
  const copy = new Database(dest, { readonly: true });
  expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(copy.prepare('SELECT v FROM t').get().v).toBe('hello');
});

test('only the newest KEEP_COUNT backups are kept', async () => {
  const { dir, db } = tempDb();
  const destDir = path.join(dir, 'backups');
  fs.mkdirSync(destDir);
  for (let i = 0; i < KEEP_COUNT + 3; i++) fs.writeFileSync(path.join(destDir, `app-2026-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.db`), '');
  await run({ db, destDir });
  expect(fs.readdirSync(destDir).filter(f => f.endsWith('.db'))).toHaveLength(KEEP_COUNT);
});

test('a copy that fails integrity_check is deleted and reported', async () => {
  const { dir, db } = tempDb();
  const destDir = path.join(dir, 'backups');
  const bad = { backup: async dest => fs.writeFileSync(dest, 'not a database'), path: '/x/app.db' };
  await expect(run({ db: bad, destDir })).rejects.toThrow(/integrity/);
  expect(fs.readdirSync(destDir).filter(f => f.endsWith('.db'))).toHaveLength(0);
});
```
- [x] **Step 2:** FAIL (`run` takes no options; KEEP_COUNT not exported).
- [x] **Step 3:** `backup.js` — `async function run({ db: source = db, destDir = backupsDir() } = {})`: create dir, `await source.backup(dest)`, open the copy, `journal_mode = DELETE`, `integrity_check`; on anything but `ok` unlink and throw `new Error(\`Backup failed integrity_check: ${result}\`)`; prune; return `dest`. Export `{ run, KEEP_COUNT }`. CLI tail unchanged (exit code 1 on failure). `backup-pull.sh`: 

```bash
#!/usr/bin/env bash
# Copies the newest DB backup, the per-user files and .env from the VM to
# ~/xero-backups/<timestamp>/ — the full set a restore needs (see docs/RUNBOOK.md).
set -euo pipefail
INSTANCE="${DEPLOY_INSTANCE:-xero-automation}"; ZONE="${DEPLOY_ZONE:-us-central1-a}"
APP="${DEPLOY_PATH:-/home/weika/xero-invoice-app}"; RUNAS="${DEPLOY_USER:-weika}"
DEST="${BACKUP_DEST:-$HOME/xero-backups}/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
mkdir -p "$DEST"
gcloud compute ssh "$INSTANCE" --zone="$ZONE" --command="sudo -u $RUNAS -H bash -lc 'cd $APP && node main/db/backup.js >/dev/null && tar czf /tmp/xero-backup.tgz -C main/data backups/\$(ls -t main/data/backups | head -1) users -C .. .env && sudo chmod 644 /tmp/xero-backup.tgz'"
gcloud compute scp "$INSTANCE:/tmp/xero-backup.tgz" "$DEST/" --zone="$ZONE"
gcloud compute ssh "$INSTANCE" --zone="$ZONE" --command="rm -f /tmp/xero-backup.tgz"
tar tzf "$DEST/xero-backup.tgz" | head -5
echo "✓ backup set in $DEST"
```
`package.json`: `"backup:pull": "bash main/scripts/backup-pull.sh"`.
- [x] **Step 4:** `npx jest main/db/backup.test.js` → PASS. Commit: `feat(backup): the copy verifies itself; npm run backup:pull brings the full set off the box`.

---

### Task 3: Health reports the running commit; fatal exits notify

**Files:** `main/routes/dashboard.js` (health), `main/index.js:1-14`, test `main/routes/dashboard.test.js` (new)

- [x] **Step 1: Failing test**

```js
// main/routes/dashboard.test.js
const request = require('supertest');
const express = require('express');
const { serverFor } = require('../scripts/test-server');

test('health names the running commit, so a deploy can prove what is live', async () => {
  const app = express();
  app.get('/dashboard/health', require('./dashboard').health);
  const { body } = await request(serverFor(app)).get('/dashboard/health').expect(200);
  expect(body.status).toBe('healthy');
  expect(body.commit).toMatch(/^[0-9a-f]{7,40}$/);
});
```
- [x] **Step 2:** FAIL (no `commit`).
- [x] **Step 3:** dashboard.js: at module load `const COMMIT = process.env.DEPLOY_SHA || (() => { try { return require('child_process').execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; } })();` and `res.json({ status: 'healthy', commit: COMMIT, timestamp })`. index.js fatal handlers: before `process.exit(1)`, `try { require('./utils/notify').notifyError({ context: 'FATAL — process exiting', error: msg }).catch(() => {}) } catch {}` with `setTimeout(() => process.exit(1), 1500).unref()` instead of an immediate exit so the webhook has a moment (keep the immediate exit path for EADDRINUSE).
- [x] **Step 4:** PASS. Commit: `feat(ops): health reports the running commit; a fatal exit tells Slack why`.

---

### Task 4: Deleted users take their files with them; the 500-row cap goes

**Files:** `main/routes/admin.js` (DELETE /users/:id), `main/utils/invoice-store.js:216-221`, tests `main/routes/admin.test.js`, `main/utils/invoice-store.test.js:105`

- [x] **Step 1: Failing tests** — admin.test.js:

```js
  test('DELETE /users/:id removes the user\'s files as well as the rows', async () => {
    const fs = require('fs'), path = require('path');
    const target = await users.createUser('bye@test.com', 'password123', 'user');
    const dir = require('../utils/paths').userDir(target.id);
    fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'receipts', 'r.jpg'), 'x');
    await request(serverFor(app)).delete(`/api/admin/users/${target.id}`).set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(200);
    expect(fs.existsSync(dir)).toBe(false);
  });
```
invoice-store.test.js — replace the cap test with:
```js
  test('no silent cap: a 505th invoice does not evict the first (posted rows were being deleted)', () => {
    const store = invoiceStore.forUser(userId);
    for (let i = 0; i < 505; i++) store.add(baseInvoice({ id: `bulk-${i}` }));
    expect(store.count()).toBe(505);
    expect(store.getById('bulk-0')).not.toBeNull();
  });
```
- [x] **Step 2:** FAIL.
- [x] **Step 3:** admin.js after `deleteUser(id)`: `try { fs.rmSync(require('../utils/paths').userDir(id), { recursive: true, force: true }); } catch (err) { logger.warn('Could not remove deleted user\'s files', { id, error: err.message }); }`. invoice-store.js: delete the `DELETE FROM invoices … LIMIT ?` block and the `MAX` constant (comment why: it evicted posted rows — the only guard against re-posting — and orphaned their files).
- [x] **Step 4:** PASS. Commit: `fix(data): a deleted user's files go with the rows; the 500-row cap that evicted posted invoices is gone`.

---

### Task 5: CI on Node 22, and a deploy that waits for it, installs from the lockfile, backs up, reloads with backoff, proves the commit, and tags

**Files:** `.github/workflows/ci.yml` (new), `ecosystem.config.js` (new), `main/scripts/deploy.sh`

- [x] **Step 1:** `ci.yml`:

```yaml
name: ci
on:
  push: { branches: [master] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm test
      - run: npm --prefix ui ci
      - run: npm run build:ui
```
- [x] **Step 2:** `ecosystem.config.js`:

```js
// pm2 process definition, committed so restart policy is not a setting that
// lives only in one server's pm2 dump. Backoff stops a crash loop from
// restarting hundreds of times a minute; max_restarts stops it entirely
// until someone looks. deploy.sh runs `pm2 startOrReload` on this file.
module.exports = {
  apps: [{
    name: 'xero-invoice-app',
    script: 'main/index.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    exp_backoff_restart_delay: 1000,
    max_restarts: 10,
    min_uptime: '10s',
    kill_timeout: 8000,
    env: { NODE_ENV: 'production' },
  }],
};
```
- [x] **Step 3:** `deploy.sh` changes (keep everything else):
  - after "clean and pushed": CI gate —
    ```bash
    if command -v gh >/dev/null && [ "${SKIP_CI:-0}" != "1" ]; then
      RUN_ID=$(gh run list --commit "$LOCAL_SHA" --workflow ci --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
      [ -z "$RUN_ID" ] && { sleep 15; RUN_ID=$(gh run list --commit "$LOCAL_SHA" --workflow ci --json databaseId -q '.[0].databaseId' 2>/dev/null || true); }
      if [ -n "$RUN_ID" ]; then
        info "CI run $RUN_ID — waiting"
        gh run watch "$RUN_ID" --exit-status >/dev/null || die "CI is red for $LOCAL_SHA — fix it before deploying (SKIP_CI=1 to override)"
        grn "  ✓ CI green"
      else
        red "  ! no CI run found for $LOCAL_SHA (workflow not yet on master?) — continuing"
      fi
    fi
    ```
  - Building: `remote 'npm ci 2>&1 | tail -1'`; `remote 'npm --prefix ui ci 2>&1 | tail -1'`; tests unchanged (now harmless: DATA_DIR/LOG_LEVEL under jest); build: `BUILD=$(remote 'cd ui && npx vite build 2>&1 | tail -3'); echo "$BUILD" | grep -q 'built in' || die "UI build failed: $BUILD"`.
  - Before restart: `remote 'node main/db/backup.js 2>&1 | tail -1' | sed 's/^/    /'` and die if it prints "Backup failed".
  - Restart: `remote 'DEPLOY_SHA='"$LOCAL_SHA"' pm2 startOrReload ecosystem.config.js --update-env >/dev/null 2>&1 && pm2 save >/dev/null 2>&1; sleep 7; pm2 list | grep xero-invoice-app'`. One-time cutover from the bare process: if `remote 'pm2 jlist' | grep -q '"exp_backoff_restart_delay":1000'` is false after reload, do `pm2 delete xero-invoice-app; pm2 start ecosystem.config.js; pm2 save`.
  - Health: parse `commit` from the health JSON and `die` unless it equals `$LOCAL_SHA`.
  - Cron: `remote '(crontab -l 2>/dev/null | grep -v "main/db/backup.js"; echo "0 19 * * * cd '"$APP"' && node main/db/backup.js >> logs/backup.log 2>&1") | crontab -'` (19:00 UTC = 03:00 Singapore).
  - Tag: `git tag -f "deploy/$(date -u +%Y%m%d-%H%M%S)" "$LOCAL_SHA" && git push -q origin --tags`.
- [x] **Step 4:** `bash -n main/scripts/deploy.sh`; `node -e "require('./ecosystem.config.js')"`. Commit: `ops: CI on Node 22; deploy waits for it, installs from the lockfile, backs up, reloads with backoff, proves the commit, tags`.

---

### Task 6: Env example, ignore rules, leftovers, runbook

**Files:** `main/.env.example`, `.gitignore`, `docs/RUNBOOK.md` (new), delete `main/index.js.bak`; `main/.env.bak` only if identical to `.env`'s values

- [x] **Step 1:** `.env.example`: drop `IMAP_HOST/PORT/USER/PASS`, `IMAP_POLL_INTERVAL_MS`, `XERO_CLIENT_SECRET` (per-user in Setup; code never reads them); add with one-line comments: `HOST` (bind address, default 127.0.0.1 in production), `FRONTEND_URL` (dev UI origin for the OAuth redirect), `DB_PATH`, `DATA_DIR`, `LOGS_DIR`, `LOG_LEVEL`, `ZERO_TAX_RATE`. Find the remaining `process.env.REDIS_URL` reader and remove it.
- [x] **Step 2:** `.gitignore`: add `.claude/settings.local.json`; `git rm --cached .claude/settings.local.json`.
- [x] **Step 3:** `rm main/index.js.bak`. Compare `main/.env.bak` keys with `.env` (values equal?) — if every key in `.env.bak` has the same value in `.env`, `rm main/.env.bak`; otherwise leave it and report.
- [x] **Step 4:** `docs/RUNBOOK.md`: backup set (app.db, `main/data/users`, `.env` with `ENCRYPTION_KEY`), schedule (03:00 SGT cron; `npm run backup:pull` for an off-box copy), restore (stop pm2, copy app.db over, delete `-wal/-shm`, restore users dir and .env, start), rollback (`git checkout <deploy tag>` on the box + `pm2 reload`), keys (where `JWT_SECRET`/`ENCRYPTION_KEY` live, what losing each means), health URL and what `commit` means, CI and `SKIP_CI=1`.
- [x] **Step 5:** Commit: `docs(ops): runbook; env example matches the code; personal settings untracked; stale backups removed`.

---

### Finish

- [x] `npm test` (local, gated), push, `npm run deploy` (first deploy exercises the CI wait, the pre-restart backup, the ecosystem cutover, the commit check, the cron install and the tag).
- [x] `npm run backup:pull` once to prove the off-box path.
