const express          = require('express');
const router           = express.Router();
const jwt              = require('jsonwebtoken');
const { requireAuth, jwtSecret }  = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const budgetDoc        = require('../reports/budget-doc');
const budgetRender     = require('../reports/budget-render');
const tokenCache        = require('../utils/token-cache');
const reports           = require('../xero/reports');
const changeDetector    = require('../xero/change-detector');
const { _periodFromQueryParams, _isPeriodError, PeriodError } = require('../xero/periods');
// From the module itself rather than through reports.js: it is the query
// check, run before the report, and a test that replaces the reports must
// still have the real check in front of them.
const { _balanceQueryFromParams } = require('../xero/balance-sheet');
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
// A stored timezone Intl does not know (saved before Setup checked it, or by
// hand) is read as the default, said once in the log: left to the report, it
// threw inside every one, and one bad Setup value was a 500 on every tab.
const _unknownTimezones = new Set();
const tz = req => {
  const stored = getUserConfig(req.user.id).TIMEZONE;
  if (!stored) return DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat('en-US', { timeZone: stored }); return stored; } catch {}
  if (!_unknownTimezones.has(stored)) {
    _unknownTimezones.add(stored);
    logger.warn('Unknown timezone in Setup; reports use the default', { userId: req.user.id, timeZone: stored, fallback: DEFAULT_TIMEZONE });
  }
  return DEFAULT_TIMEZONE;
};
// `check` refuses a query the report cannot answer: it returns the reason, and
// the request is a 400 before any Xero call is made.
function report(label, fetch, { needs = [], check = null } = {}) {
  return asyncHandler(async (req, res) => {
    try {
      const { tenants, tenantId } = _resolveTenant(req);
      if (!tenantId) return res.json({ connected: false, tenants: [] });
      // Someone is looking at this company, so the change detector looks at it more often; a failure to note that must not cost the report.
      try { changeDetector.noteViewed(req.user.id, tenantId); } catch (err) { logger.warn('Could not note a report view', { error: err.message, userId: req.user.id }); }
      for (const q of needs) if (!req.query[q]) return res.status(400).json({ error: `${q} is required` });
      const refused = check && check(req);
      if (refused) return res.status(400).json({ error: refused });
      const data = await fetch(req, tenantId);
      res.json({ connected: true, ...data, tenants, activeTenantId: tenantId });
    } catch (err) {
      if (_isPeriodError(err)) return _periodRefused(res, label, req, err);
      logger.error(`${label} failed`, { error: xeroErrMsg(err), userId: req.user.id });
      res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
    }
  });
}

// A period the request should not have asked for is the caller's mistake, not a
// failure: 400 with what was wrong, logged quietly, and no Xero call made.
function _periodRefused(res, label, req, err) {
  logger.info(`${label}: period refused`, { userId: req.user.id, reason: err.message });
  return res.status(400).json({ error: err.message });
}

// GET /api/xero-reports/version?tenantId=
// Whether Xero has changed since the reports on screen were read: the page
// polls this and refetches when changedAt moves (xero/change-detector.js).
// One SQLite read and never a Xero call, so it is safe to ask every few
// seconds; index.js keeps it out of the access log for the same reason.
// `live` false with `liveReason` says why the company is not being watched
// (the journals scope, the connection, the daily allowance).
router.get('/version', requireAuth, asyncHandler(async (req, res) => {
  const { tenantId } = _resolveTenant(req);
  if (!tenantId) return res.json({ connected: false, tenantId: null, changedAt: null, changeReason: null, checkedAt: null, live: false, liveReason: null });
  // A page polling this is a page being looked at: it keeps the detector on
  // its two-minute cadence for this company, the way a report fetch does.
  // Otherwise a Dashboard left open fell to the idle cadence after ten
  // minutes and its "live" update arrived up to fifteen minutes late.
  try { changeDetector.noteViewed(req.user.id, tenantId); } catch (err) { logger.warn('Could not note a Dashboard view', { error: err.message }); }
  res.json({ connected: true, tenantId, ...changeDetector.version(req.user.id, tenantId) });
}));

router.get('/summary',       requireAuth, report('Insights summary',       (req, t) => reports.getSummary(req.user.id, t, { force: force(req), timezone: tz(req) })));
router.get('/accounts',      requireAuth, report('Insights accounts',      (req, t) => reports.getAccounts(req.user.id, t, { force: force(req) })));
router.get('/bank-accounts', requireAuth, report('Insights bank accounts', (req, t) => reports.getBankAccounts(req.user.id, t, { force: force(req) })));
// The statement view behind Banking's "View transactions" — needs
// accounting.banktransactions.read, so a scope error becomes a reconnect prompt.
router.get('/bank-transactions', requireAuth, report('Insights bank transactions',
  (req, t) => reports.getBankTransactions(req.user.id, t, req.query.accountId, { force: force(req) }), { needs: ['accountId'] }));
// The monthly actual/budget grid. Needs accounting.reports.budgetsummary.read.
// Takes the same ?preset= or ?from=&to= as the other reports, checked the same
// way; it used to take nothing, so the budget tabs were fixed to the current
// financial year.
router.get('/budget-variance', requireAuth, report('Budget vs Actual',
  (req, t) => reports.getBudgetVariance(req.user.id, t, { timezone: tz(req), force: force(req), period: _budgetPeriodFromQuery(req) })));
// The grid above checked against Xero another way: up to three read-only
// calls that use no comparison periods, compared line by line with the grid
// for the same period (see xero/budget-check.js). Same query as the grid, so
// what is checked is what is on screen. A failure to reach Xero is an error
// here, never an "agrees".
router.get('/budget-check', requireAuth, report('Budget check',
  (req, t) => reports.getBudgetCheck(req.user.id, t, { timezone: tz(req), force: force(req), period: _budgetPeriodFromQuery(req) })));
// GET /api/xero-reports/balance-sheet?preset=&month=&date=&compare=&periods=&basis=
// The Balance Sheet as at a month end, from Xero's Balance Sheet report, or —
// preset=today, or preset=date&date=YYYY-MM-DD — as at that day, built from
// the Trial Balance once that construction has been shown to agree with the
// report (xero/balance-sheet.js); `asAt.source` says which. Needs
// accounting.reports.balancesheet.read, and the Trial Balance scope for exact
// dates. Its query is not a period — a date named by a preset, a comparison
// and a basis — so it has its own check, which refuses anything the report
// cannot be asked for with a 400 before any Xero call, as the period check
// does for the other reports: a malformed date, one before 1990, and (once
// the reader's today is known) one after today.
router.get('/balance-sheet', requireAuth, report('Balance Sheet',
  (req, t) => reports.getBalanceSheet(req.user.id, t, { timezone: tz(req), force: force(req), ..._balanceQueryFromParams(req.query) })));
// The sheet above checked: Net Assets against the totals and every total
// against its lines from the payload itself, and for a month end the Bank
// section against the Bank Summary and every account against the Trial
// Balance, one read-only call each; an exact-date sheet carries the Trial
// Balance's agreement with the Balance Sheet at the last month end instead
// (see xero/balance-check.js). Same query as the sheet, so what is checked is
// what is on screen.
router.get('/balance-check', requireAuth, report('Balance check',
  (req, t) => reports.getBalanceCheck(req.user.id, t, { timezone: tz(req), force: force(req), ..._balanceQueryFromParams(req.query) })));
// Powers Dashboard -> Overview and Revenue. Composed from the budget-variance
// fetch plus a bank summary, so it needs no scope those two don't already have.
// ?compare=prior-year adds the same months last year (one more budget-variance
// report, which only the tabs that show it ask for); without it the payload is
// exactly what it was.
router.get('/performance', requireAuth, report('Performance overview',
  (req, t) => reports.getPerformance(req.user.id, t, {
    timezone: tz(req), period: _periodFromQuery(req),
    cashFlow: req.query.cashFlow === 'true', customers: req.query.customers === 'true', force: force(req),
    ..._compareFromQuery(req),
  })));
// GET /api/xero-reports/ageing?side=receivables|payables
// What is owed each way by days past due, and by contact with each contact's
// invoices. Built from the summary's invoice fetch and one paged read of
// unallocated credit notes, both cached: with the dashboard's summary loaded
// it costs at most the credit notes, and switching side or looking again costs
// nothing. Takes no period, as the summary takes none: it is "right now", aged
// to today in the user's timezone. Any other side, or none, is a 400.
const AGEING_SIDES = new Set(['receivables', 'payables']);
router.get('/ageing', requireAuth, report('Ageing',
  (req, t) => reports.getAgeing(req.user.id, t, { side: req.query.side, timezone: tz(req), force: force(req) }),
  { check: req => (AGEING_SIDES.has(req.query.side) ? null : 'side must be receivables or payables') }));
// GET /api/xero-reports/cash-manager
// The Cash Flow Manager (xero/cash-manager.js): today's bank balance and the
// next ninety days of money in and out, from the summary's open invoices, the
// Bank Summary, unallocated credit notes, approved repeating templates and
// payments dated after today, plus the entries and changes kept in this app
// (routes/cash-manager.js). Rebuilt on every request from cached reads, so an
// edit there shows here at once. Takes no period: it starts today, in the
// user's timezone.
router.get('/cash-manager', requireAuth, report('Cash manager',
  (req, t) => reports.getCashManager(req.user.id, t, { timezone: tz(req), force: force(req) })));
// The above checked: the opening balance against the Bank Summary per account,
// and the open invoices and bills against the ageing (xero/cash-manager-
// check.js). Reads what the tab has just read, so no Xero call of its own.
router.get('/cash-manager-check', requireAuth, report('Cash manager check',
  (req, t) => reports.getCashManagerCheck(req.user.id, t, { timezone: tz(req), force: force(req) })));
// Xero has no cash-flow-statement endpoint, so this is built from Bank Summary,
// Payments, Bank Transactions and Invoices. Every one of those is a read.
router.get('/cash-flow', requireAuth, report('Cash flow',
  (req, t) => reports.getCashFlow(req.user.id, t, { timezone: tz(req), period: _periodFromQuery(req), force: force(req) })));

// GET /api/xero-reports/variance-insights?force=
// Gemini-written commentary on variances the server computed from Xero. Split
// from /performance deliberately: the dashboard paints from real figures first,
// and this arrives after, so an LLM outage or a missing API key can never delay
// or blank the numbers. Its own shape: no tenant list.
router.get('/variance-insights', requireAuth, asyncHandler(async (req, res) => {
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
    if (_isPeriodError(err)) return _periodRefused(res, 'Variance insights', req, err);
    logger.error('Variance insights failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(_scopeAwareStatus(err)).json({ error: _scopeAwareMessage(err) });
  }
}));

// GET /api/xero-reports/narrative?preset=|from=&to=
// Three sentences joining up the alerts, written by Gemini from figures this
// server computed. Read-only. Never a hard failure: the card is an extra.
router.get('/narrative', requireAuth, asyncHandler(async (req, res) => {
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
    // The one failure that is not swallowed: a bad period is the request's
    // fault, and the same request gets a 400 from every other report.
    if (_isPeriodError(err)) return _periodRefused(res, 'Financial narrative', req, err);
    logger.error('Financial narrative failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.json({ connected: true, available: false, reason: 'error' });
  }
}));

// ── Budget exports ───────────────────────────────────────────────────────────
// Two steps, the same shape as /api/invoices/:id/pdf-url: the browser cannot put
// an Authorization header on a plain navigation, so the authed call hands back a
// short-lived signed URL and the browser opens that.
//
// The token carries the whole request — tenant, report, period, format — rather
// than leaving them in the query where they could be edited to point at another
// organisation's figures after the token was issued.
const EXPORT_TOKEN_TTL = '5m';
// 'balance' is the Balance Sheet tab's export and 'cashmanager' the Cash Flow
// Manager's; they ride on these two routes so the browser has one way of
// opening a signed report file.
// 'cashmonthly' is the Cash Flow Manager's Monthly view.
const EXPORT_KINDS   = new Set(['grid', 'variance', 'balance', 'cashmanager', 'cashmonthly']);
const EXPORT_FORMATS = new Set(['pdf', 'xlsx']);
// How far ahead a cash manager export reaches: the tab's three views.
const CASH_MANAGER_DAYS = new Set([30, 60, 90]);

// The Monthly view's span and fill, checked the way GET /api/cash-manager/monthly
// checks them (refused, not clamped: every past month is a Bank Summary call),
// so a link can never carry a span the screen's own request would refuse.
function _cashMonthlyFromQuery(query) {
  const cashMonthly = require('../xero/cash-monthly');
  const bounds = {
    past:   { min: 0, max: cashMonthly.PAST_MAX,   dflt: cashMonthly.PAST_DEFAULT },
    future: { min: 1, max: cashMonthly.FUTURE_MAX, dflt: cashMonthly.FUTURE_DEFAULT },
  };
  const out = {};
  for (const [name, b] of Object.entries(bounds)) {
    const v = query[name];
    if (v === undefined || v === '') { out[name] = b.dflt; continue; }
    if (typeof v !== 'string' || !/^\d{1,2}$/.test(v) || Number(v) < b.min || Number(v) > b.max) {
      throw new PeriodError(`${name} must be a whole number from ${b.min} to ${b.max}`);
    }
    out[name] = Number(v);
  }
  const fill = query.fill === undefined || query.fill === '' ? 'budget' : query.fill;
  if (!cashMonthly.FILLS.includes(fill)) throw new PeriodError(`fill must be one of ${cashMonthly.FILLS.join(', ')}`);
  out.fill = fill;
  return out;
}
// The answer to an export of a month that has not started. The screen cannot
// ask for one (its buttons are disabled), so this is for a link made by hand
// or signed before the check existed.
const MONTH_NOT_STARTED = 'That month has not started yet';

// How the reader has set the Balance Sheet out on the tab — account codes,
// zero-balance rows, decimals, the Change and % columns — none of which
// changes what Xero is asked for, so it travels beside the sheet's query
// rather than in it, and the file is laid out as the screen is. The defaults
// are the tab's. A value other than true or false is refused, as a bad value
// is everywhere in this file, rather than read as one of them.
const BALANCE_VIEW = Object.freeze({ codes: false, zeroRows: false, decimals: true, change: false });
function _balanceViewFromQuery(query) {
  const view = {};
  for (const [name, fallback] of Object.entries(BALANCE_VIEW)) {
    const v = query[name];
    if (v === undefined || v === '') { view[name] = fallback; continue; }
    if (v !== 'true' && v !== 'false') throw new PeriodError(`${name} must be true or false`);
    view[name] = v === 'true';
  }
  return view;
}

function issueExportToken(userId, spec) {
  return jwt.sign({ userId, ...spec, purpose: 'budget-export' }, jwtSecret(), { expiresIn: EXPORT_TOKEN_TTL });
}

function verifyExportToken(token) {
  const payload = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
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

router.get('/budget/export-url', requireAuth, asyncHandler(async (req, res) => {
  try {
    const { tenantId } = _resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: 'No Xero organisation connected' });

    const kind   = String(req.query.kind || 'grid');
    const format = String(req.query.format || 'pdf');
    if (!EXPORT_KINDS.has(kind))     return res.status(400).json({ error: 'kind must be cashmanager, cashmonthly, grid, variance or balance' });
    if (!EXPORT_FORMATS.has(format)) return res.status(400).json({ error: 'format must be pdf or xlsx' });

    // The cash manager takes no period, only how far ahead to show. Nothing
    // else to check before signing: the file is built from the same payload
    // the tab shows, for the day it is opened.
    if (kind === 'cashmanager') {
      const days = Number(req.query.days || 90);
      if (!CASH_MANAGER_DAYS.has(days)) return res.status(400).json({ error: 'days must be 30, 60 or 90' });
      const token = issueExportToken(req.user.id, { tenantId, kind, format, days });
      return res.json({ url: `/api/xero-reports/budget/export?token=${encodeURIComponent(token)}`, expiresIn: EXPORT_TOKEN_TTL });
    }

    // The Monthly view: its span and fill travel in the token, checked first.
    if (kind === 'cashmonthly') {
      const monthly = _cashMonthlyFromQuery(req.query);
      const token = issueExportToken(req.user.id, { tenantId, kind, format, monthly });
      return res.json({ url: `/api/xero-reports/budget/export?token=${encodeURIComponent(token)}`, expiresIn: EXPORT_TOKEN_TTL });
    }

    // The Balance Sheet's query is its own (a date, a comparison, a basis),
    // checked by its own gate; and the as-at date is checked against today
    // by fetching the report — the one the screen has just loaded, so it is
    // cached and costs no Xero call — before the link is signed, so a link
    // can never carry a month the sheet route would refuse.
    if (kind === 'balance') {
      const balance = _balanceQueryFromParams(req.query);
      const view    = _balanceViewFromQuery(req.query);
      await reports.getBalanceSheet(req.user.id, tenantId, { timezone: tz(req), ...balance });
      const token = issueExportToken(req.user.id, { tenantId, kind, format, balance, view });
      return res.json({ url: `/api/xero-reports/budget/export?token=${encodeURIComponent(token)}`, expiresIn: EXPORT_TOKEN_TTL });
    }

    const month  = kind === 'variance' ? String(req.query.month || 'ytd') : undefined;
    // The period on screen travels in the token, so the file is the report the
    // reader was looking at, not the current financial year.
    const period = _budgetPeriodFromQuery(req);
    // A month after the one in progress has nothing in it yet, so its export
    // would be a page of -100% lines. Checked against the report — the one the
    // screen behind the button has just loaded, so it is cached and costs no
    // Xero call — before the link is signed, as the period is.
    if (month && month !== 'ytd') {
      budgetDoc.resolveMonth(await reports.getBudgetVariance(req.user.id, tenantId, { timezone: tz(req), period }), month);
    }
    const token  = issueExportToken(req.user.id, { tenantId, kind, format, month, period });
    res.json({ url: `/api/xero-reports/budget/export?token=${encodeURIComponent(token)}`, expiresIn: EXPORT_TOKEN_TTL });
  } catch (err) {
    // Checked before a token is signed, so a link can never carry a period or
    // a month the report routes would refuse.
    if (_isPeriodError(err)) return _periodRefused(res, 'Budget export URL', req, err);
    if (budgetDoc.isMonthNotStarted(err)) return res.status(400).json({ error: MONTH_NOT_STARTED });
    logger.error('Budget export URL failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(500).json({ error: xeroErrMsg(err) });
  }
}));

router.get('/budget/export', asyncHandler(async (req, res) => {
  let spec;
  try {
    spec = verifyExportToken(String(req.query.token || ''));
  } catch (_) {
    return res.status(401).type('text/plain').send('This export link has expired. Please generate it again.');
  }

  try {
    const timezone = getUserConfig(spec.userId).TIMEZONE || DEFAULT_TIMEZONE;

    if (spec.kind === 'balance') {
      // Required here, not at the top: the document module is the Balance
      // Sheet's own, and if it is missing only this branch fails, not every
      // budget export with it.
      const { balanceSheetDefinition, balanceSheetWorkbook, balanceFilename } = require('../reports/balance-doc');
      const sheet = await reports.getBalanceSheet(spec.userId, spec.tenantId, { timezone, ...(spec.balance || {}) });
      // A link signed before the view travelled lays the file out the tab's
      // default way.
      const opts  = { timezone, ...BALANCE_VIEW, ...(spec.view || {}) };
      // The document module names the file; a name it gave with the
      // extension on is not given a second one by setDownloadName.
      const base  = String(balanceFilename(sheet, spec.format) || 'Balance Sheet').replace(new RegExp(`\\.${spec.format}$`, 'i'), '');
      if (spec.format === 'xlsx') {
        const wb = balanceSheetWorkbook(sheet, opts);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        setDownloadName(res, base, 'xlsx');
        await wb.xlsx.write(res);
        return res.end();
      }
      res.setHeader('Content-Type', 'application/pdf');
      setDownloadName(res, base, 'pdf');
      return budgetRender.streamPdf(balanceSheetDefinition(sheet, opts), res);
    }

    if (spec.kind === 'cashmanager') {
      // Required here, as the Balance Sheet's is: the document module is the
      // cash manager's own, and if it is missing only this branch fails.
      const { cashManagerDefinition, cashManagerWorkbook, cashManagerFilename } = require('../reports/cash-manager-doc');
      // The payload the tab renders, rebuilt from the same cached reads, so
      // the file and the screen agree and the export costs no Xero call.
      const payload = await reports.getCashManager(spec.userId, spec.tenantId, { timezone });
      const days = CASH_MANAGER_DAYS.has(Number(spec.days)) ? Number(spec.days) : 90;
      const opts = { timezone, days };
      const base = String(cashManagerFilename(payload, spec.format, days) || 'Cash Flow Manager').replace(new RegExp(`\\.${spec.format}$`, 'i'), '');
      if (spec.format === 'xlsx') {
        const wb = cashManagerWorkbook(payload, opts);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        setDownloadName(res, base, 'xlsx');
        await wb.xlsx.write(res);
        return res.end();
      }
      res.setHeader('Content-Type', 'application/pdf');
      setDownloadName(res, base, 'pdf');
      return budgetRender.streamPdf(cashManagerDefinition(payload, opts), res);
    }

    if (spec.kind === 'cashmonthly') {
      // The Monthly view's own document module, required here for the same
      // reason as the others; the payload is the one the view renders, from
      // the same cache, so the file and the screen agree.
      const { cashMonthlyDefinition, cashMonthlyWorkbook, cashMonthlyFilename } = require('../reports/cash-monthly-doc');
      const payload = await require('../xero/cash-monthly').getCashMonthly(spec.userId, spec.tenantId, { timezone, ...(spec.monthly || {}) });
      const opts = { timezone };
      const base = String(cashMonthlyFilename(payload, spec.format) || 'Monthly cash flow').replace(new RegExp(`\\.${spec.format}$`, 'i'), '');
      if (spec.format === 'xlsx') {
        const wb = cashMonthlyWorkbook(payload, opts);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        setDownloadName(res, base, 'xlsx');
        await wb.xlsx.write(res);
        return res.end();
      }
      res.setHeader('Content-Type', 'application/pdf');
      setDownloadName(res, base, 'pdf');
      return budgetRender.streamPdf(cashMonthlyDefinition(payload, opts), res);
    }

    // Reads the same cached payload the screen renders, so an exported figure
    // and an on-screen one cannot disagree — and because it is already cached,
    // an export costs no additional Xero call.
    const data = await reports.getBudgetVariance(spec.userId, spec.tenantId, { timezone, period: spec.period });

    // The reader's timezone travels with the request so "Generated" and "Figures
    // read from Xero" are stamped in it. They were formatted in the server's own
    // zone, which is UTC on the VM, beside "as of" dates in the organisation's.
    const opts = { month: spec.month, generatedAt: Date.now(), timezone };
    // The filename resolves the month first, so a month that has not started
    // is refused here, before any document is built (see the catch below).
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
    // A token signed before the period checks existed can still carry a period
    // they refuse; that is a stale link, not a server fault.
    if (_isPeriodError(err)) {
      if (!res.headersSent) res.status(400).type('text/plain').send(`This export link asks for a period that cannot be exported: ${err.message}`);
      return;
    }
    // Likewise a month that has not started: a link made by hand, or one
    // signed before the check above existed.
    if (budgetDoc.isMonthNotStarted(err)) {
      if (!res.headersSent) res.status(400).type('text/plain').send(MONTH_NOT_STARTED);
      return;
    }
    logger.error('Budget export failed', { error: xeroErrMsg(err), userId: spec.userId, kind: spec.kind });
    if (!res.headersSent) res.status(500).type('text/plain').send('Could not build the export.');
  }
}));

// Both helpers read the query through periods.js#_periodFromQueryParams, the
// one check every period-taking route shares: a known preset, the legacy
// YYYY-MM window, or a from/to range of at most MAX_PERIOD_MONTHS. Anything
// else throws a PeriodError, which the handlers answer with a 400 before any
// Xero call is made.

// A named preset or an explicit from/to range. Asking for nothing means
// financial year to date, the default the dashboards open on.
function _periodFromQuery(req) {
  return _periodFromQueryParams(req.query, { preset: 'fy-ytd' });
}

// The budget reports' period. Unlike _periodFromQuery, asking for nothing is
// passed on as no period, which getBudgetVariance resolves through
// periods.js#_resolveWindow to the whole financial year — not year to date,
// because a budget report that went from twelve months to nine without being
// asked would be a reporting error. An unrecognised preset used to reach
// _resolvePeriod and fall back to year to date, which was exactly that error;
// it is now refused instead.
function _budgetPeriodFromQuery(req) {
  return _periodFromQueryParams(req.query, undefined);
}

// The comparison /performance was asked for, as options to spread into the
// report's: { compare: 'prior-year' }, or nothing at all when none was asked
// for. Checked like a period, because it is one — last year's months, fetched
// from Xero — and refused the same way: an unknown value, or the parameter
// repeated, is a 400 before any Xero call, rather than quietly read as no
// comparison, which would leave the reader wondering where it went. An empty
// value counts as absent, as it does for a period.
const COMPARISONS = new Set(['prior-year']);
function _compareFromQuery(req) {
  const c = req.query.compare;
  if (c === undefined || c === '') return {};
  if (typeof c !== 'string' || !COMPARISONS.has(c)) {
    throw new PeriodError(`Unknown comparison "${String(c).slice(0, 40)}" — the one available is compare=prior-year`);
  }
  return { compare: c };
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
