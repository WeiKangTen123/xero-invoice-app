const express    = require('express');
const router     = express.Router();
const tokenCache = require('../utils/token-cache');
const { requireAuth } = require('../middleware/auth-middleware');
const logger     = require('../utils/logger');

// GET /dashboard — connected Xero orgs for the calling user
router.get('/', requireAuth, async (req, res) => {
  try {
    const tenants = await tokenCache.forUser(req.user.id).getAllTenants();
    res.json({
      status:  'ok',
      tenants: tenants.map(t => ({
        tenantId:   t.tenant_id,
        tenantName: t.tenant_name,
      }))
    });
  } catch (err) {
    logger.error('Dashboard fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /dashboard/health — used by deployment health checks (no auth required)
router.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

module.exports = router;
