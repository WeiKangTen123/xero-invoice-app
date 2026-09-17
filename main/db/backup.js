// Copies the live SQLite DB to data/backups/app-<timestamp>.db using better-sqlite3's
// online backup API (safe against a concurrently-open, concurrently-written DB —
// unlike a plain file copy, which can grab a half-written page mid-write). Prunes
// backups beyond KEEP_COUNT so this can't quietly fill the disk the way the old
// unrotated log files did.
//
// Scheduled by deploy.sh as a daily cron job on the box, and run by it before
// every restart. `npm run backup:pull` copies the newest backup, the per-user
// files and .env off the box — see docs/RUNBOOK.md for the restore.
//
// The copy is opened and checked with integrity_check before it counts: a
// backup that would not open is worse than none, because it looks like one.
//
// Usage: node db/backup.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const db       = require('./index');

const KEEP_COUNT = 14; // ~2 weeks of daily backups
const BACKUP_DIR = require('../utils/paths').backupsDir();

function _prune(dir) {
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('app-') && f.endsWith('.db'))
    .sort(); // ISO timestamps in the filename sort chronologically as strings
  const excess = files.length - KEEP_COUNT;
  for (const f of files.slice(0, Math.max(excess, 0))) {
    fs.unlinkSync(path.join(dir, f));
    console.log(`Pruned old backup ${f}`);
  }
}

// Returns the path of the verified backup. `db` and `destDir` are arguments
// so a test can back up a temp file database; production callers pass none.
async function run({ db: source = db, destDir = BACKUP_DIR } = {}) {
  if (source.path === ':memory:') {
    console.log('In-memory DB (test mode) — nothing to back up.');
    return null;
  }
  fs.mkdirSync(destDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest  = path.join(destDir, `app-${stamp}.db`);

  await source.backup(dest);

  // The backup inherits WAL mode from the source, which leaves -wal/-shm sidecar
  // files next to it — a backup isn't really "one file" until those are folded
  // back in. Switching the copy to DELETE mode checkpoints and removes them,
  // leaving a single portable .db file and letting _prune()'s filename filter
  // (which only tracks *.db) actually account for everything on disk.
  let result;
  try {
    const copy = new Database(dest);
    copy.pragma('journal_mode = DELETE');
    result = copy.pragma('integrity_check', { simple: true });
    copy.close();
  } catch (err) {
    result = err.message;
  }
  if (result !== 'ok') {
    try { fs.unlinkSync(dest); } catch {}
    throw new Error(`Backup failed integrity_check: ${result}`);
  }

  console.log(`Backed up DB to ${dest}`);
  _prune(destDir);
  return dest;
}

if (require.main === module) {
  run().catch(err => {
    console.error('Backup failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { run, KEEP_COUNT };
