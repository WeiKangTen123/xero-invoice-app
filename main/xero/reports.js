const { AccountingApi }  = require('xero-node');
const { withRetry, isScopeError } = require('./xero-utils');
const logger             = require('../utils/logger');

// Read-only financial data for the "Insights" tab. Every function here either
// takes already-fetched Xero data (pure, fully unit-tested, nothing to mock) or
// is the thin cached-fetch wrapper around it — same split as the rest of this
// file's original summary logic.
//
// Cached in-memory per user+tenant(+range), same philosophy as token-cache.js.
// Two reasons, and the second now dominates: Xero's 60-calls/minute budget is
// shared with real invoice submission, and since March 2026 Xero bills on the
// data volume of GET requests, so a dashboard nobody is actively watching is a
// line item rather than merely rude.
//
// Held at 90s while rate limiting was the only concern. Raised because these
// figures move on the order of a day, not a minute, and because the cost of
// being wrong is visible and self-correcting: the page renders "Synced Xs ago"
// from fetchedAt, and the refresh control passes force=true to bypass this
// entirely. Turn it back down here if you would rather pay for fresher numbers.
const CACHE_TTL_MS = 5 * 60 * 1000;
// The chart of accounts, bank accounts, contacts and the organisation record
// change rarely and cost a GET each; five minutes was the wrong TTL for them.
// `force` still bypasses.
const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000;
const _cache = new Map(); // arbitrary string key -> { data, fetchedAt }

// Expiry alone never freed anything: a stale entry failed the TTL check on read
// and was then left in place, so the map only ever grew. Every distinct
// user + tenant + range + report combination stayed resident with its full
// payload, on a process that runs for days at a time.
//
// Two mechanisms, because either alone leaves a hole. Dropping an entry when a
// read finds it stale costs nothing and handles anything still being looked at;
// the sweep handles what nobody reads again — a tenant disconnected, a date
// range visited once. The cap is the backstop for a burst of distinct keys
// arriving faster than they expire.
const CACHE_MAX_ENTRIES = 500;

function _isStale(entry, now) {
  return now - entry.fetchedAt >= (entry.ttl || CACHE_TTL_MS);
}

function _pruneCache() {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (_isStale(v, now)) _cache.delete(k);
  }
  if (_cache.size > CACHE_MAX_ENTRIES) {
    // Still over after dropping every stale entry: evict oldest first, which is
    // the least likely to be read again.
    const byAge = [..._cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (let i = 0, drop = _cache.size - CACHE_MAX_ENTRIES; i < drop; i++) _cache.delete(byAge[i][0]);
  }
}

// `noGrace`: a person asking the model to re-analyse expects a fresh answer
// however recent the last one is; the grace window is for Xero fetch chains.
function _cacheGet(key, force, { noGrace = false } = {}) {
  const cached = _cache.get(key);
  if (!cached) return null;
  // Per-entry TTL, defaulting to the short one. Report data is cheap to refetch
  // and should stay near-live; generated commentary costs an LLM call, so it
  // opts into a much longer life via _cacheSet's third argument.
  if (_isStale(cached, Date.now())) {
    _cache.delete(key);
    return null;
  }
  // A forced read is a person clicking Refresh, and several reports built on
  // one base fetch each forward it — so one click could refetch Budget-vs-
  // Actual five times. A force within the grace window of a fresh fetch
  // reuses it; only an entry older than that is bypassed.
  if (force && (noGrace || Date.now() - cached.fetchedAt > FORCE_GRACE_MS)) return null;
  return { ...cached.data, cached: true, fetchedAt: cached.fetchedAt };
}

function _cacheSet(key, data, ttl) {
  // Swept on write rather than on a timer: a timer on a module that may never be
  // used keeps a handle alive for nothing, and writes are exactly when the map
  // grows.
  if (_cache.size >= CACHE_MAX_ENTRIES) _pruneCache();
  _cache.set(key, { data, fetchedAt: Date.now(), ttl });
  return { ...data, cached: false, fetchedAt: Date.now() };
}

const FORCE_GRACE_MS = 10_000;

// Identical work in flight is shared, not repeated. The Insights page fires
// /performance, /variance-insights and /narrative together on first load, and
// each cache miss used to become its own chain of Xero GETs (and its own LLM
// call). Every cached fetcher below is bound through this, so callers inside
// this file share the same in-flight promise as callers outside it.
//
// Sharing only works if the same request always produces the same key, and a
// plain JSON.stringify did not: it follows property order, and the routes build
// { timezone, force, period } where the reports that call each other build
// { timezone, period, force }. Those missed each other and both went to Xero.
// So keys sort their properties and drop undefined ones (a fetcher reads an
// undefined option as its default anyway), and a fetcher that takes options can
// name its defaults: an option left out and the same option passed at its
// default are then one request, not two. The filled-in options are also what
// the fetcher receives, so the key can never describe a different request from
// the one actually run.
const _inflight = new Map();
function _canonical(v) {
  if (Array.isArray(v)) return v.map(_canonical);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = _canonical(v[k]);
    return out;
  }
  return v;
}
// Options are the third argument of every fetcher that names defaults.
function _withDefaults(args, defaults) {
  if (!defaults) return args;
  const [userId, tenantId, opts, ...rest] = args;
  return [userId, tenantId, { ...defaults, ..._canonical(opts || {}) }, ...rest];
}
function _dedupeKey(name, args) {
  return `${name}:${JSON.stringify(_canonical(args))}`;
}
function _dedupe(name, fn, defaults = null) {
  return function deduped(...given) {
    const args = _withDefaults(given, defaults);
    const key = _dedupeKey(name, args);
    let p = _inflight.get(key);
    if (!p) {
      p = Promise.resolve().then(() => fn.apply(this, args)).finally(() => _inflight.delete(key));
      _inflight.set(key, p);
    }
    return p;
  };
}

function _apiFor(token) {
  const api = new AccountingApi();
  api.accessToken = token;
  return api;
}

// ── Snapshot summary (Receivables/Payables/status — always "right now") ─────

// PAID invoices, and AUTHORISED ones already fully paid down to zero, both read
// as "paid" here — amountDue is the source of truth for what's actually owed,
// not just the coarse Xero status.
// Xero returns at most 100 invoices per page and `page=1` was never followed
// up, so every KPI built on invoices — receivables, overdue, DSO, the
// forecast, supplier spend — was computed on the 100 most recent. Pages until
// a short page; the cap is a safety net that logs when hit. Always summaryOnly:
// no caller here needs line items, and it keeps each page small.
const INVOICE_PAGE_SIZE = 100;
const INVOICE_MAX_PAGES = 20;
async function _allInvoices(api, tenantId, { where, order, statuses }) {
  const out = [];
  for (let page = 1; page <= INVOICE_MAX_PAGES; page++) {
    const res = await withRetry(() => api.getInvoices(
      tenantId, undefined, where, order, undefined, undefined, undefined,
      statuses, page, undefined, undefined, undefined, true,
    ));
    const batch = res.body.invoices || [];
    out.push(...batch);
    if (batch.length < INVOICE_PAGE_SIZE) return out;
  }
  logger.warn('Invoice fetch hit the page cap; figures may be incomplete', { tenantId, pages: INVOICE_MAX_PAGES });
  return out;
}

function _statusLabel(inv) {
  const amountDue = Number(inv.amountDue || 0);
  if (inv.status === 'PAID' || amountDue <= 0) return 'paid';
  if (inv.dueDate && new Date(inv.dueDate) < new Date()) return 'overdue';
  return 'awaiting';
}

// Buckets an outstanding invoice by how soon it's due — same shape as Xero's
// own "Invoices owed to you" / "Bills to pay" dashboard widgets (grouped into
// overdue, due this week, due soon, due later), just with fixed day windows
// instead of Xero's dynamic weekly columns, since those shift with "today".
function _agingBucketOf(dueDate) {
  if (!dueDate) return 'later';
  const days = Math.floor((new Date(dueDate) - new Date()) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'within7';
  if (days <= 30) return 'within30';
  return 'later';
}
function _emptyAging() {
  return { overdue: { count: 0, amount: 0 }, within7: { count: 0, amount: 0 }, within30: { count: 0, amount: 0 }, later: { count: 0, amount: 0 } };
}

// ── Currency ────────────────────────────────────────────────────────────────
// Base-currency conversion lives in ./currency. See the notes there: Xero
// reports return base currency and documents return their own, and summing
// the two without converting is silent and wrong.
const { _toBase, _foreignCurrency } = require('./currency');

// Date, month and period arithmetic — see ./periods. Re-exported below so
// callers and tests continue to reach them through this module.
const {
  _actualThroughIndex,
  _addDays,
  _chunkMonths,
  _closedCount,
  _dateFromParts,
  _fiscalYearMonths,
  _fmtISODate,
  _fmtXeroDate,
  _monthMeta,
  _monthsBetween,
  _monthsFrom,
  _parseISODate,
  _partsFromDate,
  _resolvePeriod,
  _resolveWindow,
  _toDateLabel,
  _todayPartsInTz,
} = require('./periods');

function _buildSummary(org, invoices) {
  let totalReceivables = 0, totalPayables = 0;
  let receivablesCount = 0, payablesCount = 0;
  // Overdue is kept per direction. It used to be one sum of every overdue
  // document, so a bill you were late paying was added to an invoice a customer
  // was late paying: two opposite positions netted into a figure that described
  // neither, and grew whenever you fell behind with a supplier.
  let overdueReceivables = 0, overduePayables = 0;
  let overdueReceivablesCount = 0, overduePayablesCount = 0;
  const statusBreakdown = { paid: 0, awaiting: 0, overdue: 0 };
  const aging = { receivables: _emptyAging(), payables: _emptyAging() };

  // Totals are in the org's base currency. Each row keeps its own currency
  // and face amount; the KPIs used to add USD to SGD and label the sum as base.
  const base = org.baseCurrency || '';
  const list = invoices.map(inv => {
    const isReceivable = inv.type === 'ACCREC';
    const amountDue     = Number(inv.amountDue || 0);
    const dueBase       = _toBase(inv, amountDue, base);
    const status         = _statusLabel(inv);
    statusBreakdown[status]++;
    if (status === 'overdue') {
      if (isReceivable) { overdueReceivables += dueBase; overdueReceivablesCount++; }
      else              { overduePayables    += dueBase; overduePayablesCount++; }
    }

    if (inv.status === 'AUTHORISED' && amountDue > 0) {
      if (isReceivable) { totalReceivables += dueBase; receivablesCount++; }
      else               { totalPayables    += dueBase; payablesCount++; }
      const bucket = aging[isReceivable ? 'receivables' : 'payables'][_agingBucketOf(inv.dueDate)];
      bucket.count++; bucket.amount += dueBase;
    }

    return {
      invoiceId:     inv.invoiceID,
      type:          isReceivable ? 'Sale' : 'Bill',
      contact:       inv.contact?.name || 'Unknown',
      invoiceNumber: inv.invoiceNumber || '',
      date:          inv.date || null,
      dueDate:       inv.dueDate || null,
      status,
      total:         Number(inv.total || 0),
      amountDue,
      currency:      inv.currencyCode || org.baseCurrency || '',
    };
  }).slice(0, 50); // recent-invoices table doesn't need the full org history

  return {
    connected: true,
    organisation: {
      name:     org.name || org.legalName || 'Organisation',
      country:  org.countryCode || '—',
      currency: org.baseCurrency || '—',
      yearEnd:  (org.financialYearEndDay && org.financialYearEndMonth)
        ? `${String(org.financialYearEndDay).padStart(2, '0')}/${String(org.financialYearEndMonth).padStart(2, '0')}`
        : '—',
    },
    kpis: {
      totalReceivables, totalPayables, receivablesCount, payablesCount,
      overdueReceivables, overduePayables, overdueReceivablesCount, overduePayablesCount,
      statusBreakdown,
    },
    aging,
    invoices: list,
    // What was invoiced and billed in each month, from every invoice fetched
    // rather than the fifty listed. getPerformance measures debtor and creditor
    // days from this and the totals above, so those need no invoice fetch of
    // their own.
    raisedByMonth: _raisedByMonth(invoices, base),
    currency: _foreignCurrency(invoices, base),
  };
}

async function _getSummaryRaw(userId, tenantId, { force = false } = {}) {
  const key    = `summary:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const [orgRes, invoices] = await Promise.all([
    withRetry(() => api.getOrganisations(tenantId)),
    _allInvoices(api, tenantId, { order: 'Date DESC', statuses: ['AUTHORISED', 'PAID'] }),
  ]);

  const data = _buildSummary(orgRes.body.organisations?.[0] || {}, invoices);
  logger.info('Insights summary fetched', { userId, tenantId, invoiceCount: data.invoices.length });
  return _cacheSet(key, data);
}

// Cached separately from getSummary's own org fetch (same underlying Xero
// call, but this one's only reached for the 'year' preset, and keeping it
// standalone avoids reshaping getSummary's existing parallel fetch).
async function _getOrganisationRaw(userId, tenantId, force) {
  const key    = `org:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached.org;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);
  const res = await withRetry(() => api.getOrganisations(tenantId));
  return _cacheSet(key, { org: res.body.organisations?.[0] || {} }, DIRECTORY_TTL_MS).org;
}

// ── Date-range engine (daily/weekly/monthly/yearly/custom) ──────────────────
// Everything here works in calendar dates (Y/M/D), never real instants — Xero's
// filter syntax (`DateTime(y,m,d)`) takes a plain calendar date with no
// timezone component, so day-boundary math never needs to resolve a UTC
// offset. "Today" itself is the one place a timezone actually matters (what
// counts as today depends on where the user is), resolved once via
// Intl.DateTimeFormat against the user's stored timezone preference.



// ── Chart of Accounts, Contacts, Bank Accounts ───────────────────────────────
// All three ride on scopes already granted for existing features — Accounts and
// TaxRates are both in the "settings" scope bucket (already used by
// xero/invoices.js#getOrgTaxRates), and Contacts already has full read/write
// access for invoice creation. Nothing here needed a wider OAuth consent.

function _buildAccounts(accounts) {
  return accounts.map(a => ({
    accountId: a.accountID, code: a.code || '', name: a.name || '',
    type: a.type || '', taxType: a.taxType || '', status: a.status || '',
  }));
}

async function _getAccountsRaw(userId, tenantId, { force = false } = {}) {
  const key    = `accounts:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getAccounts(tenantId, undefined, undefined, 'Code ASC'));
  const data = { accounts: _buildAccounts(res.body.accounts || []) };
  return _cacheSet(key, data, DIRECTORY_TTL_MS);
}

function _buildBankAccounts(accounts) {
  return accounts
    .filter(a => a.type === 'BANK')
    .map(a => ({
      accountId: a.accountID, code: a.code || '', name: a.name || '',
      accountNumber: a.bankAccountNumber || '', currency: a.currencyCode || '', status: a.status || '',
    }));
}

async function _getBankAccountsRaw(userId, tenantId, { force = false } = {}) {
  const key    = `bank:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getAccounts(tenantId, undefined, 'Type=="BANK"', 'Name ASC'));
  const data = { bankAccounts: _buildBankAccounts(res.body.accounts || []) };
  return _cacheSet(key, data, DIRECTORY_TTL_MS);
}

function _buildContacts(contacts) {
  return contacts.map(c => ({
    contactId: c.contactID, name: c.name || 'Unknown', email: c.emailAddress || '',
    isCustomer: !!c.isCustomer, isSupplier: !!c.isSupplier, status: c.contactStatus || '',
  }));
}

async function _getContactsRaw(userId, tenantId, { force = false } = {}) {
  const key    = `contacts:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getContacts(
    tenantId, undefined, undefined, 'Name ASC', undefined, undefined, undefined, true
  ));
  const data = { contacts: _buildContacts(res.body.contacts || []) };
  return _cacheSet(key, data, DIRECTORY_TTL_MS);
}

// ── Bank statement, Profit & Loss, Cash In/Out ───────────────────────────────
// Everything below needs the three wider scopes added alongside this feature
// (accounting.banktransactions.read, accounting.reports.profitandloss.read,
// accounting.reports.banksummary.read) — see xero/oauth.js for why that means
// a one-time reconnect for anyone already connected under the old scope list.

// Deleted and voided records are left off the statement, as the cash view
// leaves them out of its figures (see _isLive): they moved no money, and listed
// with a +/- amount they read as though they had.
//
// Every RECEIVE type is money in — RECEIVE-TRANSFER, RECEIVE-PREPAYMENT and
// RECEIVE-OVERPAYMENT included. Only plain RECEIVE used to be, so a transfer
// into this account or a customer's prepayment was printed as money out.
function _buildBankTransactions(transactions) {
  return transactions.filter(_isLive).map(t => ({
    transactionId: t.bankTransactionID,
    type:          /^RECEIVE/i.test(t.type || '') ? 'Money In' : 'Money Out',
    contact:       t.contact?.name || 'Unknown',
    reference:     t.reference || '',
    // xero-node returns a real Date object here (confirmed against a live
    // response) — unlike Invoices, where the same SDK returns a plain ISO
    // string for .date/.dueDate. Normalize to an ISO date string so the sort
    // below (and the frontend's formatDateTime) can treat every "date" field
    // the same way regardless of which endpoint it came from.
    date:          t.date ? new Date(t.date).toISOString().slice(0, 10) : null,
    total:         Number(t.total || 0),
    isReconciled:  !!t.isReconciled,
    status:        t.status || '',
    source:        'bank',
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// A bank account's real cash movement isn't fully captured by BankTransactions
// alone — confirmed against live data: paying a bill or receiving a customer
// payment against an invoice creates a Payment record instead, which never
// shows up in getBankTransactions at all. Which way each of paymentType's
// eight values moves money is decided by _isReceiptPayment, the rule the cash
// view uses too: the AR*/AP* variants are refunds, which run against their
// ledger, so a refund to a customer is money OUT even though it sits on the
// receivable side. Deleted payments are left off, as on the bank transactions.
function _buildPayments(payments) {
  return payments.filter(_isLive).map(p => ({
    transactionId: p.paymentID,
    type:          _isReceiptPayment(p) ? 'Money In' : 'Money Out',
    contact:       p.invoice?.contact?.name || 'Unknown',
    reference:     p.reference || (p.invoice?.invoiceNumber ? `Payment - ${p.invoice.invoiceNumber}` : 'Payment'),
    date:          p.date ? new Date(p.date).toISOString().slice(0, 10) : null,
    total:         Number(p.amount || 0),
    isReconciled:  !!p.isReconciled,
    status:        p.status || '',
    source:        'payment',
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function _getBankTransactionsRaw(userId, tenantId, accountId, { force = false } = {}) {
  const key    = `banktx:${userId}:${tenantId}:${accountId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  // Bounded to the last year. Unbounded, this pulled the account's entire
  // history on every miss — and paid for it — for a statement view that
  // shows recent movement.
  const since = _fmtXeroDate(_addDays(_partsFromDate(new Date()), -365));
  const res = await withRetry(() => api.getBankTransactions(
    tenantId, undefined, `BankAccount.AccountID==Guid("${accountId}") && Date >= ${since}`, 'Date DESC'
  ));

  // Bank transactions alone miss real cash movement that goes through
  // Payment records instead (paying a bill, receiving a customer payment
  // against an invoice — confirmed against live data, never shows up in
  // getBankTransactions). Fetched separately, own try/catch: anyone who
  // hasn't reconnected under the accounting.payments.read scope yet still
  // gets a working (bank-transactions-only) statement instead of the whole
  // view breaking on their scope error.
  let payments = [];
  try {
    const payRes = await withRetry(() => api.getPayments(
      tenantId, undefined, `Account.AccountID==Guid("${accountId}") && Date >= ${since}`, 'Date DESC'
    ));
    payments = _buildPayments(payRes.body.payments || []);
  } catch (err) {
    if (!isScopeError(err)) throw err; // a real failure, not just a missing scope, should still surface
    logger.info('Skipping Payments in statement — not yet reconnected under accounting.payments.read', { userId, tenantId });
  }

  const transactions = [..._buildBankTransactions(res.body.bankTransactions || []), ...payments]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const data = { transactions };
  return _cacheSet(key, data);
}


// Xero formats report cell values like "1,234.56" or "(123.45)" for negatives —
// never a plain parseable number.
function _parseReportNumber(s) {
  if (!s) return 0;
  const negative = /^\(.*\)$/.test(s.trim());
  const n = Number(s.replace(/[(),]/g, ''));
  if (Number.isNaN(n)) return 0;
  return negative ? -n : n;
}



// Bank Summary is COLUMNAR, not sectioned-with-labeled-rows like it visually
// appears in Xero's UI: one Header row spells out what each cell position
// means ("Bank Accounts" | "Opening Balance" | "Cash Received" | "Cash Spent"
// | "Closing Balance"), then every bank account is one plain Row with values
// at those same positions — confirmed against a real Xero response, not
// guessed. Reading positions off the real Header row (rather than hardcoding
// indexes 0-4) survives Xero reordering or relabeling the columns.
function _buildBankSummary(reportRows) {
  const header  = (reportRows || []).find(r => r.rowType === 'Header');
  const columns = (header?.cells || []).map(c => (c.value || '').toLowerCase());
  const receivedIdx = columns.findIndex(c => c.includes('cash received'));
  const spentIdx     = columns.findIndex(c => c.includes('cash spent'));
  const closingIdx   = columns.findIndex(c => c.includes('closing balance'));
  const openingIdx   = columns.findIndex(c => c.includes('opening balance'));
  if (receivedIdx < 0 || spentIdx < 0) return { accounts: [], cashIn: 0, cashOut: 0, net: 0 };

  const accounts = [];
  (function walk(rows) {
    for (const row of rows || []) {
      // SummaryRow (the report's own "Total" line) is deliberately excluded —
      // cashIn/cashOut are summed from the per-account rows below instead, so
      // this never depends on that row's label matching anything.
      if (row.rowType === 'Row' && row.cells?.length > spentIdx) {
        accounts.push({
          name:           row.cells[0]?.value || 'Account',
          cashReceived:   _parseReportNumber(row.cells[receivedIdx]?.value),
          cashSpent:      Math.abs(_parseReportNumber(row.cells[spentIdx]?.value)),
          closingBalance: closingIdx >= 0 ? _parseReportNumber(row.cells[closingIdx]?.value) : 0,
          openingBalance: openingIdx >= 0 ? _parseReportNumber(row.cells[openingIdx]?.value) : 0,
        });
      }
      if (row.rows?.length) walk(row.rows);
    }
  })(reportRows);

  const cashIn  = accounts.reduce((s, a) => s + a.cashReceived, 0);
  const cashOut = accounts.reduce((s, a) => s + a.cashSpent, 0);
  return { accounts, cashIn, cashOut, net: cashIn - cashOut };
}

// Xero's Report endpoints (unlike the Invoices/BankTransactions list APIs)
// reject any fromDate/toDate pair more than 365 days apart outright —
// confirmed via a live 400 ValidationException ("The fromDate and toDate
// parameters must be with 365 days of each other"), triggered by the "All
// Time" preset's wide range. Anything wider has to be split into consecutive
// <=365-day windows and the results merged, not just clamped down to "really
// only the last year" silently mislabeled as all time.
const REPORT_WINDOW_MAX_DAYS = 365;
// Bounds how far back "All Time" (or any other very wide range) actually
// reaches for these two endpoints specifically — otherwise a 26-year-wide
// "All Time" anchor would mean ~26 sequential Report calls per card, almost
// all of them for years that can't have any real data anyway.
const REPORT_LOOKBACK_YEARS = 10;

function _clampReportFrom(fromISO, toISO) {
  const from = _parseISODate(fromISO);
  const to   = _parseISODate(toISO);
  const earliestAllowed = { year: to.year - REPORT_LOOKBACK_YEARS, month: 1, day: 1 };
  return _dateFromParts(from) < _dateFromParts(earliestAllowed) ? _fmtISODate(earliestAllowed) : fromISO;
}

// Pure. Splits an inclusive date range into consecutive windows of at most
// maxDays each, covering every day exactly once.
function _splitIntoReportWindows(fromISO, toISO, maxDays = REPORT_WINDOW_MAX_DAYS) {
  const windows = [];
  let winStart = _parseISODate(fromISO);
  const end    = _parseISODate(toISO);
  while (_dateFromParts(winStart) <= _dateFromParts(end)) {
    let winEnd = _addDays(winStart, maxDays - 1);
    if (_dateFromParts(winEnd) > _dateFromParts(end)) winEnd = end;
    windows.push({ from: _fmtISODate(winStart), to: _fmtISODate(winEnd) });
    winStart = _addDays(winEnd, 1);
  }
  return windows;
}


async function _getBankSummaryRaw(userId, tenantId, { from, to, force = false } = {}) {
  const clampedFrom = _clampReportFrom(from, to);
  const key    = `banksum:${userId}:${tenantId}:${clampedFrom}:${to}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const windows   = _splitIntoReportWindows(clampedFrom, to);
  const byAccount = new Map(); // name -> merged account row
  for (const w of windows) {
    const res  = await withRetry(() => api.getReportBankSummary(tenantId, w.from, w.to));
    const part = _buildBankSummary(res.body.reports?.[0]?.rows || []);
    for (const acc of part.accounts) {
      const existing = byAccount.get(acc.name) || { name: acc.name, cashReceived: 0, cashSpent: 0, closingBalance: 0, openingBalance: acc.openingBalance };
      existing.cashReceived += acc.cashReceived;
      existing.cashSpent    += acc.cashSpent;
      existing.closingBalance = acc.closingBalance; // a running balance, not additive — windows are processed oldest-first, so the last write wins and holds the most recent balance
      byAccount.set(acc.name, existing);
    }
  }
  const accounts = [...byAccount.values()];
  const cashIn   = accounts.reduce((s, a) => s + a.cashReceived, 0);
  const cashOut  = accounts.reduce((s, a) => s + a.cashSpent, 0);
  logger.info('Insights bank summary fetched', { userId, tenantId, from: clampedFrom, to, windows: windows.length });
  return _cacheSet(key, { accounts, cashIn, cashOut, net: cashIn - cashOut, from: clampedFrom, to });
}

// ── Budget vs Actual (monthly grid) ─────────────────────────────────────────
// Reproduces Xero's "Current financial year by month – actual and budget" custom
// layout, which the API can't return directly (custom report layouts aren't
// exposed). Built by merging two report endpoints column-for-column.
//
// Everything below was confirmed against live Xero data, not inferred from docs —
// the two endpoints disagree in ways that would silently misalign every column:
//
//   ProfitAndLoss   anchor = LAST  month of the FY, periods=11 → NEWEST-first
//   BudgetSummary   anchor = FIRST month of the FY, periods=12 → OLDEST-first
//
// Opposite anchors AND opposite order. periods=13 is rejected by BudgetSummary,
// so 12 is the ceiling — exactly one fiscal year. Their column headers are also
// formatted differently ("31 Aug 26" vs "Aug-26"), so columns are matched
// POSITIONALLY off the known anchor, never by parsing header text.
//
// The P&L anchor must be a 31-day month: Xero gives every comparison period the
// anchor's day count, so a short anchor month truncates the months before it.
// A span ending in a short month is therefore fetched in two P&L calls — see
// _pnlCallPlan.


// How long a fetched period stays cached. A period that has already closed is
// effectively immutable — re-fetching Apr 2025 every 90 seconds is pure waste —
// but "closed" is not the same as "settled": late invoices and adjustments land
// during month-end, so a recently-ended period gets a short life rather than a
// long one. Anything still in progress keeps the original short TTL.
//
// Nothing here is ever a substitute for correctness: the Refresh button always
// forces, and the key includes the exact month span.
const TTL_OPEN_MS   = CACHE_TTL_MS;          // period includes the current month
const TTL_RECENT_MS = 10 * 60 * 1000;        // closed, but within the back-dating window
const TTL_CLOSED_MS = 6 * 60 * 60 * 1000;    // closed long enough to be settled
const BACKDATE_WINDOW_DAYS = 35;             // one month-end close, plus slack

function _periodCacheTtl(months, today) {
  if (!months?.length) return TTL_OPEN_MS;
  const end = _parseISODate(months[months.length - 1].endISO);
  if (!end) return TTL_OPEN_MS;
  const days = (_dateFromParts(today) - _dateFromParts(end)) / 86400000;
  if (days <= 0) return TTL_OPEN_MS;                       // still running, or in the future
  return days < BACKDATE_WINDOW_DAYS ? TTL_RECENT_MS : TTL_CLOSED_MS;
}

// Runs `fn` over `items` with at most `limit` in flight, preserving input order.
// Used for report chunks: strictly sequential wastes latency, unbounded parallel
// would burst against a 60/min budget shared with real invoice submission.
async function _mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const REPORT_CHUNK_CONCURRENCY = 2;

// The ProfitAndLoss calls that cover one chunk of months, as a pure plan.
//
// Twelve months is a per-CALL limit, not a fiscal-year limit: ProfitAndLoss caps
// `periods` at 11 (12 columns) and BudgetSummary at 12, but both anchor on an
// arbitrary date. So any 12 consecutive months cost one BudgetSummary call and
// one or two ProfitAndLoss calls — which is what lets the window slide off the
// fiscal year entirely.
//
// Why sometimes two: Xero applies the anchor's DATE RANGE to every comparison
// period, not "the same month, earlier" (documented under ProfitAndLoss
// `periods`: with a 30-day anchor each prior period includes only its first 30
// days). Anchored on September, every 31-day month before it silently lost its
// 31st; anchored on February, the 29th to the 31st. So a chunk ending in a
// month shorter than 31 days is anchored on the month before it — always 31
// days, since no two short months are adjacent — and its last month is asked
// for on its own, with exact dates. A chunk ending in a 31-day month stays one
// call.
//
// Each entry says what to send and which months of the chunk the answer covers
// (`offset`, `n`), so the pieces line up column for column when merged.
function _pnlCallPlan(chunk) {
  const n = chunk.length;
  // A single month has no comparison periods at all, so `periods` is omitted
  // rather than passed as 0, which the endpoint rejects.
  const alone = i => ({ fromISO: chunk[i].startISO, toISO: chunk[i].endISO, periods: undefined, offset: i, n: 1 });
  if (n === 1) return [alone(0)];
  const last = chunk[n - 1];
  if (_parseISODate(last.endISO).day === 31) {
    return [{ fromISO: last.startISO, toISO: last.endISO, periods: n - 1, offset: 0, n }];
  }
  const prev = chunk[n - 2];
  const head = n === 2 ? alone(0) : { fromISO: prev.startISO, toISO: prev.endISO, periods: n - 2, offset: 0, n: n - 1 };
  return [head, alone(n - 1)];
}

// Pure. Every labelled line of a report, in Xero's reading order:
// { section, label, kind, values }.
//
// A line under a titled section is an 'account', or a 'subtotal' where Xero
// marks it a SummaryRow. A line in an untitled section is a floating 'summary'
// — Gross Profit, Total Expenses, Net Profit — which is exactly how they sit in
// Xero's layout. `reverse` flips ProfitAndLoss's newest-first columns into the
// oldest-first order the month list uses.
function _reportLines(reportRows, { reverse = false } = {}) {
  const out = [];
  (function walk(rows, title) {
    for (const row of rows || []) {
      if (row.rowType === 'Header') continue;
      if (row.rowType === 'Section' || row.rows?.length) {
        walk(row.rows, (row.title || '').trim() || title);
        continue;
      }
      const label = (row.cells?.[0]?.value || '').trim();
      if (!label) continue;
      const values = (row.cells || []).slice(1).map(c => _parseReportNumber(c?.value));
      out.push({
        section: title,
        label,
        kind: !title ? 'summary' : (row.rowType === 'SummaryRow' ? 'subtotal' : 'account'),
        values: reverse ? values.reverse() : values,
      });
    }
  })(reportRows, '');
  return out;
}

// A line's identity is its section AND its label. The label alone is not one:
// a name can sit in two sections (an income "Consulting" and an expense
// "Consulting"), and matching on it alone dropped one of them or gave it the
// other's figures. Case and spacing are ignored, and Xero names the bottom lines
// by their sign — "Net Loss" in one report is "Net Profit" in the other — so
// each of those pairs reads as one line.
const _norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
function _lineName(label) {
  const l = _norm(label);
  if (/^net (profit|loss)$/.test(l))   return 'net profit';
  if (/^gross (profit|loss)$/.test(l)) return 'gross profit';
  return l;
}
const _lineKey = (section, label) => `${_norm(section)}\u0000${_lineName(label)}`;

const _sectionIndex = (layout, title) => layout.findIndex(r => r.kind === 'section' && _norm(r.label) === _norm(title));

// Index just past the section that row `i` sits in: the next heading or
// floating summary line, or the end.
function _sectionEnd(layout, i) {
  let j = i + 1;
  while (j < layout.length && layout[j].kind !== 'section' && layout[j].kind !== 'summary') j++;
  return j;
}

// Where something that follows `prev` in its own report goes: straight after a
// floating summary line, or after the whole section an ordinary line sits in.
function _placeAfter(layout, prev) {
  if (!prev) return 0;
  const p = layout.indexOf(prev);
  return prev.kind === 'summary' ? p + 1 : _sectionEnd(layout, p);
}

// The layout row a report line belongs to, or null when it has none yet.
// `claimed` holds rows an earlier line of the same report already took, so two
// lines of one report never land on one row.
function _matchLine(layout, line, { claimed, alias, counts }) {
  const free = r => r.kind !== 'section' && !claimed.has(r);
  const key = _lineKey(line.section, line.label);
  const exact = layout.find(r => free(r) && r.key === key);
  if (exact) return exact;
  // The two reports should title their sections identically under the standard
  // layout, but nothing guarantees it, and a small difference must not split
  // every line in two. So the label alone is enough when it names exactly one
  // line in each report — but never for a section the budget has too: a
  // section both reports share is a genuine second section, and a namesake
  // elsewhere is a different account.
  const budgetHasSection = layout.some(r => r.kind === 'section' && !r.unbudgeted && _norm(r.label) === _norm(line.section));
  if (line.kind === 'summary' || budgetHasSection) return null;
  const name = _lineName(line.label);
  if (counts.get(name) === 1) {
    const same = layout.filter(r => r.kind !== 'section' && r.kind !== 'summary' && r.name === name);
    if (same.length === 1 && !claimed.has(same[0])) return same[0];
  }
  // A retitled section usually retitles its total too ("Total Overheads"), so a
  // subtotal under a section already matched that way is that section's total
  // when it has exactly one.
  const target = alias.get(_norm(line.section));
  if (line.kind === 'subtotal' && target !== undefined) {
    const h = _sectionIndex(layout, target);
    if (h >= 0) {
      const subs = layout.slice(h + 1, _sectionEnd(layout, h)).filter(r => r.kind === 'subtotal' && !claimed.has(r));
      if (subs.length === 1) return subs[0];
    }
  }
  return null;
}

// Adds a line the layout does not have yet, in its own section and in its own
// report's order, and returns the new row.
//
// Appending it at the bottom — the old behaviour — put it below Net Profit with
// no section, so section sums no longer added up and the dashboard's revenue
// and expense lines skipped it. An account goes after the line before it in its
// report when that line is in the same section, otherwise first in the section;
// either way before the section's subtotal. A section the layout does not have
// at all goes in whole, after whatever preceded it in its report — which puts
// it before the next summary line, where Xero shows it.
function _insertLine(layout, line, prev, { alias, budgeted, totalMonths }) {
  const row = {
    kind: line.kind, label: line.label, section: '', unbudgeted: !budgeted,
    name: _lineName(line.label), key: null,
    budget: Array(totalMonths).fill(0), actual: Array(totalMonths).fill(0),
  };
  if (line.kind === 'summary') {
    row.key = _lineKey('', line.label);
    layout.splice(_placeAfter(layout, prev), 0, row);
    return row;
  }
  const title = alias.get(_norm(line.section)) ?? line.section;
  row.section = title;
  row.key = _lineKey(title, line.label);
  const h = _sectionIndex(layout, title);
  if (h < 0) {
    layout.splice(_placeAfter(layout, prev), 0, { kind: 'section', label: title, section: title, unbudgeted: !budgeted }, row);
    return row;
  }
  const end = _sectionEnd(layout, h);
  if (line.kind === 'subtotal') { layout.splice(end, 0, row); return row; }
  const sub = layout.findIndex((r, i) => i > h && i < end && r.kind === 'subtotal');
  const limit = sub >= 0 ? sub : end;
  const p = prev ? layout.indexOf(prev) : -1;
  layout.splice(p > h && p < limit ? p + 1 : h + 1, 0, row);
  return row;
}

// Lays one report's lines into the layout and writes their figures into
// `field` at the report's month offset.
//
// Every line is matched before any is inserted, so whether a line finds its
// row never depends on what the same report happened to insert ahead of it.
function _placeLines(layout, { lines, offset, n }, { field, budgeted, totalMonths }) {
  const claimed = new Set();
  const alias   = new Map();   // this report's section title -> the layout's, learnt from label matches
  const counts  = new Map();
  for (const l of lines) counts.set(_lineName(l.label), (counts.get(_lineName(l.label)) || 0) + 1);
  const matched = lines.map(line => {
    const row = _matchLine(layout, line, { claimed, alias, counts });
    if (row) {
      claimed.add(row);
      if (line.kind !== 'summary' && _norm(row.section) !== _norm(line.section)) alias.set(_norm(line.section), row.section);
    }
    return row;
  });
  let prev = null;
  lines.forEach((line, k) => {
    const row = matched[k] || _insertLine(layout, line, prev, { alias, budgeted, totalMonths });
    for (let i = 0; i < n; i++) row[field][offset + i] = line.values[i] || 0;
    prev = row;
  });
}

// Xero's variance percentage, matched against the org's own Budget Variance
// report: variance over the ABSOLUTE budget, so a negative budget still yields a
// signed percentage the same way Xero shows it (Sep gross profit budgeted at
// -1,030 against nil actual reads +100.00%, not -100.00%).
//
// Against a nil budget the percentage is undefined rather than infinite, so it's
// null and the frontend prints a dash — again matching Xero.
function _variancePct(variance, budget) {
  return budget !== 0 ? variance / Math.abs(budget) : null;
}

// Pure. Stitches every chunk's two reports into one ordered layout of rows,
// each carrying its budget and actual series across every month.
//
// The order is BudgetSummary's, which is the richer of the two: confirmed live
// that it returns every row the P&L does plus the budget-only accounts (Cost of
// Goods Sold, Other Income - Grant, the overheads), because the P&L omits any
// account with no actual transactions entirely. Every chunk's budget is laid
// down before any actuals, so an account budgeted in any chunk counts as
// budgeted wherever its actuals first appear; whatever the P&L has beyond that
// is `unbudgeted`. A row first seen in a later chunk joins its own section, in
// its report's order, rather than the bottom of the layout.
//
// Each chunk is an independent Xero response, so an account can be present in
// one and absent from another (the P&L omits accounts with no transactions in
// that span). Missing chunks are zero-filled at the right offset rather than
// shortening the series, otherwise months would silently slide. A part's P&L
// comes as `pnl` pieces (see _pnlCallPlan), or as one `pnlRows` covering it.
function _mergeChunks(parts, totalMonths) {
  const layout = [];
  const budgets = [], actuals = [];
  let offset = 0;
  for (const part of parts) {
    const n = part.months.length;
    budgets.push({ lines: _reportLines(part.budgetRows), offset, n });
    for (const piece of part.pnl || [{ rows: part.pnlRows, offset: 0, n }]) {
      actuals.push({ lines: _reportLines(piece.rows, { reverse: true }), offset: offset + piece.offset, n: piece.n });
    }
    offset += n;
  }
  for (const b of budgets) _placeLines(layout, b, { field: 'budget', budgeted: true,  totalMonths });
  for (const a of actuals) _placeLines(layout, a, { field: 'actual', budgeted: false, totalMonths });
  return { layout, budgetMissing: budgets.every(b => b.lines.length === 0) };
}

// Every figure the payload carries is rounded to the cent. Sums of report
// values carry floating-point dust (-3.55e-15), which a reader sees as a red
// "(0.00)", or as a variance where there is none. -0 becomes 0 for the same
// reason.
function _cents(v) {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

// The bottom line. By name when it carries one of Xero's two names for it;
// failing that, the last floating summary line, which is where Xero puts it.
function _netRow(rows) {
  return rows.find(r => r.kind === 'summary' && /^net (profit|loss)/i.test(r.label))
      || [...rows].reverse().find(r => r.kind === 'summary' && !r.section);
}

// Pure. Merges the two reports into one flat, ordered row list.
//
// Each cell is actual OR budget depending on whether its month has fully
// elapsed — never both, and never a sum of the two. Subtotals are taken from
// whichever report supplied that column rather than recomputed, so they stay
// internally consistent with the figures above them.
//
// `currentIdx` is the month containing today, when the period includes it. Its
// cell stays budget, for the reason _actualThroughIndex gives; what has been
// booked against it so far is reported beside the grid as kpis.currentMonth
// instead, read on `asOfISO`, and is not added into any total.
function _buildBudgetVariance({ budgetRows, pnlRows, months, actualThroughIdx, merged, currentIdx = -1, asOfISO = null }) {
  // `merged` is the fetched path; a lone pair of reports is merged as one chunk.
  const { layout, budgetMissing } = merged || _mergeChunks([{ months, budgetRows, pnlRows }], months.length);

  const elapsed = actualThroughIdx + 1;
  const pair = (actual, budget) => {
    // From the rounded figures, so a percentage always agrees with what is shown.
    const variance = _cents(actual - budget);
    return { actual, budget, variance, variancePct: _variancePct(variance, budget) };
  };
  const rows = layout.map(r => {
    const row = {
      kind: r.kind, label: r.label, section: r.section,
      // Costs, where a figure above budget is the bad direction: every line of
      // the cost-of-sales and overhead sections, their subtotals included.
      expense:    r.kind !== 'section' && ['cogs', 'opex'].includes(_sectionKind(r.section)),
      unbudgeted: !!r.unbudgeted,
    };
    if (r.kind === 'section') return row;
    const a = months.map((_, i) => _cents(r.actual[i] || 0));
    const b = months.map((_, i) => _cents(r.budget[i] || 0));
    const cells = months.map((_, i) => (i <= actualThroughIdx ? a[i] : b[i]));

    // Per-month actual/budget/variance, kept for every month including ones not
    // yet elapsed. Xero's own Budget Variance report compares the CURRENT
    // (part-elapsed) month too — confirmed against the org's report, which shows
    // August actuals of 52,000 against a 17,615 August budget — so the actuals
    // can't be suppressed here the way the monthly grid suppresses them.
    const monthly = months.map((_, i) => pair(a[i], b[i]));

    // Running totals from the period's first month over those same figures, so
    // "to date" at any month is one lookup rather than a re-sum each consumer
    // could do slightly differently.
    let runA = 0, runB = 0;
    const cumulative = months.map((_, i) => { runA += a[i]; runB += b[i]; return pair(_cents(runA), _cents(runB)); });

    // Year-to-date rolls up the fully elapsed months only.
    const toDate = elapsed > 0 ? cumulative[elapsed - 1] : pair(0, 0);
    return {
      ...row,
      cells,
      total:        _cents(cells.reduce((s, v) => s + v, 0)),
      monthly,
      cumulative,
      actualToDate: toDate.actual,
      budgetToDate: toDate.budget,
      variance:     toDate.variance,
      variancePct:  toDate.variancePct,
    };
  });

  const net = _netRow(rows);
  const cur = currentIdx >= 0 && currentIdx < months.length ? currentIdx : -1;
  return {
    rows,
    // Said outright, because a missing budget otherwise looks exactly like a
    // budget of nil on every line.
    budgetMissing,
    kpis: {
      monthsElapsed:  elapsed,
      monthsTotal:    months.length,
      ytdActualNet:   net ? net.actualToDate : 0,
      restOfYearNet:  net ? _cents(net.cells.slice(elapsed).reduce((s, v) => s + v, 0)) : 0,
      forecastNet:    net ? net.total : 0,
      // Everything Xero holds dated in this month, which can include
      // transactions dated later in it — "so far" means booked so far.
      currentMonth: cur < 0 ? null : {
        key:       months[cur].key,
        label:     months[cur].label,
        asOf:      asOfISO,
        actualNet: net ? net.monthly[cur].actual : 0,
        budgetNet: net ? net.monthly[cur].budget : 0,
      },
    },
  };
}

async function _getBudgetVarianceRaw(userId, tenantId, { force = false, timezone = 'UTC', window = 'fy', period } = {}) {
  const org           = await _getOrganisation(userId, tenantId, force);
  const fiscalYearEnd = { month: org.financialYearEndMonth || 12, day: org.financialYearEndDay || 31 };
  const today         = _todayPartsInTz(timezone);
  const win           = period ? _resolvePeriod(period, today, fiscalYearEnd)
                               : _resolveWindow(window, today, fiscalYearEnd);
  const months        = win.months;
  const actualThroughIdx = _actualThroughIndex(months, today);
  const todayKey      = `${today.year}-${String(today.month).padStart(2, '0')}`;
  const currentIdx    = months.findIndex(m => m.key === todayKey);

  // The exact span is part of the key — two periods are two different reports,
  // and serving one for the other would silently show the wrong months.
  //
  // So is the period's name. The payload carries it (period.key and label, and
  // the fiscalYear title built from them), so a custom Jan–Dec and the 'fy'
  // preset of a December year end — the same months — must not share an entry,
  // or whichever came first titles both, down to the exports' "year to date"
  // or "period to date" wording.
  //
  // And so is the month in progress. When a period's first month begins, no
  // month of it has closed on either side of midnight, so actualThroughIdx
  // alone does not change, and the entry from the day before was served without
  // that month marked current for up to a cache lifetime.
  const key    = `budgetvar:${userId}:${tenantId}:${win.key}:${months[0].key}:${months[months.length - 1].key}:${actualThroughIdx}:${currentIdx}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  // A period longer than 12 months exceeds what one call pair can return, so it
  // is fetched as several. Sequentially, not in parallel: Xero's 60/min budget
  // is shared with real invoice submission, and a long range shouldn't burst.
  // BudgetSummary only ever reports the OVERALL budget. Listing the budgets
  // makes that explicit rather than leaving the reader to assume the figures
  // cover a tracking-category budget they may also have.
  let budgets = [];
  try {
    const bRes = await withRetry(() => api.getBudgets(tenantId));
    budgets = (bRes.body.budgets || []).map(b => ({ id: b.budgetID, type: b.type, description: b.description }));
  } catch (err) {
    logger.info('Budget list unavailable — reporting the Overall budget only', { userId, tenantId });
  }

  const chunks = _chunkMonths(months, 12);
  let pnlCalls = 0;
  const parts = await _mapWithConcurrency(chunks, REPORT_CHUNK_CONCURRENCY, async (chunk) => {
    const first = chunk[0], n = chunk.length;
    // A chunk's P&L pieces go one after the other rather than side by side, so
    // two chunks in flight stay at four calls, inside Xero's limit of five
    // concurrent calls per organisation.
    const fetchPnl = async () => {
      const pieces = [];
      for (const c of _pnlCallPlan(chunk)) {
        pnlCalls++;
        // standardLayout: without it Xero lays the P&L out in the
        // organisation's own custom layout, whose sections and labels need not
        // match BudgetSummary's — and the two are matched line by line on them.
        const res = await withRetry(() => api.getReportProfitAndLoss(
          tenantId, c.fromISO, c.toISO, c.periods, c.periods ? 'MONTH' : undefined,
          undefined, undefined, undefined, undefined, true));
        pieces.push({ rows: res.body.reports?.[0]?.rows || [], offset: c.offset, n: c.n });
      }
      return pieces;
    };
    const [pnl, budRes] = await Promise.all([
      fetchPnl(),
      // Anchored on the FIRST month — periods counts forwards from here. timeframe 1 = month.
      withRetry(() => api.getReportBudgetSummary(tenantId, first.endISO, n, 1)),
    ]);
    return { months: chunk, budgetRows: budRes.body.reports?.[0]?.rows || [], pnl };
  });

  const built = _buildBudgetVariance({
    months, actualThroughIdx, currentIdx, asOfISO: _fmtISODate(today),
    merged: _mergeChunks(parts, months.length),
  });

  // Re-derived here: the loop above scopes its own first/last to each chunk.
  const first = months[0], last = months[months.length - 1];
  const end = _parseISODate(last.endISO);
  const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  // Only a true fiscal-year window can honestly be called "the year ended X".
  // A custom range is already named by its months, so they are not said twice.
  const range = `${first.label} – ${last.label}`;
  const periodLabel = win.key === 'fy'
    ? `For the year ended ${end.day} ${MONTHS_LONG[end.month - 1]} ${end.year}`
    : (win.label === range ? range : `${win.label} · ${range}`);
  // The closed months a to-date figure covers, named once here so the screen
  // and the exports cannot describe them differently.
  const closedLast = actualThroughIdx >= 0 ? months[actualThroughIdx] : null;
  logger.info('Budget vs Actual fetched', {
    userId, tenantId, period: win.key, range: `${first.key}..${last.key}`,
    months: months.length, chunks: chunks.length, pnlCalls, actualMonths: actualThroughIdx + 1,
  });

  return _cacheSet(key, {
    organisation: { name: org.name || org.legalName || 'Organisation', currency: org.baseCurrency || '' },
    fiscalYear:   { label: periodLabel, fromISO: first.startISO, toISO: last.endISO },
    budgets,
    period:       { key: win.key, label: win.label, months: months.length, chunks: chunks.length,
                    fromKey: months[0].key, toKey: months[months.length - 1].key,
                    toDateLabel:      _toDateLabel(months, fiscalYearEnd),
                    closedFromLabel:  closedLast ? first.label : null,
                    closedToLabel:    closedLast ? closedLast.label : null,
                    closedThroughISO: closedLast ? closedLast.endISO : null },
    months:       months.map((m, i) => ({ key: m.key, label: m.label, source: i <= actualThroughIdx ? 'actual' : 'budget', current: i === currentIdx })),
    ...built,
  }, _periodCacheTtl(months, today));
}

// ── Performance overview (Dashboard → Overview + Revenue) ───────────────────
// Composed entirely from data already fetched elsewhere: getBudgetVariance
// supplies 12 months of per-account actuals AND budget in one cached pair of
// calls, and getBankSummary supplies cash. No new Xero scope, and the monthly
// series are returned whole so the frontend's month-range slider can re-slice
// without another request.

// Which P&L section a row belongs to. Order matters: "Less Cost of Sales"
// contains the word "Sales", so it has to be tested before the revenue pattern.
//
// Other income may be headed "Plus Other Income". Read as revenue — it contains
// "income" — its total would now be added into revenue, since totals are found
// by their section (see _sectionTotal). Revenue against other income makes no
// difference to the budget grid, which reads this only to tell costs apart.
function _sectionKind(section) {
  const s = (section || '').trim();
  if (/^less cost of sales/i.test(s))                      return 'cogs';
  if (/^less (operating expenses|overheads)/i.test(s))     return 'opex';
  if (/^(plus )?other income/i.test(s))                    return 'otherIncome';
  if (/income|revenue|sales/i.test(s))                     return 'revenue';
  return 'other';
}

// Pure. A P&L total, found the way the lines above it are found: by the section
// it closes, never by its own label.
//
// Totals were looked up by exact label ("Total Income", "Total Operating
// Expenses") while their sections were matched by pattern, which also accepts
// "Trading Income" and "Less Overheads". Under those headings Xero names the
// totals "Total Trading Income" and "Total Overheads", the lookups found
// nothing, and revenue and overheads came out as zero for the whole period —
// while the lines beneath them were shown correctly.
//
// Each section of the kind contributes its own subtotal, or the sum of its
// accounts if it has none. Summed across sections rather than taking the first,
// because a heading one report words differently from the other can leave the
// budget's figures and the actuals in two sections of the same kind, each with
// half of the total. Null when no section of the kind exists.
function _sectionTotal(rows, kind, n) {
  const groups = new Map();
  for (const r of rows) {
    if (r.kind !== 'subtotal' && r.kind !== 'account') continue;
    if (_sectionKind(r.section) !== kind) continue;
    const k = _norm(r.section);
    if (!groups.has(k)) groups.set(k, { subtotals: [], accounts: [] });
    groups.get(k)[r.kind === 'subtotal' ? 'subtotals' : 'accounts'].push(r);
  }
  if (!groups.size) return null;
  const actual = _zeros(n), budget = _zeros(n);
  for (const g of groups.values()) {
    for (const r of (g.subtotals.length ? g.subtotals : g.accounts)) {
      (r.monthly || []).forEach((m, i) => {
        if (i >= n) return;
        actual[i] += Number(m.actual || 0);
        budget[i] += Number(m.budget || 0);
      });
    }
  }
  return { actual: actual.map(_cents), budget: budget.map(_cents) };
}

// Recurring revenue is a business concept Xero doesn't record — there's no flag
// on an account saying "this is subscription income". The account NAME is the
// only signal available, and it's a reliable one because people name these
// accounts deliberately ("Sales - Maintenance (Recurring)"). Every classified
// account is reported back so the UI can show its working rather than assert it.
const RECURRING_PATTERN = /recurring|subscription|maintenance|retainer|manage(d)?\s*service|support|licen[cs]e|hosting|saas|manag(e|ed)/i;
function _isRecurringName(label) { return RECURRING_PATTERN.test(label || ''); }

const _zeros = n => Array(n).fill(0);
const _sum   = a => a.reduce((s, v) => s + v, 0);

// Pure. Reshapes budget-variance rows into the series the dashboard charts need.
function _buildPerformance({ months, rows, cash }) {
  const n = months.length;
  // A section Xero didn't emit (this org books no cost of sales, so there is no
  // cost-of-sales section at all) must read as a flat zero series, not undefined.
  const seriesOf = row => ({
    actual: row ? row.monthly.map(m => m.actual) : _zeros(n),
    budget: row ? row.monthly.map(m => m.budget) : _zeros(n),
  });
  const sectionSeries = kind => _sectionTotal(rows, kind, n) || seriesOf(null);
  // A floating line, named by its sign like Net Profit: "Gross Loss" in a
  // month or report where it is negative.
  const grossRow = rows.find(r => r.kind !== 'section' && /^gross (profit|loss)$/i.test(String(r.label || '').trim()));

  const totals = {
    revenue:     sectionSeries('revenue'),
    otherIncome: sectionSeries('otherIncome'),
    cogs:        sectionSeries('cogs'),
    grossProfit: seriesOf(grossRow),
    opex:        sectionSeries('opex'),
    netProfit:   seriesOf(_netRow(rows)),
  };

  // One entry per revenue account — this is what drives "Revenue by service line"
  // and the recurring/project split.
  const serviceLines = rows
    .filter(r => r.kind === 'account' && ['revenue', 'otherIncome'].includes(_sectionKind(r.section)))
    .map(r => ({
      label:       r.label,
      section:     r.section,
      otherIncome: _sectionKind(r.section) === 'otherIncome',
      recurring:   _isRecurringName(r.label),
      actual:      r.monthly.map(m => m.actual),
      budget:      r.monthly.map(m => m.budget),
    }));

  // Recurring vs project, summed from the classified accounts rather than a
  // separate Xero figure — Xero has no such split.
  const pick = (want, field) => months.map((_, i) =>
    _sum(serviceLines.filter(l => !l.otherIncome && l.recurring === want).map(l => l[field][i])));
  const split = {
    recurring: { actual: pick(true,  'actual'), budget: pick(true,  'budget') },
    project:   { actual: pick(false, 'actual'), budget: pick(false, 'budget') },
  };

  const expenseLines = rows
    .filter(r => r.kind === 'account' && ['cogs', 'opex'].includes(_sectionKind(r.section)))
    .map(r => ({ label: r.label, section: r.section, kind: _sectionKind(r.section),
                 actual: r.monthly.map(m => m.actual), budget: r.monthly.map(m => m.budget) }));

  return { totals, serviceLines, split, expenseLines, cash };
}

// Pure. Data-quality flags, computed from the figures rather than asserted.
// Deliberately rule-based: every line is traceable to a number on screen, so
// nothing here can say something the data doesn't support.
// Pure. How many months of a series are FULLY elapsed. The current month is
// partial, and comparing a partial month against a complete one is the single
// most common way a dashboard invents a collapse that never happened — so every
// rate, growth figure and run rate below is computed on closed months only.
function _growthPct(curr, prev) {
  const c = Number(curr), p = Number(prev);
  if (prev === null || prev === undefined) return null;
  if (!Number.isFinite(c) || !Number.isFinite(p) || p <= 0) return null;
  return (c - p) / p;
}

// Pure. Revenue momentum: month-on-month, year-on-year, and the trailing trend.
// Every comparison is closed-month to closed-month.
function _buildGrowth({ series = [], months = [], today } = {}) {
  const n = Math.min(_closedCount(months, today), series.length);
  if (n < 1) return { available: false, closedMonths: 0 };

  const closed = series.slice(0, n);
  const at = i => (i >= 0 && i < n ? closed[i] : null);
  const labelAt = i => (i >= 0 && i < months.length ? months[i].label : null);

  const steps = [];
  for (let i = 1; i < n; i++) {
    const g = _growthPct(closed[i], closed[i - 1]);
    if (g !== null) steps.push(g);
  }
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  // Three-month means rather than a fitted line: with twelve points at most, a
  // regression is false precision, and a mean survives one freak month.
  let trend = null;
  if (n >= 6) {
    const recent = mean(closed.slice(n - 3));
    const prior  = mean(closed.slice(n - 6, n - 3));
    trend = _growthPct(recent, prior);
  }

  return {
    available: true,
    closedMonths: n,
    latest: at(n - 1),          latestLabel:   labelAt(n - 1),
    previous: at(n - 2),        previousLabel: labelAt(n - 2),
    yoyBase: n >= 13 ? at(n - 13) : null,
    yoyLabel: n >= 13 ? labelAt(n - 13) : null,
    mom: _growthPct(at(n - 1), at(n - 2)),
    // Needs 13 closed months to compare like month with like month. Below that
    // it is absent rather than approximated from a shorter span.
    yoy: n >= 13 ? _growthPct(at(n - 1), at(n - 13)) : null,
    avgMoM: mean(steps),
    trend,
    series: closed,
  };
}

function _buildWatchList({ months, totals, actualThroughIdx }) {
  const out = [];
  const rev = totals.revenue.actual, cogs = totals.cogs.actual, opex = totals.opex.actual;
  const elapsed = actualThroughIdx + 1;

  // Scanned across ALL months, not just closed ones. Booked actual revenue is
  // evidence of real transactions whether or not the month has ended, and the
  // current open month is precisely where costs lag invoicing. A month with no
  // actuals at all has rev[i] === 0, so it can never trip this on its own.
  for (let i = 0; i < months.length; i++) {
    if (rev[i] > 0 && cogs[i] === 0 && opex[i] === 0) {
      out.push({ severity: 'warn', text: `${months[i].label} booked ${Math.round(rev[i]).toLocaleString()} of revenue but no costs at all — expenses may not be recorded yet, which overstates profit.` });
    }
  }

  const firstActive = rev.findIndex(v => v !== 0);
  if (firstActive > 0) {
    out.push({ severity: 'info', text: `No activity recorded before ${months[firstActive].label} — trend comparisons over the earlier months are not meaningful.` });
  }

  const ytdRev  = _sum(rev);
  const ytdCogs = _sum(cogs);
  if (ytdRev > 0 && ytdCogs === 0) {
    out.push({ severity: 'warn', text: 'No cost of sales has been booked this year, so gross margin reads 100%. It is not a pricing signal.' });
  }
  if (elapsed === 0) out.push({ severity: 'info', text: 'No month of this financial year has closed yet — every figure shown is budget.' });
  return out;
}

// Pure. Groups sales invoices by customer, biggest first.
//
// Deliberately called "invoiced", not "revenue": these are invoice TOTALS, which
// include tax, whereas the P&L figures elsewhere on this page are net. For an
// org whose sales accounts are zero-rated the two agree, but they will not in
// general — so the UI must not present this as the same number.
function _buildCustomerRevenue(invoices, baseCurrency = '') {
  const byContact = new Map();
  for (const inv of invoices || []) {
    const name  = inv.contact?.name || 'Unknown';
    // Base currency, not the invoice's own — otherwise a USD customer and an
    // SGD customer are ranked against each other on unlike numbers.
    const total = _toBase(inv, inv.total, baseCurrency);
    if (!byContact.has(name)) byContact.set(name, { name, invoiced: 0, invoices: 0 });
    const c = byContact.get(name);
    c.invoiced += total;
    c.invoices += 1;
  }
  const customers = [...byContact.values()].sort((a, b) => b.invoiced - a.invoiced);
  const total = customers.reduce((s, c) => s + c.invoiced, 0);
  return {
    customers,
    total,
    count: customers.length,
    currency: _foreignCurrency(invoices, baseCurrency),
    // Undefined rather than zero when nobody was invoiced — an average of no
    // customers is not 0, it is meaningless.
    average: customers.length ? total / customers.length : null,
    available: true,
  };
}

// Pure. Problems in the invoice data itself, as opposed to problems in the
// business. A duplicate invoice number or a dated-nothing record is a
// bookkeeping fault, and a dashboard that reports figures built on them without
// saying so is quietly lending them credibility.
function _buildInvoiceHygiene(invoices = [], baseCurrency = '') {
  const issues = [];
  const byNumber = new Map();
  let undated = 0, negativeLines = 0;

  for (const inv of invoices) {
    const num = (inv.invoiceNumber || '').trim();
    if (num) {
      if (!byNumber.has(num)) byNumber.set(num, []);
      byNumber.get(num).push(inv);
    }
    // A live invoice with no date cannot be placed in any period, so it silently
    // drops out of every monthly figure on the dashboard.
    if (!inv.date && inv.status !== 'DELETED' && inv.status !== 'VOIDED') undated++;
    if (Number(inv.total || 0) < 0) negativeLines++;
  }

  for (const [num, list] of byNumber) {
    // Deleted/voided duplicates still matter: the number is reused, so anyone
    // reconciling by invoice number sees two different documents.
    if (list.length > 1) {
      const live = list.filter(i => i.status !== 'DELETED' && i.status !== 'VOIDED');
      issues.push({
        severity: live.length > 1 ? 'warn' : 'info',
        text: `Invoice number ${num} is used ${list.length} times (${list.map(i => i.status).join(', ')})`
            + (live.length > 1 ? ' — more than one is live, so figures may double-count.'
                               : ' — the duplicates are deleted or voided, but the number is reused.'),
      });
    }
  }
  if (undated) issues.push({ severity: 'warn', text: `${undated} live invoice${undated === 1 ? '' : 's'} ha${undated === 1 ? 's' : 've'} no date, so ${undated === 1 ? 'it is' : 'they are'} excluded from every monthly figure.` });
  if (negativeLines) issues.push({ severity: 'info', text: `${negativeLines} invoice${negativeLines === 1 ? ' has a' : 's have'} negative total${negativeLines === 1 ? '' : 's'} — usually a discount or reallocation rather than a credit note.` });

  // A foreign-currency invoice with no exchange rate cannot be converted to the
  // org's base currency, so it is being counted at face value in a total that is
  // otherwise base. Small, but it is exactly the kind of error that is invisible
  // until someone reconciles by hand.
  const currency = _foreignCurrency(invoices, baseCurrency);
  if (currency.unconvertible) {
    issues.push({
      severity: 'warn',
      text: `${currency.unconvertible} invoice${currency.unconvertible === 1 ? '' : 's'} in ${currency.currencies.join(', ') || 'a foreign currency'} `
          + `ha${currency.unconvertible === 1 ? 's' : 've'} no exchange rate, so ${currency.unconvertible === 1 ? 'it is' : 'they are'} counted at face value `
          + `in ${baseCurrency || 'base currency'} totals.`,
    });
  }

  return { issues, duplicateNumbers: [...byNumber].filter(([, l]) => l.length > 1).length, undated, currency };
}

// Pure. Work quoted but not yet invoiced — revenue that exists commercially and
// nowhere in the accounts. SENT and ACCEPTED are the live pipeline; INVOICED has
// already become an invoice and would be double-counted, and DRAFT was never
// put in front of the customer.
function _buildQuotePipeline(quotes = [], baseCurrency = '') {
  const live = { sent: 0, accepted: 0 };
  const counts = { sent: 0, accepted: 0 };
  for (const q of quotes) {
    const status = String(q.status || '').toUpperCase();
    const total  = _toBase(q, q.total, baseCurrency);
    if (status === 'SENT')     { live.sent += total; counts.sent++; }
    if (status === 'ACCEPTED') { live.accepted += total; counts.accepted++; }
  }
  return {
    sent: live.sent, accepted: live.accepted,
    total: live.sent + live.accepted,
    counts,
    currency: _foreignCurrency(quotes, baseCurrency),
    available: true,
  };
}

async function _getPerformanceRaw(userId, tenantId, { timezone = 'UTC', force = false, window = 'fy', period, cashFlow = false, customers = false } = {}) {
  // Reuses the budget-variance fetch and its cache — on a warm cache this whole
  // endpoint costs one Xero call (the bank summary) rather than three.
  //
  // Asked for exactly as the /budget-variance route asks for it. `window` only
  // means anything when there is no period, and passing it alongside one made
  // this a different in-flight request from the route's identical one, so the
  // two fetched the same report from Xero side by side.
  const bv = await getBudgetVariance(userId, tenantId, period ? { timezone, force, period } : { timezone, force, window });
  // Started now, read below for debtor and creditor days, so it overlaps the
  // bank summary instead of queueing behind it. Asked for exactly as the
  // /summary route asks, so it shares that request and its cache entry. The
  // catch is attached here so a failure is never an unhandled rejection.
  const summaryP = getSummary(userId, tenantId, { force }).catch(err => {
    logger.warn('Performance: summary unavailable for debtor and creditor days', { userId, tenantId, error: err.message });
    return null;
  });

  const todayParts = _todayPartsInTz(timezone);
  const today = _fmtISODate(todayParts);
  // Every invoice/quote figure below is converted to this before being summed or
  // compared with a report figure. See _toBase.
  const baseCurrency = bv.organisation?.currency || '';
  // Overview needs only the CLOSING BALANCE, which is "as of today" whatever
  // window you ask for — so it reads a short recent window (one Xero call).
  // Cash in/out genuinely is period-scoped, but only Banking shows it, and over
  // a long range getBankSummary splits into 365-day windows: a 32-month period
  // cost three calls to produce one number. Banking opts in explicitly.
  const balanceFrom = _fmtISODate(_addDays(_todayPartsInTz(timezone), -31));
  const from = cashFlow ? bv.fiscalYear.fromISO : balanceFrom;
  let cash = { total: 0, cashIn: 0, cashOut: 0, net: 0, accounts: [], available: false, flowScope: cashFlow ? 'period' : 'last31d' };
  try {
    const bank = await getBankSummary(userId, tenantId, { from, to: today, force });
    cash = {
      total:     bank.accounts.reduce((s, a) => s + a.closingBalance, 0),
      // Cash movement, not just the closing position — the Banking tab renders
      // this, which is why the old standalone Cash In/Out fetch could go.
      cashIn:    bank.cashIn,
      cashOut:   bank.cashOut,
      net:       bank.net,
      accounts:  bank.accounts.map(a => ({ name: a.name, balance: a.closingBalance, cashIn: a.cashReceived, cashOut: a.cashSpent })),
      available: true,
      flowScope: cashFlow ? 'period' : 'last31d',
    };
  } catch (err) {
    // Cash is one card out of many — a bank-scope problem shouldn't blank the
    // whole dashboard, so it degrades to "—" instead.
    if (!isScopeError(err)) logger.warn('Performance: bank summary failed', { userId, tenantId, error: err.message });
    else logger.info('Performance: bank summary skipped — scope not granted', { userId, tenantId });
  }

  // Only the Revenue tab shows this, so Overview never pays for the extra call.
  let customerRevenue = { customers: [], total: 0, count: 0, average: null, available: false };
  let quotePipeline   = { sent: 0, accepted: 0, total: 0, counts: { sent: 0, accepted: 0 }, available: false };
  if (customers) {
    try {
      const tokenCache = require('../utils/token-cache').forUser(userId);
      const api = _apiFor(await tokenCache.getValidToken(tenantId));
      const start = _parseISODate(bv.fiscalYear.fromISO);
      const endEx = _addDays(_parseISODate(bv.fiscalYear.toISO), 1); // Xero's upper bound is exclusive
      const where = `Type=="ACCREC" && Date >= ${_fmtXeroDate(start)} && Date < ${_fmtXeroDate(endEx)}`;
      const fyInvoices = await _allInvoices(api, tenantId, { where, order: 'Date DESC', statuses: ['AUTHORISED', 'PAID'] });
      customerRevenue = _buildCustomerRevenue(fyInvoices, baseCurrency);

      // Quoted-but-not-invoiced work exists commercially and nowhere in the
      // accounts, so the forward view otherwise stops at issued invoices.
      try {
        // Only this fiscal year's quotes: the pipeline is built from them, and
        // an unfiltered call returned every quote the org ever raised.
        const qRes = await withRetry(() => api.getQuotes(tenantId, undefined, bv.fiscalYear.fromISO));
        quotePipeline = _buildQuotePipeline(qRes.body.quotes || [], baseCurrency);
      } catch (qErr) {
        logger.warn('Performance: quotes unavailable', { userId, tenantId, error: qErr.message });
      }
    } catch (err) {
      // One card out of many — a failure here must not blank the tab.
      logger.warn('Performance: customer revenue unavailable', { userId, tenantId, error: err.message });
    }
  }

  const actualThroughIdx = bv.months.filter(m => m.source === 'actual').length - 1;
  const built = _buildPerformance({ months: bv.months, rows: bv.rows, cash });
  const watchList = _buildWatchList({ months: bv.months, totals: built.totals, actualThroughIdx });
  // Momentum, not just level — a dashboard that shows revenue but never whether
  // it is rising makes the reader do the differencing in their head.
  const growth = _buildGrowth({ series: built.totals.revenue.actual, months: bv.months, today: todayParts });

  // Debtor and creditor days, worked out here once for the period. The
  // Overview shows this figure, and getCashFlow passes the same one to its tab,
  // its alerts and the AI commentary, so no two places can disagree about it.
  // Read from the summary, which already holds every invoice and which the page
  // loads first, so on a normal visit this is a cache hit rather than another
  // invoice fetch. One card out of many: a failure leaves it unavailable.
  let paymentDays = { available: false, reason: 'unavailable', dso: null, dpo: null, closedMonths: 0 };
  try {
    const summary = await summaryP;
    if (summary?.kpis) {
      paymentDays = _buildPaymentDays({
        receivable: summary.kpis.totalReceivables, payable: summary.kpis.totalPayables,
        raisedByMonth: summary.raisedByMonth || {}, months: bv.months, today: todayParts,
      });
    }
  } catch (err) {
    logger.warn('Performance: debtor and creditor days unavailable', { userId, tenantId, error: err.message });
  }

  logger.info('Performance overview built', { userId, tenantId, serviceLines: built.serviceLines.length, actualMonths: actualThroughIdx + 1 });

  return {
    organisation:     bv.organisation,
    fiscalYear:       bv.fiscalYear,
    period:           bv.period,
    months:           bv.months,
    actualThroughIdx,
    // Last FULLY elapsed month. actualThroughIdx includes the current one, which
    // is partial — anything comparing month against month needs this instead, or
    // it reports a collapse that is only the calendar.
    closedThroughIdx: _closedCount(bv.months, todayParts) - 1,
    ...built,
    growth,
    paymentDays,
    customerRevenue,
    quotePipeline,
    watchList,
    // Surfaced so the UI can show which accounts were treated as recurring —
    // a guess made from names should never be invisible.
    recurringAccounts: built.serviceLines.filter(l => l.recurring).map(l => l.label),
    cached:    bv.cached,
    fetchedAt: bv.fetchedAt,
  };
}

// ── Variance reasons (Gemini-explained, Xero-computed) ──────────────────────
// The FIGURES are computed here from Xero and never leave that path. Gemini is
// given those already-final numbers and asked only to suggest WHY — it is never
// asked to calculate, recall or estimate anything.
//
// Guardrail: any generated sentence containing a large number that wasn't in the
// input is dropped. An LLM inventing a plausible-looking amount inside financial
// commentary is the failure mode that matters, and it's cheap to detect.

// How far before the reporting period we will look for still-open invoices.
// Trades forecast completeness against Xero's per-GB egress billing.
const INVOICE_LOOKBACK_MONTHS = 24;

const INSIGHT_CACHE_TTL_MS = 30 * 60 * 1000; // reasons only change when the figures do

// Numbers big enough to be a money amount rather than a percentage or a count.
// Prompts, grounding and the facts the model is allowed to see — see
// ./ai-insights. Re-exported below so tests reach them through this module.
const {
  _buildCategoryVariances,
  _groundNarrative,
  _insightIsGrounded,
  _insightPrompt,
  _largeNumbersIn,
  _narrativeFacts,
  _narrativePrompt,
  _parseInsights,
  _varianceCandidates,
} = require('./ai-insights');

async function _getVarianceInsightsRaw(userId, tenantId, { timezone = 'UTC', force = false, reanalyse = false, period } = {}) {
  const perf = await getPerformance(userId, tenantId, { timezone, force, period });
  // Cash flow enriches the commentary with category context; it is not required
  // for it. Losing it must not blank the insights — but it must not vanish
  // silently either, or "why are the category variances empty" has no trail.
  let cf = null;
  try {
    cf = await getCashFlow(userId, tenantId, { timezone, force, period });
  } catch (err) {
    logger.warn('Variance insights: cash-flow context unavailable', { userId, tenantId, error: err.message });
  }

  const categories = _buildCategoryVariances(perf, cf);
  const candidates = _varianceCandidates(perf);
  const closed = perf.actualThroughIdx + 1;

  if (!categories.length && !candidates.length) {
    return { generated: false, reason: 'Nothing differs from budget yet.', categories: [], lines: [], source: 'none' };
  }

  // Keyed on the figures themselves, so the model is re-asked only when the numbers actually move.
  const sig = categories.map(c => `${c.key}:${Math.round(c.variance)}`).join('|') + '::' + candidates.map(c => `${c.account}:${Math.round(c.variance)}`).join('|');
  const key = `insights:v3:${userId}:${tenantId}:${perf.period?.fromKey}:${perf.period?.toKey}:${sig}`;
  const cached = _cacheGet(key, force || reanalyse, { noGrace: true });
  if (cached) return cached;

  const { callGemini } = require('../utils/gemini-client');
  try {
    const messages = _insightPrompt(perf.organisation.name, perf.fiscalYear.label, closed, categories, candidates);
    const res = await callGemini(userId, messages, { temperature: 0.2, maxTokens: 800 });
    const { categories: parsedCats, lines: parsedLines } = _parseInsights(res?.message?.content ?? res?.content ?? res, categories, candidates);
    
    logger.info('Variance insights generated', { userId, tenantId, categories: parsedCats.length, lines: parsedLines.length });
    return _cacheSet(key, { generated: true, categories: parsedCats, lines: parsedLines, source: 'gemini', fetchedAt: new Date().toISOString() }, INSIGHT_CACHE_TTL_MS);
  } catch (err) {
    logger.warn('Variance insights model unavailable, using computed defaults', { userId, tenantId, error: err.message });
    return _cacheSet(key, { generated: true, categories: categories.map(c => ({ ...c, reason: c.defaultReason })), lines: candidates, source: 'figures', fetchedAt: new Date().toISOString() }, INSIGHT_CACHE_TTL_MS);
  }
}

// ── Cash flow ───────────────────────────────────────────────────────────────
// Xero has NO cash-flow-statement endpoint — the full report list is Aged
// Payables/Receivables, BalanceSheet, BankSummary, BudgetSummary,
// ExecutiveSummary, ProfitAndLoss, TrialBalance. So this is constructed.
//
// The distinction everything here rests on: invoices and bills are ACCRUAL.
// A sales invoice (ACCREC) hits the P&L the moment it is raised and moves no
// cash; cash moves only when a Payment settles it, or when a Bank Transaction
// happens with no invoice behind it at all. Building this from the P&L would
// report revenue as though it were cash, which for an org that has collected
// none of its invoices is the opposite of the truth.

// Cash movement, working capital, forecast, runway, waterfall and alerts —
// see ./cash-flow. Re-exported below so callers and tests are unchanged.
const {
  ALERT_THRESHOLDS,
  _buildAlerts,
  _buildCashForecast,
  _buildCashMovement,
  _buildCashWaterfall,
  _buildRunway,
  _buildWorkingCapital,
  _isReceiptPayment,
  _isTransfer,
  _isLive,
  _buildSupplierSpend,
  _buildUnreconciled,
  _buildPaymentDays,
  _raisedByMonth,
} = require('./cash-flow');

async function _getCashFlowRaw(userId, tenantId, { timezone = 'UTC', force = false, period } = {}) {
  // Reuses the cached performance fetch for the P&L side, so the accrual-vs-cash
  // reconciliation compares like with like over the same months.
  const perf = await getPerformance(userId, tenantId, { timezone, force, period });
  const months = perf.months;
  const first  = perf.fiscalYear.fromISO, last = perf.fiscalYear.toISO;
  const today  = _todayPartsInTz(timezone);

  // The period's name is in the key for the reason given at budgetvar: the
  // payload copies perf.period, so the same months under another name would
  // otherwise come back carrying the first one's.
  const key    = `cashflow:${userId}:${tenantId}:${perf.period?.key}:${months[0].key}:${months[months.length - 1].key}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const api = _apiFor(await tokenCache.getValidToken(tenantId));

  const fromP = _parseISODate(first);
  const toEx  = _addDays(_parseISODate(last), 1);      // Xero's upper bound is exclusive
  const dateWhere = `Date >= ${_fmtXeroDate(fromP)} && Date < ${_fmtXeroDate(toEx)}`;
  // Open invoices predate the period; bound how far back we will pay to read.
  const lookbackFrom = { year: fromP.year - Math.floor(INVOICE_LOOKBACK_MONTHS / 12), month: fromP.month, day: 1 };
  const invoiceWhere = `Date >= ${_fmtXeroDate(lookbackFrom)}`;

  // Every call here is a GET. Nothing in this path writes to Xero.
  const [bank, payRes, btRes, invRes] = await Promise.all([
    getBankSummary(userId, tenantId, { from: first, to: last, force }).catch(err => {
      logger.warn('Cash flow: bank summary unavailable', { userId, error: err.message });
      return null;
    }),
    withRetry(() => api.getPayments(tenantId, undefined, dateWhere, 'Date DESC'))
      .catch(err => { logger.warn('Cash flow: payments unavailable', { userId, error: err.message }); return { body: {} }; }),
    withRetry(() => api.getBankTransactions(tenantId, undefined, dateWhere, 'Date DESC'))
      .catch(err => { logger.warn('Cash flow: bank transactions unavailable', { userId, error: err.message }); return { body: {} }; }),
    // Deliberately reaches back BEFORE the period: the forecast needs every OPEN
    // invoice, including ones raised earlier that are still unpaid. Bounded at
    // INVOICE_LOOKBACK_MONTHS rather than left unfiltered, because Xero now
    // bills on data egress — an unbounded invoice fetch costs nothing at six
    // invoices and real money at sixty thousand. An invoice still open beyond
    // that horizon is a write-off decision, not a cash-flow forecast item.
    //
    // NOT ordered by DueDate — Xero rejects that with a 400 when summaryOnly is
    // set ("Ordering by DueDate is unavailable on this endpoint when using the
    // summaryOnly flag"). Order is irrelevant here anyway: the forecast buckets
    // by due date rather than reading them in sequence, and summaryOnly keeps
    // the response small.
    _allInvoices(api, tenantId, { where: invoiceWhere, order: 'Date DESC', statuses: ['AUTHORISED', 'PAID'] }),
  ]);

  const invoices = invRes;
  const baseCurrency = perf.organisation?.currency || '';
  const movement = _buildCashMovement({
    payments:         payRes.body.payments || [],
    bankTransactions: btRes.body.bankTransactions || [],
    months,
    baseCurrency,
  });

  const S = a => a.reduce((x, y) => x + y, 0);
  const revenue  = S(perf.totals.revenue.actual);

  // Debtor and creditor days are the period's one figure from getPerformance,
  // the same one the Overview shows, not a second calculation here.
  const workingCapital = _buildWorkingCapital({ invoices, today, baseCurrency, paymentDays: perf.paymentDays });
  // Scoped to the period on screen, not the wider window the invoice fetch uses
  // so the forecast can see older unpaid bills.
  const supplierSpend = _buildSupplierSpend(invoices, { baseCurrency, fromISO: first, toISO: last });
  const hygiene = _buildInvoiceHygiene(invoices, baseCurrency);
  const closing  = bank ? bank.accounts.reduce((s, a) => s + a.closingBalance, 0) : 0;
  const opening  = bank ? bank.accounts.reduce((s, a) => s + (a.openingBalance || 0), 0) : 0;
  // The Bank Summary's received and spent count a transfer between the org's
  // own accounts twice over — out of one account and into another — although
  // no money came into or left the business. Taken off here, so "cash in" on
  // this tab is money that actually arrived, and it is measured on the same
  // terms as the movement figures it sits beside and is checked against.
  const bankIn   = bank ? bank.cashIn  - movement.transfers.in  : 0;
  const bankOut  = bank ? bank.cashOut - movement.transfers.out : 0;
  const forecast = _buildCashForecast({ invoices, openingBalance: closing, today, baseCurrency });
  const runway   = _buildRunway({ months, monthly: movement.monthly, closing, today });
  const waterfall = _buildCashWaterfall({ opening, closing, movement });

  // The bank statement is what actually happened. Payments and bank transactions
  // explain WHERE it came from — but they are separate records, and they can
  // disagree with the bank if something was recorded against a non-bank account
  // or never reconciled. Deriving the opening balance by subtraction hid that;
  // reading Xero's own opening balance exposes it instead.
  //
  // Only when there is a bank figure to compare with. Without one, every
  // payment recorded used to read as missing from a bank that was simply not
  // fetched.
  const unreconciled = bank
    ? _buildUnreconciled({ movement, bankIn: bank.cashIn, bankOut: bank.cashOut })
    : { inGap: 0, outGap: 0, transfersIn: 0, transfersOut: 0, material: false };

  const alerts = _buildAlerts({
    runway, workingCapital, forecast, unreconciled, supplierSpend,
    cash: { available: !!bank, closing },
  });

  logger.info('Cash flow built', {
    userId, tenantId, months: months.length,
    customerReceipts: Math.round(movement.customerReceipts), otherReceipts: Math.round(movement.otherReceipts),
  });

  return _cacheSet(key, {
    organisation: perf.organisation,
    period:       perf.period,
    months,
    cash: {
      available: !!bank,
      closing, opening,
      // From the bank statement, not inferred from the payment records, less
      // transfers between the org's own accounts (see bankIn above).
      cashIn: bankIn, cashOut: bankOut, net: bankIn - bankOut,
      transfersIn: movement.transfers.in, transfersOut: movement.transfers.out,
      accounts: bank ? bank.accounts.map(a => ({ name: a.name, balance: a.closingBalance })) : [],
    },
    movement,
    waterfall,
    runway,
    alerts,
    unreconciled,
    hygiene,
    workingCapital,
    supplierSpend,
    forecast,
    // The two figures tell opposite stories here, so the gap is stated rather
    // than left for the reader to notice.
    reconciliation: {
      revenueAccrual:   revenue,
      customerReceipts: movement.customerReceipts,
      notCollected:     revenue - movement.customerReceipts,
    },
  }, _periodCacheTtl(months, today));
}


// ── Financial narrative (AI-written, from figures we computed) ──────────────
//
// The alerts are excellent at DETECTION and silent on INTERPRETATION. A reader
// facing five separate red flags has to work out for themselves that they are
// one story — which is exactly what people are worst at when tired. This joins
// them up in a few sentences.
//
// The safety model is the same one getVarianceInsights already runs without
// trouble, and it is not negotiable:
//   * every figure is computed here; Gemini never calculates anything
//   * the deterministic alerts go in as GROUND TRUTH, so it can only join them
//     up, never contradict them
//   * any sentence containing a large number we did not supply is dropped
//   * it is read-only — it proposes nothing and can act on nothing
//   * if it fails, the card simply does not render; figures never wait on it
const NARRATIVE_CACHE_TTL_MS = 30 * 60 * 1000;
// Long enough for a rate limit to ease. Nothing waits on this — the card is
// fetched separately from the figures — so a pause costs the reader nothing.
const NARRATIVE_RETRY_DELAY_MS = 2500;

async function _narrateFrom(userId, tenantId, cf, { force = false } = {}) {
  const facts = _narrativeFacts(cf);
  // Keyed on the figures themselves, so it is rewritten only when they change.
  const key = `narrative:${userId}:${tenantId}:${facts.lines.join('|')}`;
  const cached = _cacheGet(key, force, { noGrace: true });
  if (cached) return cached;

  // Required lazily, exactly as getVarianceInsights does — reports.js has no
  // module-level Gemini import.
  const { callGemini } = require('../utils/gemini-client');

  // Two attempts, WITH a pause between them. callGemini already rotates through
  // every model and every key before it throws, so an immediate retry re-sends a
  // request that just failed on all of them. The gap is the point.
  let raw = null;
  for (let attempt = 1; attempt <= 2 && raw === null; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, NARRATIVE_RETRY_DELAY_MS));
    try {
      raw = await callGemini(userId, [
        { role: 'system', content: 'You are a careful financial analyst. Return plain sentences only.' },
        { role: 'user',   content: _narrativePrompt(facts) },
      ], { temperature: 0.2, maxTokens: 350 });
    } catch (err) {
      logger.warn('Financial narrative attempt failed', { userId, tenantId, attempt, error: err.message });
    }
  }
  // The card simply will not render. Figures never wait on this.
  if (raw === null) return { available: false, reason: 'unavailable' };

  const { text, dropped } = _groundNarrative(raw, facts.allowed);
  if (dropped) logger.warn('Narrative sentences dropped as ungrounded', { userId, tenantId, dropped });
  if (!text) return { available: false, reason: 'ungrounded' };

  logger.info('Financial narrative written', { userId, tenantId, alerts: facts.alerts.length, dropped });
  return _cacheSet(key, {
    available: true,
    text,
    source: 'gemini',
    period: cf.period,
    basedOnAlerts: facts.alerts.length,
    fetchedAt: new Date().toISOString(),
  }, NARRATIVE_CACHE_TTL_MS);
}

async function _getFinancialNarrativeRaw(userId, tenantId, { timezone = 'UTC', force = false, reanalyse = false, period } = {}) {
  // Only `force` reaches Xero. `reanalyse` reuses whatever is cached and simply
  // asks the model again.
  const cf = await getCashFlow(userId, tenantId, { timezone, force, period });
  return _narrateFrom(userId, tenantId, cf, { force: force || reanalyse });
}

// Called on disconnect so nothing here can outlive the connection it came from.
// Bound here, after the declarations, so internal callers (getPerformance →
// getBudgetVariance, and so on) go through the same in-flight map as routes.
const getSummary             = _dedupe('getSummary', _getSummaryRaw);
const _getOrganisation       = _dedupe('_getOrganisation', _getOrganisationRaw);
const getAccounts            = _dedupe('getAccounts', _getAccountsRaw);
const getBankAccounts        = _dedupe('getBankAccounts', _getBankAccountsRaw);
const getContacts            = _dedupe('getContacts', _getContactsRaw);
const getBankTransactions    = _dedupe('getBankTransactions', _getBankTransactionsRaw);
const getBankSummary         = _dedupe('getBankSummary', _getBankSummaryRaw);
// The period reports name their option defaults (see _dedupe), matching the
// defaults in their own signatures. These are the ones fetched together — the
// Insights page asks for performance, commentary and narrative at once, and
// each of those asks for the next one down — so these are where a request
// spelled two ways cost two fetches.
const getBudgetVariance      = _dedupe('getBudgetVariance', _getBudgetVarianceRaw,
  { force: false, timezone: 'UTC', window: 'fy' });
const getPerformance         = _dedupe('getPerformance', _getPerformanceRaw,
  { timezone: 'UTC', force: false, window: 'fy', cashFlow: false, customers: false });
const getVarianceInsights    = _dedupe('getVarianceInsights', _getVarianceInsightsRaw,
  { timezone: 'UTC', force: false, reanalyse: false });
const getCashFlow            = _dedupe('getCashFlow', _getCashFlowRaw,
  { timezone: 'UTC', force: false });
const getFinancialNarrative  = _dedupe('getFinancialNarrative', _getFinancialNarrativeRaw,
  { timezone: 'UTC', force: false, reanalyse: false });

function clearCache(userId) {
  for (const key of _cache.keys()) {
    if (key.includes(`:${userId}:`)) _cache.delete(key);
  }
}

module.exports = {
  FORCE_GRACE_MS, DIRECTORY_TTL_MS,
  getSummary, getAccounts, getBankAccounts, getContacts,
  getBankTransactions, getBankSummary, getBudgetVariance, getPerformance, getCashFlow, getVarianceInsights, getFinancialNarrative, clearCache,
  _buildSummary, _buildAccounts, _buildBankAccounts, _buildContacts,
  _buildBankTransactions, _buildPayments, _buildBankSummary,
  _splitIntoReportWindows, _clampReportFrom,
  _fiscalYearMonths, _monthsFrom, _monthMeta, _monthsBetween, _chunkMonths,
  _resolveWindow, _resolvePeriod, _actualThroughIndex, _reportLines, _pnlCallPlan, _buildBudgetVariance,
  _mergeChunks, _cents, _netRow, _toDateLabel, _buildCustomerRevenue, _buildInvoiceHygiene, _buildQuotePipeline, _buildCashMovement, _buildWorkingCapital, _buildCashForecast,
  _toBase, _foreignCurrency, _closedCount, _growthPct, _buildGrowth, _buildRunway, _buildCashWaterfall,
  _buildAlerts, ALERT_THRESHOLDS,
  _isTransfer, _isReceiptPayment, _isLive, _buildUnreconciled, _buildPaymentDays, _raisedByMonth, _sectionTotal, _periodCacheTtl, _pruneCache, _cache, CACHE_MAX_ENTRIES, TTL_OPEN_MS, TTL_RECENT_MS, TTL_CLOSED_MS, _mapWithConcurrency, _variancePct, _sectionKind, _isRecurringName, _buildPerformance, _buildWatchList,
  _largeNumbersIn, _insightIsGrounded, _varianceCandidates, _parseInsights, _buildCategoryVariances,
  _narrativeFacts, _groundNarrative, _narrativePrompt, _narrateFrom,
  _canonical, _dedupeKey,
};
