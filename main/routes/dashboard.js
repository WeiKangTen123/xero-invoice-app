const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const router     = express.Router();

// The commit this process is running. deploy.sh sets DEPLOY_SHA when it
// starts the process; otherwise the checkout is asked once. Health reports it
// so a deploy can prove the RUNNING process is on the shipped commit, not
// only that the files on disk are.
const COMMIT = process.env.DEPLOY_SHA || (() => {
  try {
    return require('child_process')
      .execSync('git rev-parse HEAD', { cwd: require('path').join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return 'unknown'; }
})();

// Below these the box is close enough to full that a backup, a log rotation
// or a batch of receipts could be the write that fails. Either one warns: 1GB
// is little on any disk, and 10% is little on a small one.
const MIN_FREE_BYTES   = 1024 ** 3;
const MIN_FREE_RATIO   = 0.10;
// deploy.sh installs a daily backup cron and backs up before every restart,
// so a newest backup older than a day and a half means the cron is not running.
const MAX_BACKUP_HOURS = 36;

// Each check returns its finding and, when something needs a person, a
// warning. Only the database can make the server unhealthy: without it no
// request can be served. A full disk or a stale backup is urgent but the app
// still works, and a 503 for it would fail a deploy that has nothing wrong
// with the code being shipped.
function _checkDatabase() {
  try {
    // Required here, not at the top: a database that failed to open throws
    // from the require, and that is a finding to report, not a crash.
    require('../db').prepare('SELECT 1').get();
    return { ok: true };
  } catch (err) {
    require('../utils/logger').error('Health check: database query failed', { error: err.message });
    // The code (SQLITE_CORRUPT, SQLITE_CANTOPEN …) and not the message: this
    // endpoint is public, and a message can carry a filesystem path.
    return { ok: false, error: err.code || 'query failed' };
  }
}

function _checkDisk(dir) {
  try {
    const s = fs.statfsSync(dir);
    const free = s.bavail * s.bsize, total = s.blocks * s.bsize;
    const freePercent = total ? Math.round((free / total) * 1000) / 10 : null;
    const low = free < MIN_FREE_BYTES || (total > 0 && free / total < MIN_FREE_RATIO);
    return {
      ok: !low, freeBytes: free, totalBytes: total, freePercent,
      warning: low ? `Low disk space on the data volume: ${(free / 1024 ** 3).toFixed(1)}GB free (${freePercent}%)` : undefined,
    };
  } catch (err) {
    return { ok: false, warning: `Could not read free disk space (${err.code || 'error'})` };
  }
}

function _checkBackup(dir, now) {
  let newest = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      // The names backup.js writes; anything else in the folder is not a backup.
      if (!f.startsWith('app-') || !f.endsWith('.db')) continue;
      const mtime = fs.statSync(path.join(dir, f)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file: f, mtime };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, warning: `Could not read the backups folder (${err.code || 'error'})` };
  }
  if (!newest) return { ok: false, warning: 'No database backup found' };
  const ageHours = Math.round(((now - newest.mtime) / 3600000) * 10) / 10;
  const stale = ageHours > MAX_BACKUP_HOURS;
  return {
    ok: !stale, newest: newest.file, ageHours,
    warning: stale ? `Newest database backup is ${ageHours} hours old` : undefined,
  };
}

// GET /health — used by deployment health checks (no auth required). Exported
// alongside the router so index.js can also serve it at the legacy
// /dashboard/health path without duplicating the payload.
//
// status, commit and timestamp come first and keep their exact shape:
// deploy.sh greps the body for "healthy" and reads "commit" out of it with
// sed. Everything else is added after them. Synchronous on purpose — every
// check is a local call measured in microseconds, and a deploy's curl should
// not wait on anything slower.
function health(_req, res) {
  const { DATA_DIR, backupsDir } = require('../utils/paths');
  const now      = Date.now();
  const database = _checkDatabase();
  const disk     = _checkDisk(DATA_DIR);
  const backup   = _checkBackup(backupsDir(), now);
  const warnings = [disk.warning, backup.warning].filter(Boolean);
  delete disk.warning; delete backup.warning;
  res.status(database.ok ? 200 : 503).json({
    status: database.ok ? 'healthy' : 'unhealthy',
    commit: COMMIT,
    timestamp: new Date(now).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: { database, disk, backup },
    warnings,
  });
}

router.get('/health', health);

module.exports        = router;
module.exports.health = health;
