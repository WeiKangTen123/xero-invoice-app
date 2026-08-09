const express         = require('express');
const router          = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const tokenCache       = require('../utils/token-cache');
const reports          = require('../xero/reports');
const { xeroErrMsg }   = require('../xero/xero-utils');
const logger            = require('../utils/logger');

// GET /api/xero-reports/summary — read-only financial snapshot for the "Xero
// Insights" tab. Reuses the same per-user token cache every other Xero call
// site already goes through — this route makes zero Xero API calls itself
// beyond what xero/reports.js does, and never writes anything.
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const tenants = tokenCache.getPersistedTenants(req.user.id);
    if (!tenants.length) {
      return res.json({ connected: false, tenants: [] });
    }

    const requested = req.query.tenantId;
    const tenantId   = (requested && tenants.some(t => t.tenantId === requested))
      ? requested
      : tenants[0].tenantId;

    const data = await reports.getSummary(req.user.id, tenantId, { force: req.query.force === 'true' });
    res.json({ ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Xero Insights summary failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(500).json({ error: xeroErrMsg(err) });
  }
});

module.exports = router;
