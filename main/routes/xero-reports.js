const express          = require('express');
const router           = express.Router();
const { requireAuth }  = require('../middleware/auth-middleware');
const tokenCache        = require('../utils/token-cache');
const reports           = require('../xero/reports');
const { xeroErrMsg, isScopeError } = require('../xero/xero-utils');
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

// GET /api/xero-reports/period?preset=day|week|month|year|all|custom&from=&to=
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

// GET /api/xero-reports/bank-transactions?accountId=&force=
// The statement view behind Banking's "View transactions" — needs
// accounting.banktransactions.read, so it 400s with a clear message for anyone
// still connected under the older, narrower scope list rather than a raw Xero
// 403 the user can't act on.
router.get('/bank-transactions', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });
    if (!req.query.accountId) return res.status(400).json({ error: 'accountId is required' });

    const data = await reports.getBankTransactions(req.user.id, tenantId, req.query.accountId, { force: req.query.force === 'true' });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Insights bank transactions failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
  }
});

// GET /api/xero-reports/profit-loss?from=&to=
router.get('/profit-loss', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });
    if (!req.query.from || !req.query.to) return res.status(400).json({ error: 'from and to dates are required' });

    const data = await reports.getProfitAndLoss(req.user.id, tenantId, { from: req.query.from, to: req.query.to, force: req.query.force === 'true' });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Insights P&L failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
  }
});

// GET /api/xero-reports/bank-summary?from=&to=
router.get('/bank-summary', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });
    if (!req.query.from || !req.query.to) return res.status(400).json({ error: 'from and to dates are required' });

    const data = await reports.getBankSummary(req.user.id, tenantId, { from: req.query.from, to: req.query.to, force: req.query.force === 'true' });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Insights bank summary failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
  }
});

// GET /api/xero-reports/budget-variance?force=
// The monthly actual/budget grid. Needs accounting.reports.budgetsummary.read,
// which is newer than the other report scopes — so anyone who hasn't reconnected
// since it was added gets the reconnect prompt rather than a raw Xero 401.
router.get('/budget-variance', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });

    const timezone = getUserConfig(req.user.id).TIMEZONE || DEFAULT_TIMEZONE;
    const data = await reports.getBudgetVariance(req.user.id, tenantId, { timezone, force: req.query.force === 'true' });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Budget vs Actual failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
  }
});

// A call outside the token's granted scopes — the situation for anyone who
// connected before these report/bank-transaction/payments scopes existed.
// Surface it as a clear reconnect prompt instead of a generic failure.
function _scopeAwareStatus(err) { return isScopeError(err) ? 403 : 500; }
function _scopeAwareMessage(err) {
  return isScopeError(err)
    ? 'This needs a wider Xero connection than you have — reconnect in Setup to grant access to bank transactions and reports.'
    : xeroErrMsg(err);
}

module.exports = router;
