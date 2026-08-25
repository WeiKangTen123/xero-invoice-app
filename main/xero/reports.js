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

function _todayPartsInTz(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}
function _dateFromParts({ year, month, day }) { return new Date(Date.UTC(year, month - 1, day)); }
function _partsFromDate(d) { return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; }
function _addDays(parts, n) { const d = _dateFromParts(parts); d.setUTCDate(d.getUTCDate() + n); return _partsFromDate(d); }
function _weekdayMon0(parts) { return (_dateFromParts(parts).getUTCDay() + 6) % 7; } // 0=Mon..6=Sun
function _fmtXeroDate(p) { return `DateTime(${p.year},${p.month},${p.day})`; }
function _fmtISODate(p) { return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; }
function _parseISODate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
}

const RANGE_PRESETS = new Set(['day', 'week', 'month', 'year', 'all', 'custom']);

// "All time" has no real org-inception date available without an extra
// lookup, so it uses a fixed anchor far enough back that no real Xero org
// predates it — functionally identical to "since inception" as a filter
// bound, without needing to query for the actual first transaction date.
const ALL_TIME_START = { year: 2000, month: 1, day: 1 };

// The org's fiscal year doesn't necessarily run Jan-Dec (Xero's own "Year to
// date" dashboard widget uses it, not the calendar year) — defaults to a
// calendar year (Dec 31 end) when the caller doesn't have fiscal-year-end
// info to hand, which reproduces the old hardcoded Jan-1 behavior exactly.
function _fiscalYearStart(today, fiscalYearEnd) {
  const feMonth = fiscalYearEnd?.month || 12;
  const feDay   = fiscalYearEnd?.day   || 31;
  const thisCalendarYearEnd = { year: today.year, month: feMonth, day: feDay };
  // "Today" is inside the fiscal year that ends on the NEXT occurrence of the
  // fiscal-year-end date — so if that date (this calendar year) hasn't
  // happened yet, the current fiscal year started the year before.
  const endYear = _dateFromParts(today) <= _dateFromParts(thisCalendarYearEnd) ? today.year - 1 : today.year;
  return _addDays({ year: endYear, month: feMonth, day: feDay }, 1);
}

// Pure. Returns { preset, fromISO, toISO, where, days } — `where` is a ready-to-use
// Xero filter clause; `toExclusive` never leaks out since every caller only needs
// an inclusive display range or the filter string. `fiscalYearEnd` (optional
// { month, day }) only affects the 'year' preset.
function computeRange(preset, timezone, customFrom, customTo, fiscalYearEnd) {
  const today = _todayPartsInTz(timezone || 'UTC');
  const usePreset = RANGE_PRESETS.has(preset) ? preset : 'month';

  let from, toExclusive;
  if (usePreset === 'day') {
    from = today; toExclusive = _addDays(today, 1);
  } else if (usePreset === 'week') {
    from = _addDays(today, -_weekdayMon0(today)); toExclusive = _addDays(today, 1);
  } else if (usePreset === 'year') {
    from = _fiscalYearStart(today, fiscalYearEnd); toExclusive = _addDays(today, 1);
  } else if (usePreset === 'all') {
    from = ALL_TIME_START; toExclusive = _addDays(today, 1);
  } else if (usePreset === 'custom') {
    const f = _parseISODate(customFrom), t = _parseISODate(customTo);
    if (!f || !t) throw new Error('Custom range requires valid "from" and "to" dates (YYYY-MM-DD)');
    if (_dateFromParts(f) > _dateFromParts(t)) throw new Error('"from" must not be after "to"');
    from = f; toExclusive = _addDays(t, 1);
  } else { // month
    from = { year: today.year, month: today.month, day: 1 }; toExclusive = _addDays(today, 1);
  }

  const toInclusive = _addDays(toExclusive, -1);
  const days = Math.round((_dateFromParts(toExclusive) - _dateFromParts(from)) / 86400000);

  return {
    preset:  usePreset,
    fromISO: _fmtISODate(from),
    toISO:   _fmtISODate(toInclusive),
    where:   `Date >= ${_fmtXeroDate(from)} && Date < ${_fmtXeroDate(toExclusive)}`,
    days,
  };
}

// Pure. Buckets invoices dated within the range into a trend series — daily
// buckets for anything a month or shorter (a week or a month both read fine as
// individual days), monthly buckets for anything longer (a year of daily points
// would be an unreadable chart).
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
      const existing = byAccount.get(acc.name) || { name: acc.name, cashReceived: 0, cashSpent: 0, closingBalance: 0 };
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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Pure. `n` consecutive months starting at `start`, oldest first.
//
// Twelve months is a per-CALL limit, not a fiscal-year limit: ProfitAndLoss caps
// `periods` at 11 (12 columns) and BudgetSummary at 12, but both anchor on an
// arbitrary date. So any 12 consecutive months cost exactly one pair of calls —
// which is what lets the window slide off the fiscal year entirely.
function _monthMeta(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // computed, so February is right in leap years
  return {
    key:      `${y}-${String(m).padStart(2, '0')}`,
    label:    `${MONTH_NAMES[m - 1]} ${y}`,
    startISO: _fmtISODate({ year: y, month: m, day: 1 }),
    endISO:   _fmtISODate({ year: y, month: m, day: lastDay }),
  };
}

function _monthsFrom(start, n = 12) {
  return Array.from({ length: n }, (_, i) => _monthMeta(start.year, start.month + i));
}

// Pure. Every month from `fromKey` to `toKey` inclusive, any span. Reversed
// inputs are swapped rather than rejected — a from/to the user dragged backwards
// is an obvious intent, not an error worth blocking on.
function _monthsBetween(fromKey, toKey) {
  const parse = k => { const m = /^(\d{4})-(\d{1,2})$/.exec(String(k || '')); return m ? { year: +m[1], month: +m[2] } : null; };
  let a = parse(fromKey), b = parse(toKey);
  if (!a || !b) return null;
  const idx = p => p.year * 12 + (p.month - 1);
  if (idx(a) > idx(b)) [a, b] = [b, a];
  const n = idx(b) - idx(a) + 1;
  return Array.from({ length: n }, (_, i) => _monthMeta(a.year, a.month + i));
}

// Pure. Splits a month list into consecutive chunks of at most `size`.
// Twelve is the ceiling of a single Xero call pair, so a longer period simply
// becomes several pairs rather than being refused.
function _chunkMonths(months, size = 12) {
  const out = [];
  for (let i = 0; i < months.length; i += size) out.push(months.slice(i, i + size));
  return out;
}

// Pure. The 12 months of the fiscal year containing `today`.
function _fiscalYearMonths(today, fiscalYearEnd) {
  return _monthsFrom(_fiscalYearStart(today, fiscalYearEnd));
}

// Pure. Resolves what the user asked for into an explicit month list.
//
// Presets are computed from the ORG's own fiscal year end, never a hardcoded
// one: "financial year to date" is Apr-to-now for a March year end and
// Jan-to-now for a December one, without either org configuring anything. That
// matters because different organisations connect to this app.
//
// Any span is allowed. Twelve months is the ceiling of a single Xero call pair,
// not of a period — a longer one is fetched as several pairs (see _chunkMonths).
function _resolvePeriod(spec, today, fiscalYearEnd) {
  const s = typeof spec === 'string' ? { preset: spec } : (spec || {});
  const fyStart = _fiscalYearStart(today, fiscalYearEnd);
  const nowKey  = `${today.year}-${String(today.month).padStart(2, '0')}`;
  const shift   = (parts, n) => _partsFromDate(new Date(Date.UTC(parts.year, parts.month - 1 + n, 1)));
  const key     = p => `${p.year}-${String(p.month).padStart(2, '0')}`;
  const span    = (a, b, label, k) => ({ key: k, label, months: _monthsBetween(key(a), key(b)) });
  const quarterStart = m => m - ((m - 1) % 3);

  // An explicit range always wins — it is the most specific thing the user can say.
  if (s.from && s.to) {
    const months = _monthsBetween(s.from, s.to);
    if (months) return { key: 'custom', label: `${months[0].label} – ${months[months.length - 1].label}`, months };
  }

  const P = String(s.preset || 'fy-ytd');
  switch (P) {
    case 'this-month':   return span(today, today, 'This month', P);
    case 'last-month':   { const m = shift(today, -1); return span(m, m, 'Last month', P); }
    case 'this-quarter': { const q = { ...today, month: quarterStart(today.month) }; return span(q, shift(q, 2), 'This quarter', P); }
    case 'last-quarter': { const q = shift({ ...today, month: quarterStart(today.month) }, -3); return span(q, shift(q, 2), 'Last quarter', P); }
    case 'fy-ytd':       return span(fyStart, today, 'Financial year to date', P);
    case 'cy-ytd':       return span({ year: today.year, month: 1 }, today, 'Calendar year to date', P);
    case 'fy':           return span(fyStart, shift(fyStart, 11), 'This financial year', P);
    case 'prev-fy':      { const f = shift(fyStart, -12); return span(f, shift(f, 11), 'Previous financial year', P); }
    case 'next-fy':      { const f = shift(fyStart, 12);  return span(f, shift(f, 11), 'Next financial year', P); }
    case 'cy':           return span({ year: today.year, month: 1 }, { year: today.year, month: 12 }, `Calendar year ${today.year}`, P);
    case 'rolling':
    case 'last-12':      return span(shift(today, -11), today, 'Last 12 months', P);
    case 'last-6':       return span(shift(today, -5),  today, 'Last 6 months', P);
    case 'last-3':       return span(shift(today, -2),  today, 'Last 3 months', P);
    default: break;
  }

  // Legacy YYYY-MM window: the 12 months ENDING at that month.
  const m = /^(\d{4})-(\d{2})$/.exec(P);
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    const end = { year: +m[1], month: +m[2] };
    const months = _monthsBetween(key(shift(end, -11)), key(end));
    return { key: P, label: `12 months to ${months[11].label}`, months };
  }

  // Unrecognised input must not blank the dashboard.
  return span(fyStart, today, 'Financial year to date', 'fy-ytd');
}

// Back-compat shim. The older window keys always meant a 12-month span, and the
// Budget tabs still use them — so an unrecognised value must fall back to the
// full fiscal year here, NOT to the new year-to-date default. A budget report
// silently switching from 12 months to 5 would be a real reporting error.
function _resolveWindow(key, today, fiscalYearEnd) {
  const k = String(key || '');
  if (k === 'rolling') return _resolvePeriod('last-12', today, fiscalYearEnd);
  if (['fy', 'prev-fy', 'next-fy'].includes(k)) return _resolvePeriod(k, today, fiscalYearEnd);
  const m = /^(\d{4})-(\d{2})$/.exec(k);
  if (m && +m[2] >= 1 && +m[2] <= 12) return _resolvePeriod(k, today, fiscalYearEnd);
  return _resolvePeriod('fy', today, fiscalYearEnd);
}

// Pure. Index of the last FULLY elapsed month, or -1 if none has completed.
//
// A partially elapsed month must read as budget, not actual: confirmed live that
// Aug 2026 already had 52,000 of real sales but zero booked costs, so showing it
// as "actual" mid-month invents a profit spike. This is the same rule Xero's own
// custom layout uses.
function _actualThroughIndex(months, today) {
  const todayDate = _dateFromParts(today);
  let idx = -1;
  for (let i = 0; i < months.length; i++) {
    if (_dateFromParts(_parseISODate(months[i].endISO)) < todayDate) idx = i;
  }
  return idx;
}

// Pure. label -> 12 monthly values. `reverse` flips ProfitAndLoss's newest-first
// columns into the oldest-first order the month list uses.
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
  const chunks = _chunkMonths(months, 12);
  const parts  = [];
  for (const chunk of chunks) {
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
    parts.push({
      months: chunk,
      budgetRows: budRes.body.reports?.[0]?.rows || [],
      pnlRows:    pnlRes.body.reports?.[0]?.rows || [],
    });
  }

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
    period:       { key: win.key, label: win.label, months: months.length, chunks: chunks.length,
                    fromKey: months[0].key, toKey: months[months.length - 1].key },
    months:       months.map((m, i) => ({ key: m.key, label: m.label, source: i <= actualThroughIdx ? 'actual' : 'budget' })),
    ...built,
  });
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

async function getPerformance(userId, tenantId, { timezone = 'UTC', force = false, window = 'fy', period } = {}) {
  // Reuses the budget-variance fetch and its cache — on a warm cache this whole
  // endpoint costs one Xero call (the bank summary) rather than three.
  const bv = await getBudgetVariance(userId, tenantId, { timezone, force, window, period });

  const first = bv.fiscalYear.fromISO;
  const today = _fmtISODate(_todayPartsInTz(timezone));
  let cash = { total: 0, cashIn: 0, cashOut: 0, net: 0, accounts: [], available: false };
  try {
    const bank = await getBankSummary(userId, tenantId, { from: first, to: today, force });
    cash = {
      total:     bank.accounts.reduce((s, a) => s + a.closingBalance, 0),
      // Cash movement, not just the closing position — the Banking tab renders
      // this, which is why the old standalone Cash In/Out fetch could go.
      cashIn:    bank.cashIn,
      cashOut:   bank.cashOut,
      net:       bank.net,
      accounts:  bank.accounts.map(a => ({ name: a.name, balance: a.closingBalance, cashIn: a.cashReceived, cashOut: a.cashSpent })),
      available: true,
    };
  } catch (err) {
    // Cash is one card out of many — a bank-scope problem shouldn't blank the
    // whole dashboard, so it degrades to "—" instead.
    if (!isScopeError(err)) logger.warn('Performance: bank summary failed', { userId, tenantId, error: err.message });
    else logger.info('Performance: bank summary skipped — scope not granted', { userId, tenantId });
  }

  const actualThroughIdx = bv.months.filter(m => m.source === 'actual').length - 1;
  const built = _buildPerformance({ months: bv.months, rows: bv.rows, cash });
  const watchList = _buildWatchList({ months: bv.months, totals: built.totals, actualThroughIdx });

  logger.info('Performance overview built', { userId, tenantId, serviceLines: built.serviceLines.length, actualMonths: actualThroughIdx + 1 });

  return {
    organisation:     bv.organisation,
    fiscalYear:       bv.fiscalYear,
    period:           bv.period,
    months:           bv.months,
    actualThroughIdx,
    ...built,
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

const INSIGHT_CACHE_TTL_MS = 30 * 60 * 1000; // reasons only change when the figures do
const MIN_VARIANCE_TO_EXPLAIN = 1;           // ignore rounding dust

// Numbers big enough to be a money amount rather than a percentage or a count.
function _largeNumbersIn(text) {
  return (String(text).match(/-?[\d][\d,]*(?:\.\d+)?/g) || [])
    .map(t => Math.abs(Number(t.replace(/,/g, ''))))
    .filter(n => Number.isFinite(n) && n >= 1000);
}

// Pure. True if every large number in `text` was one we supplied.
function _insightIsGrounded(text, allowed) {
  return _largeNumbersIn(text).every(n => allowed.has(Math.round(n)));
}

// Pure. The variance lines worth explaining, biggest absolute gap first.
function _varianceCandidates(perf, limit = 6) {
  const all = [...perf.serviceLines, ...perf.expenseLines].map(l => {
    const actual = l.actual.reduce((s, v) => s + v, 0);
    const budget = l.budget.reduce((s, v) => s + v, 0);
    return { account: l.label, actual, budget, variance: actual - budget };
  });
  return all
    .filter(l => Math.abs(l.variance) >= MIN_VARIANCE_TO_EXPLAIN)
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, limit);
}

function _insightPrompt(org, fyLabel, closedMonths, candidates) {
  return [
    {
      role: 'system',
      content: [
        'You are a finance analyst writing one-line variance commentary for a management dashboard.',
        'You will receive REAL figures already computed from the Xero accounting system.',
        'Rules you must follow exactly:',
        '1. NEVER invent, recalculate, estimate or infer any monetary figure. Use only the numbers given to you.',
        '2. Prefer not to repeat the numbers at all — they are already displayed next to your text.',
        '3. Explain the LIKELY OPERATIONAL REASON and what the reader should check. Phrase it as something to verify, not as established fact.',
        '4. If actual is zero against a non-zero budget, the most likely reason is simply that nothing has been recorded against that account yet. Say that plainly.',
        '5. One sentence per account. Max 22 words. No preamble, no markdown, no bullet characters.',
        'Reply with JSON only: {"reasons":[{"account":"<exact account name>","reason":"<one sentence>"}]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        organisation: org,
        financialYear: fyLabel,
        monthsClosed: closedMonths,
        note: 'variance = actual - budget. Negative means under budget.',
        lines: candidates.map(c => ({
          account: c.account,
          actual: Math.round(c.actual),
          budget: Math.round(c.budget),
          variance: Math.round(c.variance),
        })),
      }),
    },
  ];
}

// Pure. Parses the model reply and keeps only grounded, matchable lines.
function _parseInsights(raw, candidates) {
  let payload;
  try {
    // Models sometimes wrap JSON in a code fence despite being told not to.
    const cleaned = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    payload = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
  } catch {
    return [];
  }
  const allowed = new Set();
  for (const c of candidates) {
    for (const v of [c.actual, c.budget, c.variance]) allowed.add(Math.round(Math.abs(v)));
  }
  const byName = new Map(candidates.map(c => [c.account, c]));

  return (payload.reasons || [])
    .map(r => ({ account: String(r.account || '').trim(), reason: String(r.reason || '').trim() }))
    // Only accounts we actually asked about — a name we didn't send is a fabrication.
    .filter(r => byName.has(r.account) && r.reason)
    .filter(r => _insightIsGrounded(r.reason, allowed))
    .map(r => ({ ...byName.get(r.account), reason: r.reason }));
}

async function getVarianceInsights(userId, tenantId, { timezone = 'UTC', force = false } = {}) {
  const perf = await getPerformance(userId, tenantId, { timezone, force });
  const candidates = _varianceCandidates(perf);
  const closed = perf.actualThroughIdx + 1;

  if (!candidates.length) {
    return { generated: false, reason: 'Nothing differs from budget yet.', lines: [], source: 'none' };
  }

  // Keyed on the figures themselves, so the model is re-asked only when the
  // numbers actually move — not once per page view.
  const sig = candidates.map(c => `${c.account}:${Math.round(c.variance)}`).join('|');
  const key = `insights:${userId}:${tenantId}:${sig}`;
  const cached = _cacheGet(key, force);
  if (cached) return cached;

  const { callGemini } = require('../utils/gemini-client');
  try {
    const messages = _insightPrompt(perf.organisation.name, perf.fiscalYear.label, closed, candidates);
    const res = await callGemini(userId, messages, { temperature: 0.2, maxTokens: 700 });
    const lines = _parseInsights(res?.message?.content ?? res?.content ?? res, candidates);
    if (!lines.length) {
      logger.warn('Variance insights: model reply unusable, falling back to figures only', { userId, tenantId });
      return { generated: false, reason: 'Could not generate commentary — showing the figures alone.', lines: candidates, source: 'figures' };
    }
    logger.info('Variance insights generated', { userId, tenantId, lines: lines.length, dropped: candidates.length - lines.length });
    return _cacheSet(key, { generated: true, lines, source: 'gemini' }, INSIGHT_CACHE_TTL_MS);
  } catch (err) {
    // No API key, exhausted quota, or a bad response — the dashboard still shows
    // every real figure, just without the commentary.
    logger.warn('Variance insights unavailable', { userId, tenantId, error: err.message });
    return { generated: false, reason: 'AI commentary unavailable — showing the figures alone.', lines: candidates, source: 'figures' };
  }
}

// Called on disconnect so nothing here can outlive the connection it came from.
function clearCache(userId) {
  for (const key of _cache.keys()) {
    if (key.includes(`:${userId}:`)) _cache.delete(key);
  }
}

module.exports = {
  getSummary, getPeriod, getAccounts, getBankAccounts, getContacts,
  getBankTransactions, getProfitAndLoss, getBankSummary, getBudgetVariance, getPerformance, getVarianceInsights, clearCache,
  _buildSummary, _buildPeriod, computeRange, _buildAccounts, _buildBankAccounts, _buildContacts,
  _buildBankTransactions, _buildPayments, _buildProfitAndLoss, _buildBankSummary, _flattenReportRows,
  _splitIntoReportWindows, _clampReportFrom,
  _fiscalYearMonths, _monthsFrom, _monthMeta, _monthsBetween, _chunkMonths,
  _resolveWindow, _resolvePeriod, _actualThroughIndex, _rowValuesByLabel, _skeletonFromBudget, _buildBudgetVariance,
  _mergeChunks, _variancePct, _sectionKind, _isRecurringName, _buildPerformance, _buildWatchList,
  _largeNumbersIn, _insightIsGrounded, _varianceCandidates, _parseInsights,
};
