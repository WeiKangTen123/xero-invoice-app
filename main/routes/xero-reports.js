const express          = require('express');
const router           = express.Router();
const { requireAuth }  = require('../middleware/auth-middleware');
const tokenCache        = require('../utils/token-cache');
const reports           = require('../xero/reports');
const { xeroErrMsg }    = require('../xero/xero-utils');
const { getUserConfig, DEFAULT_TIMEZONE } = require('../utils/users');
const logger             = require('../utils/logger');

// Every route here reads a user's own persisted Xero connection — no Xero API
// call happens at all if they haven't connected (returns connected:false
// instead of erroring), and nothing here ever writes to Xero.

// Resolves which tenant a request targets: an explicit ?tenantId= if the user
// actually has it connected, else their first connected org. Returns null
// (caller responds connected:false) if there's no connection at all yet.
function _resolveTenant(req) {
  const tenants = tokenCache.getPersistedTenants(req.user.id);
  if (!tenants.length) return { tenants: [] };
  const requested = req.query.tenantId;
  const tenantId  = (requested && tenants.some(t => t.tenantId === requested)) ? requested : tenants[0].tenantId;
  return { tenants, tenantId };
}

router.get('/summary', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });

    const data = await reports.getSummary(req.user.id, tenantId, { force: req.query.force === 'true' });
    res.json({ ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Insights summary failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(500).json({ error: xeroErrMsg(err) });
  }
});

// GET /api/xero-reports/period?preset=day|week|month|year|custom&from=&to=
// Invoiced-value trend for a date range, for the "monthly review" style view —
// distinct from /summary, which is always "right now" outstanding balances.
router.get('/period', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });

    const timezone = getUserConfig(req.user.id).TIMEZONE || DEFAULT_TIMEZONE;
    const data = await reports.getPeriod(req.user.id, tenantId, {
      preset: req.query.preset, from: req.query.from, to: req.query.to,
      timezone, force: req.query.force === 'true',
    });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    // Bad custom-range input (e.g. from-after-to) is a 400, not a Xero failure.
    const isInputError = /valid|must not be after/i.test(err.message || '');
    logger.warn('Insights period failed', { error: err.message, userId: req.user.id });
    res.status(isInputError ? 400 : 500).json({ error: isInputError ? err.message : xeroErrMsg(err) });
  }
});

router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });
    const data = await reports.getAccounts(req.user.id, tenantId, { force: req.query.force === 'true' });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Insights accounts failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(500).json({ error: xeroErrMsg(err) });
  }
});

router.get('/bank-accounts', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });
    const data = await reports.getBankAccounts(req.user.id, tenantId, { force: req.query.force === 'true' });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Insights bank accounts failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(500).json({ error: xeroErrMsg(err) });
  }
});

router.get('/contacts', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });
    const data = await reports.getContacts(req.user.id, tenantId, { force: req.query.force === 'true' });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Insights contacts failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(500).json({ error: xeroErrMsg(err) });
  }
});

module.exports = router;
