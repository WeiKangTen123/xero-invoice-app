// The backup script had no test (it returned early under the in-memory test
// DB). It now takes the database and destination as arguments, verifies the
// copy with integrity_check, and prunes — all checkable on a temp file DB.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
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
  for (let i = 0; i < KEEP_COUNT + 3; i++) {
    fs.writeFileSync(path.join(destDir, `app-2026-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.db`), '');
  }
  await run({ db, destDir });
  expect(fs.readdirSync(destDir).filter(f => f.endsWith('.db'))).toHaveLength(KEEP_COUNT);
});

test('a copy that fails integrity_check is deleted and reported', async () => {
  const { dir } = tempDb();
  const destDir = path.join(dir, 'backups');
  const bad = { path: '/x/app.db', backup: async dest => fs.writeFileSync(dest, 'not a database') };
  await expect(run({ db: bad, destDir })).rejects.toThrow(/integrity/);
  expect(fs.readdirSync(destDir).filter(f => f.endsWith('.db'))).toHaveLength(0);
});
