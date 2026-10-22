// What a deleted account leaves on disk. DELETE /api/admin/users/:id removes
// the account's folder (data/users/<id>/) after its rows, but a job that was
// already running for it — a mail being read, a receipt being saved — can
// finish a moment later and write the folder back, with nobody left to ever
// remove it. Accounts deleted before the route removed files at all left
// theirs behind too. This finds such folders and removes them: at boot,
// before the queue recoveries look through the folders, and once a day
// (jobs/account-retention.js).
//
// Conservative, since what it removes is receipts and invoice PDFs:
//   - only directories directly under the users folder (paths.usersDir), and
//     only those named as users.js names an account: a 13-digit creation time
//     in milliseconds, then 8 hex characters (the suffix came later; older
//     accounts are the time alone). Anything else there is not this sweep's.
//   - never a symbolic link or junction, and never through one: entries are
//     read without following links, each is checked again just before it
//     goes, and fs.rmSync removes a link inside a folder as a link.
//   - only a folder whose id has no users row.
//   - and not one that looks like a database restored from an older backup
//     (docs/RUNBOOK.md, Restore): a folder for an account created after every
//     account the database knows of, with no record of its deletion in the
//     admin events, is kept and reported rather than removed. Such a database
//     has never heard of the accounts made since it was taken, and their files
//     may be all that is left of them. An empty users table is the same case
//     taken to its end: every folder it has no record of deleting is kept.
//
// Never throws: a sweep that fails is a warning, and the next one tries again.
const fs     = require('fs');
const path   = require('path');
const db     = require('../db');
const paths  = require('./paths');
const logger = require('./logger');

// users.js createUser: `${Date.now()}${randomBytes(4).toString('hex')}`.
const ACCOUNT_ID = /^\d{13}(?:[0-9a-f]{8})?$/;

// When the account named by this id was created, from the id itself.
function _bornAt(id) {
  return Number(String(id).slice(0, 13));
}

// The accounts the database has, and the newest creation time among them.
function _accounts() {
  const rows = db.prepare('SELECT id, created_at FROM users').all();
  const ids = new Set(rows.map(r => String(r.id)));
  let newest = -Infinity;
  for (const r of rows) {
    const t = Date.parse(r.created_at || '');
    if (Number.isFinite(t) && t > newest) newest = t;
    if (ACCOUNT_ID.test(String(r.id)) && _bornAt(r.id) > newest) newest = _bornAt(r.id);
  }
  return { ids, newest };
}

// The ids an admin is recorded deleting (utils/audit-log.js, kept two years).
// An unreadable table is no record, which only makes the sweep keep more.
function _deletedIds() {
  try {
    return new Set(db.prepare("SELECT DISTINCT target_user_id AS id FROM admin_events WHERE action = 'user.delete' AND target_user_id IS NOT NULL")
      .all().map(r => String(r.id)));
  } catch (err) {
    logger.warn('Could not read which accounts were deleted; recent orphaned folders are kept', { error: err.message });
    return new Set();
  }
}

/**
 * Removes the data folders of accounts that no longer exist. Answers
 * { removed: [ids], kept: [ids] }, `kept` being the folders left alone as
 * newer than every account (see above). `usersDir` is for the tests.
 */
function sweepOrphanFolders({ usersDir = paths.usersDir() } = {}) {
  const result = { removed: [], kept: [] };
  try {
    let entries;
    try {
      entries = fs.readdirSync(usersDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return result;   // no account has written a file yet
      throw err;
    }
    const candidates = entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && ACCOUNT_ID.test(e.name));
    if (!candidates.length) return result;

    const { ids, newest } = _accounts();
    const orphans = candidates.map(e => e.name).filter(id => !ids.has(id));
    if (!orphans.length) return result;
    const deleted = _deletedIds();

    for (const id of orphans) {
      if (_bornAt(id) > newest && !deleted.has(id)) { result.kept.push(id); continue; }
      const dir = path.join(usersDir, id);
      try {
        // Checked again as it goes: the entry was read a moment ago.
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        // And the row, in case the account was made in that moment.
        if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        result.removed.push(id);
      } catch (err) {
        logger.warn('Could not remove the data folder of a deleted account', { id, error: err.message });
      }
    }

    if (result.removed.length) logger.info('Removed the data folders of deleted accounts', { ids: result.removed });
    if (result.kept.length) {
      logger.warn('Kept data folders with no account that are newer than every account: is this database a restored backup? '
        + 'Remove them by hand once they are not needed', { ids: result.kept });
    }
  } catch (err) {
    logger.warn('Sweep for the data folders of deleted accounts failed', { error: err.message });
  }
  return result;
}

module.exports = { sweepOrphanFolders, ACCOUNT_ID };
