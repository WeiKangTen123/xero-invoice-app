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

// One shape for every report route: resolve the tenant, answer connected:false
// without touching Xero when there is none, check the query the report needs,
// call it, spread the result with the tenant list, and turn a scope error into
// a reconnect prompt. Twelve handlers used to repeat these ten lines with small
// drifts between them.
const force = req => req.query.force === 'true';
const tz    = req => getUserConfig(req.user.id).TIMEZONE || DEFAULT_TIMEZONE;
function report(label, fetch, { needs = [] } = {}) {
  return async (req, res) => {
    try {
      const { tenants, tenantId } = _resolveTenant(req);
      if (!tenantId) return res.json({ connected: false, tenants: [] });
      for (const q of needs) if (!req.query[q]) return res.status(400).json({ error: `${q} is required` });
      const data = await fetch(req, tenantId);
      res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
    } catch (err) {
      logger.error(`${label} failed`, { error: xeroErrMsg(err), userId: req.user.id });
      res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
    }
  };
}

router.get('/summary',       requireAuth, report('Insights summary',       (req, t) => reports.getSummary(req.user.id, t, { force: force(req) })));
router.get('/accounts',      requireAuth, report('Insights accounts',      (req, t) => reports.getAccounts(req.user.id, t, { force: force(req) })));
router.get('/bank-accounts', requireAuth, report('Insights bank accounts', (req, t) => reports.getBankAccounts(req.user.id, t, { force: force(req) })));
router.get('/contacts',      requireAuth, report('Insights contacts',      (req, t) => reports.getContacts(req.user.id, t, { force: force(req) })));
// The statement view behind Banking's "View transactions" — needs
// accounting.banktransactions.read, so a scope error becomes a reconnect prompt.
router.get('/bank-transactions', requireAuth, report('Insights bank transactions',
  (req, t) => reports.getBankTransactions(req.user.id, t, req.query.accountId, { force: force(req) }), { needs: ['accountId'] }));
// The monthly actual/budget grid. Needs accounting.reports.budgetsummary.read.
router.get('/budget-variance', requireAuth, report('Budget vs Actual',
  (req, t) => reports.getBudgetVariance(req.user.id, t, { timezone: tz(req), force: force(req) })));
// Powers Dashboard -> Overview and Revenue. Composed from the budget-variance
// fetch plus a bank summary, so it needs no scope those two don't already have.
router.get('/performance', requireAuth, report('Performance overview',
  (req, t) => reports.getPerformance(req.user.id, t, {
    timezone: tz(req), period: _periodFromQuery(req),
    cashFlow: req.query.cashFlow === 'true', customers: req.query.customers === 'true', force: force(req),
  })));
// Xero has no cash-flow-statement endpoint, so this is built from Bank Summary,
// Payments, Bank Transactions and Invoices. Every one of those is a read.
router.get('/cash-flow', requireAuth, report('Cash flow',
  (req, t) => reports.getCashFlow(req.user.id, t, { timezone: tz(req), period: _periodFromQuery(req), force: force(req) })));

// GET /api/xero-reports/variance-insights?force=
// Gemini-written commentary on variances the server computed from Xero. Split
// from /performance deliberately: the dashboard paints from real figures first,
// and this arrives after, so an LLM outage or a missing API key can never delay
// or blank the numbers. Its own shape: no tenant list.
router.get('/variance-insights', requireAuth, async (req, res) => {
  try {
    const { tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false });
    const data = await reports.getVarianceInsights(req.user.id, tenantId, {
      timezone: tz(req), period: _periodFromQuery(req),
      force:     force(req),                          // re-pull from Xero
      reanalyse: req.query.reanalyse === 'true',      // re-run the model only
    });
    res.json({ connected: true, ...data });
  } catch (err) {
    logger.error('Variance insights failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
  }
});

// GET /api/xero-reports/narrative?preset=|from=&to=
// Three sentences joining up the alerts, written by Gemini from figures this
// server computed. Read-only. Never a hard failure: the card is an extra.
router.get('/narrative', requireAuth, async (req, res) => {
  try {
    const { tenantId } = _resolveTenant(req);
    if (!tenantId) return res.json({ connected: false, available: false });
    const data = await reports.getFinancialNarrative(req.user.id, tenantId, {
      timezone: tz(req), period: _periodFromQuery(req),
      force:     force(req),
      // Asking for another look must not re-download the ledger, which Xero
      // bills by the gigabyte.
      reanalyse: req.query.reanalyse === 'true',
    });
    res.json({ connected: true, ...data });
  } catch (err) {
    logger.error('Financial narrative failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.json({ connected: true, available: false, reason: 'error' });
  }
});

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
