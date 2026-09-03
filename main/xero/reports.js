const { AccountingApi }  = require('xero-node');
const { withRetry, isScopeError } = require('./xero-utils');
const logger             = require('../utils/logger');

// Read-only financial data for the "Insights" tab. Every function here either
// takes already-fetched Xero data (pure, fully unit-tested, nothing to mock) or
// is the thin cached-fetch wrapper around it — same split as the rest of this
// file's original summary logic.
//
// Cached in-memory per user+tenant(+range), same short-TTL philosophy as
// token-cache.js — Xero's 60-calls/minute budget is shared with real invoice
// submission, so a dashboard nobody's actively watching shouldn't refetch on
// every page view.
const CACHE_TTL_MS = 90 * 1000;
const _cache = new Map(); // arbitrary string key -> { data, fetchedAt }

function _cacheGet(key, force) {
  const cached = _cache.get(key);
  // Per-entry TTL, defaulting to the short one. Report data is cheap to refetch
  // and should stay near-live; generated commentary costs an LLM call, so it
  // opts into a much longer life via _cacheSet's third argument.
  if (!force && cached && Date.now() - cached.fetchedAt < (cached.ttl || CACHE_TTL_MS)) {
    return { ...cached.data, cached: true, fetchedAt: cached.fetchedAt };
  }
  return null;
}
function _cacheSet(key, data, ttl) {
  _cache.set(key, { data, fetchedAt: Date.now(), ttl });
  return { ...data, cached: false, fetchedAt: Date.now() };
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
  _fiscalYearStart,
  _fmtISODate,
  _fmtXeroDate,
  _monthKeyOfDate,
  _monthMeta,
  _monthsBetween,
  _monthsFrom,
  _parseISODate,
  _partsFromDate,
  _resolvePeriod,
  _resolveWindow,
  _todayPartsInTz,
  _weekdayMon0,
  computeRange,
} = require('./periods');

function _buildSummary(org, invoices) {
  let totalReceivables = 0, totalPayables = 0, overdueAmount = 0;
  let receivablesCount = 0, payablesCount = 0;
  const statusBreakdown = { paid: 0, awaiting: 0, overdue: 0 };
  const aging = { receivables: _emptyAging(), payables: _emptyAging() };

  const list = invoices.map(inv => {
    const isReceivable = inv.type === 'ACCREC';
    const amountDue     = Number(inv.amountDue || 0);
    const status         = _statusLabel(inv);
    statusBreakdown[status]++;
    if (status === 'overdue') overdueAmount += amountDue;

    if (inv.status === 'AUTHORISED' && amountDue > 0) {
      if (isReceivable) { totalReceivables += amountDue; receivablesCount++; }
      else               { totalPayables    += amountDue; payablesCount++; }
      const bucket = aging[isReceivable ? 'receivables' : 'payables'][_agingBucketOf(inv.dueDate)];
      bucket.count++; bucket.amount += amountDue;
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
    kpis: { totalReceivables, totalPayables, receivablesCount, payablesCount, overdueAmount, statusBreakdown },
    aging,
    invoices: list,
  };
}

async function getSummary(userId, tenantId, { force = false } = {}) {
  const key    = `summary:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const [orgRes, invRes] = await Promise.all([
    withRetry(() => api.getOrganisations(tenantId)),
    withRetry(() => api.getInvoices(
      tenantId, undefined, undefined, 'Date DESC', undefined, undefined, undefined,
      ['AUTHORISED', 'PAID'], 1, undefined, undefined, undefined, true // summaryOnly — no line items needed here
    )),
  ]);

  const data = _buildSummary(orgRes.body.organisations?.[0] || {}, invRes.body.invoices || []);
  logger.info('Insights summary fetched', { userId, tenantId, invoiceCount: data.invoices.length });
  return _cacheSet(key, data);
}

// Cached separately from getSummary's own org fetch (same underlying Xero
// call, but this one's only reached for the 'year' preset, and keeping it
// standalone avoids reshaping getSummary's existing parallel fetch).
async function _getOrganisation(userId, tenantId, force) {
  const key    = `org:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached.org;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);
  const res = await withRetry(() => api.getOrganisations(tenantId));
  return _cacheSet(key, { org: res.body.organisations?.[0] || {} }).org;
}

// ── Date-range engine (daily/weekly/monthly/yearly/custom) ──────────────────
// Everything here works in calendar dates (Y/M/D), never real instants — Xero's
// filter syntax (`DateTime(y,m,d)`) takes a plain calendar date with no
// timezone component, so day-boundary math never needs to resolve a UTC
// offset. "Today" itself is the one place a timezone actually matters (what
// counts as today depends on where the user is), resolved once via
// Intl.DateTimeFormat against the user's stored timezone preference.

function _buildPeriod(invoices, range) {
  const granularity = range.days <= 31 ? 'day' : 'month';
  const bucketOf = dateStr => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return granularity === 'day'
      ? dateStr.slice(0, 10)
      : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const buckets = new Map(); // key -> { sales, bills }
  let salesTotal = 0, billsTotal = 0, salesCount = 0, billsCount = 0;

  for (const inv of invoices) {
    const isReceivable = inv.type === 'ACCREC';
    const total = Number(inv.total || 0);
    if (isReceivable) { salesTotal += total; salesCount++; } else { billsTotal += total; billsCount++; }

    const key = bucketOf(inv.date);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, { bucket: key, sales: 0, bills: 0 });
    const b = buckets.get(key);
    if (isReceivable) b.sales += total; else b.bills += total;
  }

  const trend = [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    range: { preset: range.preset, fromISO: range.fromISO, toISO: range.toISO },
    totals: { salesTotal, billsTotal, salesCount, billsCount, net: salesTotal - billsTotal },
    granularity,
    trend,
  };
}

async function getPeriod(userId, tenantId, { preset = 'month', from, to, timezone = 'UTC', force = false } = {}) {
  // Fiscal-year-end only matters for the 'year' preset — skip the extra org
  // lookup entirely for every other preset.
  let fiscalYearEnd;
  if (preset === 'year') {
    const org = await _getOrganisation(userId, tenantId, force);
    fiscalYearEnd = { month: org.financialYearEndMonth || 12, day: org.financialYearEndDay || 31 };
  }
  const range = computeRange(preset, timezone, from, to, fiscalYearEnd);
  const key   = `period:${userId}:${tenantId}:${range.preset}:${range.fromISO}:${range.toISO}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const invRes = await withRetry(() => api.getInvoices(
    tenantId, undefined, range.where, 'Date ASC', undefined, undefined, undefined,
    ['AUTHORISED', 'PAID'], 1, undefined, undefined, undefined, true
  ));

  const data = _buildPeriod(invRes.body.invoices || [], range);
  logger.info('Insights period fetched', { userId, tenantId, range: range.preset, invoiceCount: (invRes.body.invoices || []).length });
  return _cacheSet(key, data);
}

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

async function getAccounts(userId, tenantId, { force = false } = {}) {
  const key    = `accounts:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getAccounts(tenantId, undefined, undefined, 'Code ASC'));
  const data = { accounts: _buildAccounts(res.body.accounts || []) };
  return _cacheSet(key, data);
}

function _buildBankAccounts(accounts) {
  return accounts
    .filter(a => a.type === 'BANK')
    .map(a => ({
      accountId: a.accountID, code: a.code || '', name: a.name || '',
      accountNumber: a.bankAccountNumber || '', currency: a.currencyCode || '', status: a.status || '',
    }));
}

async function getBankAccounts(userId, tenantId, { force = false } = {}) {
  const key    = `bank:${userId}:${tenantId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getAccounts(tenantId, undefined, 'Type=="BANK"', 'Name ASC'));
  const data = { bankAccounts: _buildBankAccounts(res.body.accounts || []) };
  return _cacheSet(key, data);
}

function _buildContacts(contacts) {
  return contacts.map(c => ({
    contactId: c.contactID, name: c.name || 'Unknown', email: c.emailAddress || '',
    isCustomer: !!c.isCustomer, isSupplier: !!c.isSupplier, status: c.contactStatus || '',
  }));
}

async function getContacts(userId, tenantId, { force = false } = {}) {
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
  return _cacheSet(key, data);
}

// ── Bank statement, Profit & Loss, Cash In/Out ───────────────────────────────
// Everything below needs the three wider scopes added alongside this feature
// (accounting.banktransactions.read, accounting.reports.profitandloss.read,
// accounting.reports.banksummary.read) — see xero/oauth.js for why that means
// a one-time reconnect for anyone already connected under the old scope list.

function _buildBankTransactions(transactions) {
  return transactions.map(t => ({
    transactionId: t.bankTransactionID,
    type:          t.type === 'RECEIVE' ? 'Money In' : 'Money Out',
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
// shows up in getBankTransactions at all. paymentType's 8 real values (per
// the xero-node SDK) aren't uniformly prefixed — the two common ones are
// ACCRECPAYMENT/ACCPAYPAYMENT (confirmed live), and only the other 6
// credit-note/overpayment/prepayment variants actually start with AR/AP, so
// "contains REC, or starts with AR" is what actually covers every
// receivable (money in) type; everything else is payable (money out).
function _buildPayments(payments) {
  return payments.map(p => ({
    transactionId: p.paymentID,
    type:          /REC/.test(p.paymentType || '') || (p.paymentType || '').startsWith('AR') ? 'Money In' : 'Money Out',
    contact:       p.invoice?.contact?.name || 'Unknown',
    reference:     p.reference || (p.invoice?.invoiceNumber ? `Payment - ${p.invoice.invoiceNumber}` : 'Payment'),
    date:          p.date ? new Date(p.date).toISOString().slice(0, 10) : null,
    total:         Number(p.amount || 0),
    isReconciled:  !!p.isReconciled,
    status:        p.status || '',
    source:        'payment',
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function getBankTransactions(userId, tenantId, accountId, { force = false } = {}) {
  const key    = `banktx:${userId}:${tenantId}:${accountId}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const res = await withRetry(() => api.getBankTransactions(
    tenantId, undefined, `BankAccount.AccountID==Guid("${accountId}")`, 'Date DESC'
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
      tenantId, undefined, `Account.AccountID==Guid("${accountId}")`, 'Date DESC'
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

// Xero's Report API returns a tree (sections contain rows contain cells) rather
// than flat fields — this walks it into a flat { title, cells } list so the P&L
// and Bank Summary builders below can just search by row title instead of
// knowing the tree shape. Pure, and exactly what's unit-tested — the real
// nested Xero response shape only needs to be right in the tests' fixtures.
function _flattenReportRows(rows, out = []) {
  for (const row of rows || []) {
    if (row.rows?.length) _flattenReportRows(row.rows, out);
    if (row.cells?.length) out.push({ title: row.title || row.cells[0]?.value || '', cells: row.cells.map(c => c.value) });
  }
  return out;
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

function _findRow(flatRows, pattern) {
  const row = flatRows.find(r => pattern.test(r.title));
  return row ? _parseReportNumber(row.cells[row.cells.length - 1]) : 0;
}

function _buildProfitAndLoss(reportRows) {
  const flat = _flattenReportRows(reportRows);
  const income   = _findRow(flat, /^total income$/i);
  const expenses = _findRow(flat, /^total expenses$/i) || _findRow(flat, /^total operating expenses$/i);
  // "Net Profit" is Xero's default label; some orgs' report layouts say "Net Loss"
  // instead when negative, or "Net Profit/(Loss)" — match broadly.
  const netProfit = _findRow(flat, /^net (profit|loss)/i) || (income - expenses);
  // Only net margin, not gross margin — the P&L data here doesn't separate a
  // Cost of Sales section from Operating Expenses, so there's no distinct
  // "gross profit" figure to divide by; fabricating one would be a guess.
  const netMargin = income > 0 ? netProfit / income : 0;
  return { income, expenses, netProfit, netMargin };
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

async function getProfitAndLoss(userId, tenantId, { from, to, force = false } = {}) {
  const clampedFrom = _clampReportFrom(from, to);
  const key    = `pnl:${userId}:${tenantId}:${clampedFrom}:${to}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const tokenCache = require('../utils/token-cache').forUser(userId);
  const token      = await tokenCache.getValidToken(tenantId);
  const api        = _apiFor(token);

  const windows = _splitIntoReportWindows(clampedFrom, to);
  let income = 0, expenses = 0;
  for (const w of windows) {
    const res  = await withRetry(() => api.getReportProfitAndLoss(tenantId, w.from, w.to));
    const part = _buildProfitAndLoss(res.body.reports?.[0]?.rows || []);
    income   += part.income;
    expenses += part.expenses;
  }
  const netProfit = income - expenses;
  const netMargin = income > 0 ? netProfit / income : 0;
  logger.info('Insights P&L fetched', { userId, tenantId, from: clampedFrom, to, windows: windows.length });
  return _cacheSet(key, { income, expenses, netProfit, netMargin, from: clampedFrom, to });
}

async function getBankSummary(userId, tenantId, { from, to, force = false } = {}) {
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

// Pure. `n` consecutive months starting at `start`, oldest first.
//
// Twelve months is a per-CALL limit, not a fiscal-year limit: ProfitAndLoss caps
// `periods` at 11 (12 columns) and BudgetSummary at 12, but both anchor on an
// arbitrary date. So any 12 consecutive months cost exactly one pair of calls —
// which is what lets the window slide off the fiscal year entirely.
function _rowValuesByLabel(reportRows, { reverse = false } = {}) {
  const out = new Map();
  (function walk(rows) {
    for (const row of rows || []) {
      if (row.rowType !== 'Header' && row.cells?.length > 1) {
        const label = (row.cells[0].value || '').trim();
        if (label && !out.has(label)) {
          const values = row.cells.slice(1).map(c => _parseReportNumber(c.value));
          out.set(label, reverse ? values.reverse() : values);
        }
      }
      if (row.rows?.length) walk(row.rows);
    }
  })(reportRows);
  return out;
}

// Pure. Row order/kind skeleton taken from BudgetSummary, which is the richer of
// the two: confirmed live that it returns every row the P&L does plus the
// budget-only accounts (Cost of Goods Sold, Other Income - Grant, the overheads),
// because the P&L omits any account with no actual transactions entirely.
//
// A section with an empty title holds a floating summary line — Gross Profit,
// Total Expenses, Net Profit — which is exactly how they sit in Xero's layout.
function _skeletonFromBudget(reportRows) {
  const out = [];
  for (const section of reportRows || []) {
    if (section.rowType === 'Header') continue;
    const title = (section.title || '').trim();
    if (title) out.push({ kind: 'section', label: title });
    for (const row of section.rows || []) {
      const label = (row.cells?.[0]?.value || '').trim();
      if (!label) continue;
      out.push({
        kind: !title ? 'summary' : (row.rowType === 'SummaryRow' ? 'subtotal' : 'account'),
        label,
        // Which section this row sits under, so downstream consumers can tell a
        // revenue account from an overhead without re-walking the tree.
        section: title,
      });
    }
  }
  return out;
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

// Pure. Stitches per-chunk report rows into one series spanning every month.
//
// Each chunk is an independent Xero response, so an account can be present in
// one and absent from another (the P&L omits accounts with no transactions in
// that span). Missing chunks are zero-filled at the right offset rather than
// shortening the series, otherwise months would silently slide.
function _mergeChunks(parts, totalMonths) {
  const budget = new Map(), actual = new Map(), skeleton = [];
  const seenRow = new Set(), seenSection = new Set();
  const put = (map, label, values, offset, n) => {
    if (!map.has(label)) map.set(label, Array(totalMonths).fill(0));
    const arr = map.get(label);
    for (let i = 0; i < n; i++) arr[offset + i] = values[i] || 0;
  };

  let offset = 0;
  for (const part of parts) {
    const n = part.months.length;
    for (const [label, vals] of _rowValuesByLabel(part.budgetRows))                  put(budget, label, vals, offset, n);
    for (const [label, vals] of _rowValuesByLabel(part.pnlRows, { reverse: true }))  put(actual, label, vals, offset, n);

    // Row order comes from the first chunk that contains each line, so the
    // report reads in Xero's own order rather than the order chunks happened to
    // introduce accounts.
    for (const row of _skeletonFromBudget(part.budgetRows)) {
      if (row.kind === 'section') {
        if (!seenSection.has(row.label)) { seenSection.add(row.label); skeleton.push(row); }
      } else if (!seenRow.has(row.label)) { seenRow.add(row.label); skeleton.push(row); }
    }
    offset += n;
  }
  return { budget, actual, skeleton };
}

// Pure. Merges the two reports into one flat, ordered row list.
//
// Each cell is actual OR budget depending on whether its month has fully
// elapsed — never both, and never a sum of the two. Subtotals are taken from
// whichever report supplied that column rather than recomputed, so they stay
// internally consistent with the figures above them.
function _buildBudgetVariance({ budgetRows, pnlRows, months, actualThroughIdx, merged }) {
  // `merged` is the multi-chunk path; the single-report path is unchanged so a
  // period that fits one Xero call pair behaves exactly as it always did.
  const budget   = merged ? merged.budget   : _rowValuesByLabel(budgetRows);
  const actual   = merged ? merged.actual   : _rowValuesByLabel(pnlRows, { reverse: true });
  const skeleton = merged ? merged.skeleton : _skeletonFromBudget(budgetRows);

  // An account with actuals but no budget appears only in the P&L. Rare (this
  // org has none), but dropping it would silently understate the report, so it
  // gets appended under its own heading rather than omitted.
  const known    = new Set(skeleton.map(r => r.label));
  const pnlOnly  = [...actual.keys()].filter(l => !known.has(l));
  if (pnlOnly.length) {
    skeleton.push({ kind: 'section', label: 'Other (actuals only, not budgeted)' });
    for (const label of pnlOnly) skeleton.push({ kind: 'account', label });
  }

  const elapsed = actualThroughIdx + 1;
  const rows = skeleton.map(row => {
    if (row.kind === 'section') return { ...row };
    const a = actual.get(row.label) || [];
    const b = budget.get(row.label) || [];
    const cells = months.map((_, i) => (i <= actualThroughIdx ? (a[i] || 0) : (b[i] || 0)));

    // Per-month actual/budget/variance, kept for every month including ones not
    // yet elapsed. Xero's own Budget Variance report compares the CURRENT
    // (part-elapsed) month too — confirmed against the org's report, which shows
    // August actuals of 52,000 against a 17,615 August budget — so the actuals
    // can't be suppressed here the way the monthly grid suppresses them.
    const monthly = months.map((_, i) => {
      const av = a[i] || 0, bv = b[i] || 0;
      return { actual: av, budget: bv, variance: av - bv, variancePct: _variancePct(av - bv, bv) };
    });

    // Year-to-date rolls up the fully elapsed months only.
    let actualToDate = 0, budgetToDate = 0;
    for (let i = 0; i < elapsed; i++) { actualToDate += a[i] || 0; budgetToDate += b[i] || 0; }
    const variance = actualToDate - budgetToDate;

    return {
      ...row,
      cells,
      total:        cells.reduce((s, v) => s + v, 0),
      monthly,
      actualToDate,
      budgetToDate,
      variance,
      variancePct: _variancePct(variance, budgetToDate),
    };
  });

  const net = rows.find(r => r.kind === 'summary' && /^net (profit|loss)/i.test(r.label));
  return {
    rows,
    kpis: {
      monthsElapsed:  elapsed,
      monthsTotal:    months.length,
      ytdActualNet:   net ? net.actualToDate : 0,
      restOfYearNet:  net ? net.cells.slice(elapsed).reduce((s, v) => s + v, 0) : 0,
      forecastNet:    net ? net.total : 0,
    },
  };
}

async function getBudgetVariance(userId, tenantId, { force = false, timezone = 'UTC', window = 'fy', period } = {}) {
  const org           = await _getOrganisation(userId, tenantId, force);
  const fiscalYearEnd = { month: org.financialYearEndMonth || 12, day: org.financialYearEndDay || 31 };
  const today         = _todayPartsInTz(timezone);
  const win           = period ? _resolvePeriod(period, today, fiscalYearEnd)
                               : _resolveWindow(window, today, fiscalYearEnd);
  const months        = win.months;
  const actualThroughIdx = _actualThroughIndex(months, today);

  // The exact span is part of the key — two periods are two different reports,
  // and serving one for the other would silently show the wrong months.
  const key    = `budgetvar:${userId}:${tenantId}:${months[0].key}:${months[months.length - 1].key}:${actualThroughIdx}`;
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
  const parts = await _mapWithConcurrency(chunks, REPORT_CHUNK_CONCURRENCY, async (chunk) => {
    const first = chunk[0], last = chunk[chunk.length - 1];
    const n = chunk.length;
    const [pnlRes, budRes] = await Promise.all([
      // Anchored on the LAST month — periods counts backwards from here. A
      // single month has no comparison periods at all, so `periods` is omitted
      // rather than passed as 0, which the endpoint rejects.
      withRetry(() => (n === 1
        ? api.getReportProfitAndLoss(tenantId, first.startISO, last.endISO)
        : api.getReportProfitAndLoss(tenantId, last.startISO, last.endISO, n - 1, 'MONTH'))),
      // Anchored on the FIRST month — periods counts forwards from here. timeframe 1 = month.
      withRetry(() => api.getReportBudgetSummary(tenantId, first.endISO, n, 1)),
    ]);
    return {
      months: chunk,
      budgetRows: budRes.body.reports?.[0]?.rows || [],
      pnlRows:    pnlRes.body.reports?.[0]?.rows || [],
    };
  });

  const built = _buildBudgetVariance({
    months, actualThroughIdx,
    merged: _mergeChunks(parts, months.length),
  });

  // Re-derived here: the loop above scopes its own first/last to each chunk.
  const first = months[0], last = months[months.length - 1];
  const end = _parseISODate(last.endISO);
  const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  // Only a true fiscal-year window can honestly be called "the year ended X".
  const periodLabel = win.key === 'fy'
    ? `For the year ended ${end.day} ${MONTHS_LONG[end.month - 1]} ${end.year}`
    : `${win.label} · ${months[0].label} – ${last.label}`;
  logger.info('Budget vs Actual fetched', {
    userId, tenantId, period: win.key, range: `${first.key}..${last.key}`,
    months: months.length, chunks: chunks.length, actualMonths: actualThroughIdx + 1,
  });

  return _cacheSet(key, {
    organisation: { name: org.name || org.legalName || 'Organisation', currency: org.baseCurrency || '' },
    fiscalYear:   { label: periodLabel, fromISO: first.startISO, toISO: last.endISO },
    budgets,
    period:       { key: win.key, label: win.label, months: months.length, chunks: chunks.length,
                    fromKey: months[0].key, toKey: months[months.length - 1].key },
    months:       months.map((m, i) => ({ key: m.key, label: m.label, source: i <= actualThroughIdx ? 'actual' : 'budget' })),
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
function _sectionKind(section) {
  const s = (section || '').trim();
  if (/^less cost of sales/i.test(s))                      return 'cogs';
  if (/^less (operating expenses|overheads)/i.test(s))     return 'opex';
  if (/^other income/i.test(s))                            return 'otherIncome';
  if (/income|revenue|sales/i.test(s))                     return 'revenue';
  return 'other';
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
  const find = re => rows.find(r => r.kind !== 'section' && re.test(r.label));
  // A subtotal Xero didn't emit (this org books no cost of sales, so there's no
  // "Total Cost of Sales" row at all) must read as a flat zero series, not undefined.
  const seriesOf = row => ({
    actual: row ? row.monthly.map(m => m.actual) : _zeros(n),
    budget: row ? row.monthly.map(m => m.budget) : _zeros(n),
  });

  const totals = {
    revenue:     seriesOf(find(/^total income$/i)),
    otherIncome: seriesOf(find(/^total other income$/i)),
    cogs:        seriesOf(find(/^total cost of sales$/i)),
    grossProfit: seriesOf(find(/^gross profit$/i)),
    opex:        seriesOf(find(/^total operating expenses$/i)),
    netProfit:   seriesOf(find(/^net (profit|loss)/i)),
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

async function getPerformance(userId, tenantId, { timezone = 'UTC', force = false, window = 'fy', period, cashFlow = false, customers = false } = {}) {
  // Reuses the budget-variance fetch and its cache — on a warm cache this whole
  // endpoint costs one Xero call (the bank summary) rather than three.
  const bv = await getBudgetVariance(userId, tenantId, { timezone, force, window, period });

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
      const res = await withRetry(() => api.getInvoices(
        tenantId, undefined, where, 'Date DESC', undefined, undefined, undefined,
        ['AUTHORISED', 'PAID'], 1, undefined, undefined, undefined, true, // summaryOnly
      ));
      customerRevenue = _buildCustomerRevenue(res.body.invoices || [], baseCurrency);

      // Quoted-but-not-invoiced work exists commercially and nowhere in the
      // accounts, so the forward view otherwise stops at issued invoices.
      try {
        const qRes = await withRetry(() => api.getQuotes(tenantId));
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

async function getVarianceInsights(userId, tenantId, { timezone = 'UTC', force = false, reanalyse = false, period } = {}) {
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
  const cached = _cacheGet(key, force || reanalyse);
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
  _buildSupplierSpend,
} = require('./cash-flow');

async function getCashFlow(userId, tenantId, { timezone = 'UTC', force = false, period } = {}) {
  // Reuses the cached performance fetch for the P&L side, so the accrual-vs-cash
  // reconciliation compares like with like over the same months.
  const perf = await getPerformance(userId, tenantId, { timezone, force, period });
  const months = perf.months;
  const first  = perf.fiscalYear.fromISO, last = perf.fiscalYear.toISO;
  const today  = _todayPartsInTz(timezone);

  const key    = `cashflow:${userId}:${tenantId}:${months[0].key}:${months[months.length - 1].key}`;
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
    withRetry(() => api.getInvoices(tenantId, undefined, invoiceWhere, 'Date DESC', undefined, undefined, undefined,
      ['AUTHORISED', 'PAID'], 1, undefined, undefined, undefined, true)),
  ]);

  const invoices = invRes.body.invoices || [];
  const baseCurrency = perf.organisation?.currency || '';
  const movement = _buildCashMovement({
    payments:         payRes.body.payments || [],
    bankTransactions: btRes.body.bankTransactions || [],
    months,
    baseCurrency,
  });

  const S = a => a.reduce((x, y) => x + y, 0);
  const revenue  = S(perf.totals.revenue.actual);
  const expenses = S(perf.totals.cogs.actual) + S(perf.totals.opex.actual);
  const days     = Math.max(1, Math.round((_dateFromParts(_parseISODate(last)) - _dateFromParts(fromP)) / 86400000) + 1);

  const workingCapital = _buildWorkingCapital({ invoices, revenue, expenses, days, today, baseCurrency });
  // Scoped to the period on screen, not the wider window the invoice fetch uses
  // so the forecast can see older unpaid bills.
  const supplierSpend = _buildSupplierSpend(invoices, { baseCurrency, fromISO: first, toISO: last });
  const hygiene = _buildInvoiceHygiene(invoices, baseCurrency);
  const closing  = bank ? bank.accounts.reduce((s, a) => s + a.closingBalance, 0) : 0;
  const opening  = bank ? bank.accounts.reduce((s, a) => s + (a.openingBalance || 0), 0) : 0;
  const bankIn   = bank ? bank.cashIn  : 0;
  const bankOut  = bank ? bank.cashOut : 0;
  const forecast = _buildCashForecast({ invoices, openingBalance: closing, today, baseCurrency });
  const runway   = _buildRunway({ months, monthly: movement.monthly, closing, today });
  const waterfall = _buildCashWaterfall({ opening, closing, movement });

  // The bank statement is what actually happened. Payments and bank transactions
  // explain WHERE it came from — but they are separate records, and they can
  // disagree with the bank if something was recorded against a non-bank account
  // or never reconciled. Deriving the opening balance by subtraction hid that;
  // reading Xero's own opening balance exposes it instead.
  const unreconciled = {
    inGap:  Math.round((movement.cashIn  - bankIn)  * 100) / 100,
    outGap: Math.round((movement.cashOut - bankOut) * 100) / 100,
  };
  unreconciled.material = Math.abs(unreconciled.inGap) > 1 || Math.abs(unreconciled.outGap) > 1;

  const alerts = _buildAlerts({
    runway, workingCapital, forecast, unreconciled,
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
      // From the bank statement, not inferred from the payment records.
      cashIn: bankIn, cashOut: bankOut, net: bankIn - bankOut,
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
  const cached = _cacheGet(key, force);
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

async function getFinancialNarrative(userId, tenantId, { timezone = 'UTC', force = false, reanalyse = false, period } = {}) {
  // Only `force` reaches Xero. `reanalyse` reuses whatever is cached and simply
  // asks the model again.
  const cf = await getCashFlow(userId, tenantId, { timezone, force, period });
  return _narrateFrom(userId, tenantId, cf, { force: force || reanalyse });
}

// Called on disconnect so nothing here can outlive the connection it came from.
function clearCache(userId) {
  for (const key of _cache.keys()) {
    if (key.includes(`:${userId}:`)) _cache.delete(key);
  }
}

module.exports = {
  getSummary, getPeriod, getAccounts, getBankAccounts, getContacts,
  getBankTransactions, getProfitAndLoss, getBankSummary, getBudgetVariance, getPerformance, getCashFlow, getVarianceInsights, getFinancialNarrative, clearCache,
  _buildSummary, _buildPeriod, computeRange, _buildAccounts, _buildBankAccounts, _buildContacts,
  _buildBankTransactions, _buildPayments, _buildProfitAndLoss, _buildBankSummary, _flattenReportRows,
  _splitIntoReportWindows, _clampReportFrom,
  _fiscalYearMonths, _monthsFrom, _monthMeta, _monthsBetween, _chunkMonths,
  _resolveWindow, _resolvePeriod, _actualThroughIndex, _rowValuesByLabel, _skeletonFromBudget, _buildBudgetVariance,
  _mergeChunks, _buildCustomerRevenue, _buildInvoiceHygiene, _buildQuotePipeline, _buildCashMovement, _buildWorkingCapital, _buildCashForecast,
  _toBase, _foreignCurrency, _closedCount, _growthPct, _buildGrowth, _buildRunway, _buildCashWaterfall,
  _buildAlerts, ALERT_THRESHOLDS,
  _isTransfer, _isReceiptPayment, _periodCacheTtl, _mapWithConcurrency, _variancePct, _sectionKind, _isRecurringName, _buildPerformance, _buildWatchList,
  _largeNumbersIn, _insightIsGrounded, _varianceCandidates, _parseInsights, _buildCategoryVariances,
  _narrativeFacts, _groundNarrative, _narrativePrompt, _narrateFrom,
};
