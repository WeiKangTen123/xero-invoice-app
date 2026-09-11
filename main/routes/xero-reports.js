const express          = require('express');
const router           = express.Router();
const jwt              = require('jsonwebtoken');
const { requireAuth, jwtSecret }  = require('../middleware/auth-middleware');
const budgetDoc        = require('../reports/budget-doc');
const budgetRender     = require('../reports/budget-render');
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

// GET /api/xero-reports/performance?force=
// Powers Dashboard -> Overview and Revenue. Composed from the budget-variance
// fetch plus a bank summary, so it needs no scope those two don't already have.
// ── Budget exports ───────────────────────────────────────────────────────────
// Two steps, the same shape as /api/invoices/:id/pdf-url: the browser cannot put
// an Authorization header on a plain navigation, so the authed call hands back a
// short-lived signed URL and the browser opens that.
//
// The token carries the whole request — tenant, report, period, format — rather
// than leaving them in the query where they could be edited to point at another
// organisation's figures after the token was issued.
const EXPORT_TOKEN_TTL = '5m';
const EXPORT_KINDS   = new Set(['grid', 'variance']);
const EXPORT_FORMATS = new Set(['pdf', 'xlsx']);

function issueExportToken(userId, spec) {
  return jwt.sign({ userId, ...spec, purpose: 'budget-export' }, jwtSecret(), { expiresIn: EXPORT_TOKEN_TTL });
}

function verifyExportToken(token) {
  const payload = jwt.verify(token, jwtSecret());
  if (payload.purpose !== 'budget-export') throw new Error('Token scope mismatch');
  return payload;
}

// Filenames must survive a Content-Disposition header, which cannot carry bytes
// above 0x7f, while still reading correctly for an organisation named in any
// script. Same both-forms approach as the invoice PDF route (RFC 5987).
function setDownloadName(res, base, ext) {
  const raw   = `${base}.${ext}`;
  const ascii = raw.replace(/[^\x20-\x7e]/g, '').replace(/"/g, "'").trim() || `export.${ext}`;
  res.setHeader('Content-Disposition',
    `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`);
}

router.get('/budget/export-url', requireAuth, async (req, res) => {
  try {
    const { tenantId } = _resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: 'No Xero organisation connected' });

    const kind   = String(req.query.kind || 'grid');
    const format = String(req.query.format || 'pdf');
    if (!EXPORT_KINDS.has(kind))     return res.status(400).json({ error: 'kind must be grid or variance' });
    if (!EXPORT_FORMATS.has(format)) return res.status(400).json({ error: 'format must be pdf or xlsx' });

    const month = kind === 'variance' ? String(req.query.month || 'ytd') : undefined;
    const token = issueExportToken(req.user.id, { tenantId, kind, format, month });
    res.json({ url: `/api/xero-reports/budget/export?token=${encodeURIComponent(token)}`, expiresIn: EXPORT_TOKEN_TTL });
  } catch (err) {
    logger.error('Budget export URL failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(500).json({ error: xeroErrMsg(err) });
  }
});

router.get('/budget/export', async (req, res) => {
  let spec;
  try {
    spec = verifyExportToken(String(req.query.token || ''));
  } catch (_) {
    return res.status(401).type('text/plain').send('This export link has expired. Please generate it again.');
  }

  try {
    const timezone = getUserConfig(spec.userId).TIMEZONE || DEFAULT_TIMEZONE;
    // Reads the same cached payload the screen renders, so an exported figure
    // and an on-screen one cannot disagree — and because it is already cached,
    // an export costs no additional Xero call.
    const data = await reports.getBudgetVariance(spec.userId, spec.tenantId, { timezone });

    const opts = { month: spec.month, generatedAt: Date.now() };
    const base = budgetDoc.exportFilename(spec.kind === 'variance' ? 'variance' : 'grid', data, opts);

    if (spec.format === 'xlsx') {
      const wb = spec.kind === 'variance'
        ? budgetRender.budgetVarianceWorkbook(data, opts)
        : budgetRender.budgetVsActualWorkbook(data, opts);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      setDownloadName(res, base, 'xlsx');
      await wb.xlsx.write(res);
      return res.end();
    }

    const definition = spec.kind === 'variance'
      ? budgetDoc.budgetVarianceDoc(data, opts)
      : budgetDoc.budgetVsActualDoc(data, opts);
    res.setHeader('Content-Type', 'application/pdf');
    setDownloadName(res, base, 'pdf');
    return budgetRender.streamPdf(definition, res);
  } catch (err) {
    logger.error('Budget export failed', { error: xeroErrMsg(err), userId: spec.userId, kind: spec.kind });
    if (!res.headersSent) res.status(500).type('text/plain').send('Could not build the export.');
  }
});

router.get('/performance', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });

    const timezone = getUserConfig(req.user.id).TIMEZONE || DEFAULT_TIMEZONE;
    const data = await reports.getPerformance(req.user.id, tenantId, {
      timezone, period: _periodFromQuery(req),
      cashFlow: req.query.cashFlow === 'true',
      customers: req.query.customers === 'true',
      force: req.query.force === 'true',
    });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Performance overview failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
  }
});

// GET /api/xero-reports/variance-insights?force=
// Gemini-written commentary on variances the server computed from Xero. Split
// from /performance deliberately: the dashboard paints from real figures first,
// and this arrives after, so an LLM outage or a missing API key can never delay
// or blank the numbers.
router.get('/variance-insights', requireAuth, async (req, res) => {
  try {
    const { tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false });

    const timezone = getUserConfig(req.user.id).TIMEZONE || DEFAULT_TIMEZONE;
    // Same period the figures used — otherwise the commentary describes months
    // the reader isn't looking at.
    const data = await reports.getVarianceInsights(req.user.id, tenantId, {
      timezone, period: _periodFromQuery(req),
      force:     req.query.force === 'true',        // re-pull from Xero
      reanalyse: req.query.reanalyse === 'true',    // re-run the model only
    });
    res.json({ connected: true, ...data });
  } catch (err) {
    logger.error('Variance insights failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
  }
});

// GET /api/xero-reports/narrative?preset=|from=&to=
// Three sentences joining up the alerts, written by Gemini from figures this
// server computed. Split from /performance for the same reason variance
// insights are: the dashboard paints from real numbers first, and this arrives
// after, so an LLM outage can never delay or blank the figures.
//
// Read-only. It proposes nothing and can act on nothing.
router.get('/narrative', requireAuth, async (req, res) => {
  try {
    const { tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, available: false });

    const timezone = getUserConfig(req.user.id).TIMEZONE || DEFAULT_TIMEZONE;
    const data = await reports.getFinancialNarrative(req.user.id, tenantId, {
      timezone, period: _periodFromQuery(req),
      force:     req.query.force === 'true',
      // Asking for another look must not re-download the ledger, which Xero
      // bills by the gigabyte.
      reanalyse: req.query.reanalyse === 'true',
    });
    res.json({ connected: true, ...data });
  } catch (err) {
    logger.error('Financial narrative failed', { error: xeroErrMsg(err), userId: req.user.id });
    // Never a hard failure: the card is an extra, not a figure.
    res.json({ connected: true, available: false, reason: 'error' });
  }
});

// GET /api/xero-reports/cash-flow?preset=|from=&to=
// Xero has no cash-flow-statement endpoint, so this is built from Bank Summary,
// Payments, Bank Transactions and Invoices. Every one of those is a read.
router.get('/cash-flow', requireAuth, async (req, res) => {
  try {
    const { tenants, tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, tenants: [] });

    const timezone = getUserConfig(req.user.id).TIMEZONE || DEFAULT_TIMEZONE;
    const data = await reports.getCashFlow(req.user.id, tenantId, {
      timezone, period: _periodFromQuery(req), force: req.query.force === 'true',
    });
    res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
  } catch (err) {
    logger.error('Cash flow failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
  }
});

// Either a named preset, or an explicit from/to span of any length.
function _periodFromQuery(req) {
  return (req.query.from && req.query.to)
    ? { from: req.query.from, to: req.query.to }
    : { preset: req.query.preset || req.query.window };
}

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
