const { withRetry, isScopeError } = require('./xero-utils');
const logger             = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe } = require('./report-cache');
const { _apiFor, _allPages, _parseReportNumber, getBankAccounts } = require('./report-fetch');
const { _isLive, _isReceiptPayment } = require('./cash-flow');
const {
  _addDays,
  _dateFromParts,
  _fmtISODate,
  _fmtXeroDate,
  _parseISODate,
  _partsFromDate,
} = require('./periods');

// What the bank says: one account's statement, the Bank Summary report across
// every account, and the account list read for each line's currency.
//
// These are the bank's own figures, read as Xero gives them. The dashboard
// reads its cash balance from here and the Cash Flow tab sets the payment and
// bank-transaction records against them, so both import them from here rather
// than one reaching into the other.

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
  // And paged within that year (see _allPages), so a busy account costs a few
  // pages rather than one response of everything.
  const since = _fmtXeroDate(_addDays(_partsFromDate(new Date()), -365));
  const bankTransactions = await _allPages(page => api.getBankTransactions(
    tenantId, undefined, `BankAccount.AccountID==Guid("${accountId}") && Date >= ${since}`, 'Date DESC', page
  ), 'bankTransactions', { what: 'Bank transaction', tenantId });

  // Bank transactions alone miss real cash movement that goes through
  // Payment records instead (paying a bill, receiving a customer payment
  // against an invoice — confirmed against live data, never shows up in
  // getBankTransactions). Fetched separately, own try/catch: anyone who
  // hasn't reconnected under the accounting.payments.read scope yet still
  // gets a working (bank-transactions-only) statement instead of the whole
  // view breaking on their scope error.
  let payments = [];
  try {
    payments = _buildPayments(await _allPages(page => api.getPayments(
      tenantId, undefined, `Account.AccountID==Guid("${accountId}") && Date >= ${since}`, 'Date DESC', page
    ), 'payments', { what: 'Payment', tenantId }));
  } catch (err) {
    if (!isScopeError(err)) throw err; // a real failure, not just a missing scope, should still surface
    logger.info('Skipping Payments in statement — not yet reconnected under accounting.payments.read', { userId, tenantId });
  }

  const transactions = [..._buildBankTransactions(bankTransactions), ...payments]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const data = { transactions };
  return _cacheSet(key, data);
}

// The bank account list, read for the currency of each Bank Summary line (see
// _bankByCurrency). It is directory data, cached for hours, so on a warm cache
// this costs nothing. Never fails a report: without it every line is taken to
// be in base currency, as every total assumed before the list was consulted.
async function _bankAccountList(userId, tenantId, force) {
  try {
    return (await getBankAccounts(userId, tenantId, { force })).bankAccounts || [];
  } catch (err) {
    logger.warn('Bank account currencies unavailable; bank totals assume base currency', { userId, tenantId, error: err.message });
    return [];
  }
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

// Bound after the declarations, through the one in-flight map in
// ./report-cache, so the dashboard and the Cash Flow tab asking for the same
// Bank Summary share one request with each other and with routes.
const getBankTransactions    = _dedupe('getBankTransactions', _getBankTransactionsRaw);
const getBankSummary         = _dedupe('getBankSummary', _getBankSummaryRaw);

module.exports = {
  getBankTransactions, getBankSummary, _bankAccountList,
  _buildBankTransactions, _buildPayments, _buildBankSummary,
  _splitIntoReportWindows, _clampReportFrom,
};
