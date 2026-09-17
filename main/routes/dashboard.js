const express    = require('express');
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

// GET /health — used by deployment health checks (no auth required). Exported
// alongside the router so index.js can also serve it at the legacy
// /dashboard/health path without duplicating the payload.
function health(_req, res) {
  res.json({ status: 'healthy', commit: COMMIT, timestamp: new Date().toISOString() });
}

router.get('/health', health);

module.exports        = router;
module.exports.health = health;
