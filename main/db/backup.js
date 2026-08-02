// Copies the live SQLite DB to data/backups/app-<timestamp>.db using better-sqlite3's
// online backup API (safe against a concurrently-open, concurrently-written DB —
// unlike a plain file copy, which can grab a half-written page mid-write). Prunes
// backups beyond KEEP_COUNT so this can't quietly fill the disk the way the old
// unrotated log files did.
//
// Not run automatically — schedule it externally, e.g. a daily cron job:
//   0 2 * * * cd /path/to/main && node db/backup.js >> logs/backup.log 2>&1
//
// Usage: node db/backup.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const db       = require('./index');

const KEEP_COUNT = 14; // ~2 weeks of daily backups
const BACKUP_DIR = path.join(__dirname, '../data/backups');

function _prune() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('app-') && f.endsWith('.db'))
    .sort(); // ISO timestamps in the filename sort chronologically as strings
  const excess = files.length - KEEP_COUNT;
  for (const f of files.slice(0, Math.max(excess, 0))) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`Pruned old backup ${f}`);
  }
}

async function run() {
  if (db.path === ':memory:') {
    console.log('In-memory DB (test mode) — nothing to back up.');
    return;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest  = path.join(BACKUP_DIR, `app-${stamp}.db`);

  await db.backup(dest);

  // The backup inherits WAL mode from the source, which leaves -wal/-shm sidecar
  // files next to it — a backup isn't really "one file" until those are folded
  // back in. Switching the copy to DELETE mode checkpoints and removes them,
  // leaving a single portable .db file and letting _prune()'s filename filter
  // (which only tracks *.db) actually account for everything on disk.
  const copy = new Database(dest);
  copy.pragma('journal_mode = DELETE');
  copy.close();

  console.log(`Backed up DB to ${dest}`);
  _prune();
}

if (require.main === module) {
  run().catch(err => {
    console.error('Backup failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { run };
