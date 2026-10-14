const express    = require('express');
const router     = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const tokenCache = require('../utils/token-cache');
const store      = require('../utils/cash-manager-store');
const logger     = require('../utils/logger');
const { getUserConfig, DEFAULT_TIMEZONE } = require('../utils/users');
const { isScopeError, xeroErrMsg } = require('../xero/xero-utils');
const cashMonthly = require('../xero/cash-monthly');

// What a person adds to or changes in the Cash Flow Manager: entries Xero
// does not know about, changes to single projected items, and which bank
// accounts count. Kept in this app's database, per Xero organisation; nothing
// here writes to Xero, and only the monthly forecast reads from it.
//
// The report (GET /api/xero-reports/cash-manager) is rebuilt from cached Xero
// reads and these rows on every request, so nothing here needs to clear any
// cache: an edit shows on the next load, and no edit costs a Xero call. The
// monthly forecast's cache is keyed on these rows for the same reason.
//
// Every request names its organisation, and it must be one this person has
// connected: the rows are keyed by it, and a tenant id typed by hand must not
// open a store, or read Xero, for an organisation that is not theirs.

// The organisation a request names, or null once the answer has been sent.
function _connectedTenant(req, res) {
  const tenantId = (req.body && req.body.tenantId) || req.query.tenantId;
  if (!tenantId || typeof tenantId !== 'string') {
    res.status(400).json({ error: 'tenantId is required' });
    return null;
  }
  if (!tokenCache.getPersistedTenants(req.user.id).some(t => t.tenantId === tenantId)) {
    res.status(403).json({ error: 'That Xero organisation is not connected to your account' });
    return null;
  }
  return tenantId;
}

function _tenant(req, res) {
  const tenantId = _connectedTenant(req, res);
  return tenantId ? store.forTenant(req.user.id, tenantId) : null;
}

// A value the store refused is the request's fault: 400 with what was wrong.
// Anything else is passed on to the error handler as a 500.
function _handle(fn) {
  return (req, res, next) => {
    try {
      const s = _tenant(req, res);
      if (!s) return;
      return fn(req, res, s);
    } catch (err) {
      if (store.isInputError(err)) return res.status(400).json({ error: err.message });
      logger.error('Cash manager edit failed', { error: err.message, userId: req.user?.id });
      return next(err);
    }
  };
}

// GET /api/cash-manager/entries?tenantId=
router.get('/entries', requireAuth, _handle((req, res, s) => res.json({ entries: s.listEntries() })));

// POST /api/cash-manager/entries { tenantId, direction, description, amount, date, frequency, endDate? }
router.post('/entries', requireAuth, _handle((req, res, s) => {
  const { direction, description, amount, date, frequency, endDate } = req.body || {};
  const entry = s.addEntry({ direction, description, amount, date, frequency, endDate }, { email: req.user.email });
  res.status(201).json({ entry });
}));

// PATCH /api/cash-manager/entries/:id { tenantId, ...fields }
router.patch('/entries/:id', requireAuth, _handle((req, res, s) => {
  const { direction, description, amount, date, frequency, endDate } = req.body || {};
  const entry = s.updateEntry(req.params.id, { direction, description, amount, date, frequency, endDate });
  if (!entry) return res.status(404).json({ error: 'No such entry' });
  res.json({ entry });
}));

// DELETE /api/cash-manager/entries/:id?tenantId=
router.delete('/entries/:id', requireAuth, _handle((req, res, s) => {
  if (!s.deleteEntry(req.params.id)) return res.status(404).json({ error: 'No such entry' });
  res.json({ ok: true });
}));

// PUT /api/cash-manager/overrides { tenantId, key, date?, amount?, excluded? }
// A field left out keeps what was set; null clears it. With nothing left set
// the override is removed and { override: null } answered.
router.put('/overrides', requireAuth, _handle((req, res, s) => {
  const { key, date, amount, excluded } = req.body || {};
  const override = s.setOverride(key, { date, amount, excluded }, { email: req.user.email });
  res.json({ override });
}));

// DELETE /api/cash-manager/overrides?tenantId=&key=
router.delete('/overrides', requireAuth, _handle((req, res, s) => {
  const key = (req.body && req.body.key) || req.query.key;
  store.validateKey(key);
  s.deleteOverride(key);
  res.json({ ok: true });
}));

// GET /api/cash-manager/bank-options?tenantId=
router.get('/bank-options', requireAuth, _handle((req, res, s) => res.json({ accounts: _bankOut(s.bankOptions()) })));

// PUT /api/cash-manager/bank-options { tenantId, accounts: { [accountId]: { included?, openingAdjustment?, overdraft? } } }
router.put('/bank-options', requireAuth, _handle((req, res, s) => {
  res.json({ accounts: _bankOut(s.setBankOptions((req.body || {}).accounts)) });
}));

// The options in the units the screen speaks; the cents stay inside.
function _bankOut(map) {
  const out = {};
  for (const [id, o] of Object.entries(map)) out[id] = { included: o.included, openingAdjustment: o.openingAdjustment, overdraft: o.overdraft };
  return out;
}

// ── The monthly forecast ────────────────────────────────────────────────────

// The span and the fill the request asks for, or the reason it cannot be had.
// Refused rather than clamped: past=40 is not a request for twelve months,
// and every month asked for is a Bank Summary call. An empty value is the
// default, as the report routes read one.
const SPAN = {
  past:   { min: 0, max: cashMonthly.PAST_MAX,   dflt: cashMonthly.PAST_DEFAULT },
  future: { min: 1, max: cashMonthly.FUTURE_MAX, dflt: cashMonthly.FUTURE_DEFAULT },
};
function _monthlyQuery(query) {
  const out = {};
  for (const [name, b] of Object.entries(SPAN)) {
    const v = query[name];
    if (v === undefined || v === '') { out[name] = b.dflt; continue; }
    if (typeof v !== 'string' || !/^\d{1,2}$/.test(v) || Number(v) < b.min || Number(v) > b.max) {
      return { error: `${name} must be a whole number from ${b.min} to ${b.max}` };
    }
    out[name] = Number(v);
  }
  const fill = query.fill === undefined || query.fill === '' ? 'budget' : query.fill;
  if (!cashMonthly.FILLS.includes(fill)) return { error: `fill must be one of ${cashMonthly.FILLS.join(', ')}` };
  out.fill = fill;
  return { span: out };
}

// The user's timezone, which decides what "today" and "this month" are. One
// Intl does not know is read as the default, as the report routes read it.
function _timezone(req) {
  const stored = getUserConfig(req.user.id).TIMEZONE;
  if (!stored) return DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat('en-US', { timeZone: stored }); return stored; } catch { return DEFAULT_TIMEZONE; }
}

// GET /api/cash-manager/monthly?tenantId=&past=6&future=6&fill=budget|none&force=
// The months before this one as they happened, this one, and the months ahead
// as the Cash Flow Manager expects them (xero/cash-monthly.js). Read-only
// towards Xero; the query is checked before any call is made.
router.get('/monthly', requireAuth, asyncHandler(async (req, res) => {
  const tenantId = _connectedTenant(req, res);
  if (!tenantId) return;
  const { span, error } = _monthlyQuery(req.query);
  if (error) return res.status(400).json({ error });
  try {
    const data = await cashMonthly.getCashMonthly(req.user.id, tenantId, {
      ...span, timezone: _timezone(req), force: req.query.force === 'true',
    });
    res.json({ ...data, tenantId });
  } catch (err) {
    logger.error('Monthly cash forecast failed', { error: xeroErrMsg(err), userId: req.user.id });
    res.status(isScopeError(err) ? 403 : 500).json({
      error: isScopeError(err)
        ? 'This needs a wider Xero connection than you have — reconnect in Setup to grant access to bank transactions and reports.'
        : xeroErrMsg(err),
    });
  }
}));

module.exports = router;
