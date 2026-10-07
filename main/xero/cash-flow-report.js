const logger             = require('../utils/logger');
const { _cacheGet, _cacheSet, _dedupe, _periodCacheTtl } = require('./report-cache');
const { _apiFor, _allInvoices, _allPages } = require('./report-fetch');
const { getBankSummary, _bankAccountList } = require('./bank');
const { getPerformance } = require('./performance');
const { _foreignCurrency } = require('./currency');
const { _addDays, _fmtXeroDate, _parseISODate, _todayPartsInTz } = require('./periods');
const {
  _buildAlerts,
  _buildCashForecast,
  _buildCashMovement,
  _buildCashWaterfall,
  _buildRunway,
  _buildWorkingCapital,
  _buildSupplierSpend,
  _buildUnreconciled,
  _bankByCurrency,
  _recordAccountId,
} = require('./cash-flow');

// The Cash Flow tab as a fetch: getCashFlow reads Xero's payment, bank
// transaction and invoice records and hands them to ./cash-flow, where all of
// the arithmetic is and every function is pure. This is the part that needs a
// token, the bank's own figures from ./bank, and the P&L side from
// getPerformance.

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

// How far before the reporting period we will look for still-open invoices.
// Trades forecast completeness against Xero's per-GB egress billing.
const INVOICE_LOOKBACK_MONTHS = 24;

// Here because getCashFlow is its only caller, over the invoices it has
// already fetched.
//
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

  // Every call here is a GET. Nothing in this path writes to Xero. Payments and
  // bank transactions are paged (see _allPages).
  const [bank, bankAccounts, payments, bankTransactions, invRes] = await Promise.all([
    getBankSummary(userId, tenantId, { from: first, to: last, force }).catch(err => {
      logger.warn('Cash flow: bank summary unavailable', { userId, error: err.message });
      return null;
    }),
    _bankAccountList(userId, tenantId, force),
    _allPages(page => api.getPayments(tenantId, undefined, dateWhere, 'Date DESC', page), 'payments', { what: 'Payment', tenantId })
      .catch(err => { logger.warn('Cash flow: payments unavailable', { userId, error: err.message }); return []; }),
    _allPages(page => api.getBankTransactions(tenantId, undefined, dateWhere, 'Date DESC', page), 'bankTransactions', { what: 'Bank transaction', tenantId })
      .catch(err => { logger.warn('Cash flow: bank transactions unavailable', { userId, error: err.message }); return []; }),
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
  const movement = _buildCashMovement({ payments, bankTransactions, months, baseCurrency });

  // The bank's figures below are its base-currency accounts only (see
  // _bankByCurrency). The records are every account's, converted to base, and
  // stay that way for the movement shown on this tab. But where they are set
  // against the bank — the tie-out and the waterfall — a record moved through
  // an account the bank figures leave out has nothing on the other side to
  // meet, and would read as a gap that is only the currency. So those two
  // compare the base-currency accounts' records with the base-currency
  // accounts' figures.
  const byCur = bank ? _bankByCurrency(bank, bankAccounts, baseCurrency) : null;
  const foreignIds = new Set((byCur?.foreignAccounts || []).map(a => a.accountId).filter(Boolean));
  const inBase = r => !foreignIds.has(_recordAccountId(r));
  const banked = foreignIds.size
    ? _buildCashMovement({ payments: payments.filter(inBase), bankTransactions: bankTransactions.filter(inBase), months, baseCurrency })
    : movement;

  const S = a => a.reduce((x, y) => x + y, 0);
  const revenue  = S(perf.totals.revenue.actual);

  // Debtor and creditor days are the period's one figure from getPerformance,
  // the same one the Overview shows, not a second calculation here.
  const workingCapital = _buildWorkingCapital({ invoices, today, baseCurrency, paymentDays: perf.paymentDays });
  // Scoped to the period on screen, not the wider window the invoice fetch uses
  // so the forecast can see older unpaid bills.
  const supplierSpend = _buildSupplierSpend(invoices, { baseCurrency, fromISO: first, toISO: last });
  const hygiene = _buildInvoiceHygiene(invoices, baseCurrency);
  // Base-currency accounts only, so a lower figure than the sum of every
  // account whenever one is in another currency; the payload says so. The
  // forecast, the runway and the cover alert start from it too, which errs on
  // the side of less cash rather than adding unlike currencies.
  const closing  = byCur ? byCur.closing : 0;
  const opening  = byCur ? byCur.opening : 0;
  // The Bank Summary's received and spent count a transfer between the org's
  // own accounts twice over — out of one account and into another — although
  // no money came into or left the business. Taken off here, so "cash in" on
  // this tab is money that actually arrived, and it is measured on the same
  // terms as the movement figures it sits beside and is checked against.
  const bankIn   = byCur ? byCur.cashIn  - banked.transfers.in  : 0;
  const bankOut  = byCur ? byCur.cashOut - banked.transfers.out : 0;
  const forecast = _buildCashForecast({ invoices, openingBalance: closing, today, baseCurrency });
  const runway   = _buildRunway({ months, monthly: movement.monthly, closing, today });
  const waterfall = _buildCashWaterfall({ opening, closing, movement: banked });

  // The bank statement is what actually happened. Payments and bank transactions
  // explain WHERE it came from — but they are separate records, and they can
  // disagree with the bank if something was recorded against a non-bank account
  // or never reconciled. Deriving the opening balance by subtraction hid that;
  // reading Xero's own opening balance exposes it instead.
  //
  // Only when there is a bank figure to compare with. Without one, every
  // payment recorded used to read as missing from a bank that was simply not
  // fetched.
  const unreconciled = byCur
    ? _buildUnreconciled({ movement: banked, bankIn: byCur.cashIn, bankOut: byCur.cashOut })
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
      transfersIn: banked.transfers.in, transfersOut: banked.transfers.out,
      accounts: byCur ? byCur.accounts.map(a => ({ name: a.name, currency: a.currency, balance: a.closingBalance })) : [],
      // Listed in their own currency, and in none of the figures above.
      foreignAccounts: byCur ? byCur.foreignAccounts.map(a => ({ name: a.name, currency: a.currency, balance: a.closingBalance })) : [],
      baseOnly: !!byCur?.baseOnly,
      currency: baseCurrency,
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

// Names its defaults for the reason given at getBudgetVariance. Bound after
// the declaration, through the one in-flight map in ./report-cache, so the
// commentary's calls to it go through the same in-flight map as the
// /cash-flow route.
const getCashFlow            = _dedupe('getCashFlow', _getCashFlowRaw,
  { timezone: 'UTC', force: false });

module.exports = { getCashFlow, _buildInvoiceHygiene };
