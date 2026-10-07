// Read-only financial data for the "Insights" tab. Every function behind this
// module either takes already-fetched Xero data (pure, fully unit-tested,
// nothing to mock) or is the thin cached-fetch wrapper around it.
//
// This file used to hold all of it, 2,100 lines covering the cache, Xero
// paging, every report and both AI features. Each part now lives in its
// own module and this one only gathers their exports, so every route, script
// and test that imports from here is unchanged. Each module depends only on
// those listed above it, never below, so none of them can require another in a
// circle:
//
//   ./report-cache       the in-memory cache and in-flight sharing, one of each
//   ./report-fetch       the Xero client, paging, and the directory records
//   ./summary            receivables and payables, right now
//   ./bank               bank statement, Bank Summary, bank account currencies
//   ./budget-variance    Budget vs Actual, and the P&L rows the rest read
//   ./performance        the dashboard figures
//   ./ageing             receivables and payables by age and by contact
//   ./cash-flow-report   the Cash Flow tab, fetched (./cash-flow does the sums)
//   ./ai-commentary      variance reasons and the financial narrative
//
// New report code belongs in one of those, or a module of its own; this file
// only re-exports.

const {
  FORCE_GRACE_MS, DIRECTORY_TTL_MS, CACHE_MAX_ENTRIES, TTL_OPEN_MS, TTL_RECENT_MS, TTL_CLOSED_MS,
  _cache, _pruneCache, _periodCacheTtl, _canonical, _dedupeKey, clearCache,
} = require('./report-cache');
const {
  getAccounts, getBankAccounts, getContacts,
  _buildAccounts, _buildBankAccounts, _buildContacts, _allPages, LIST_PAGE_SIZE, LIST_MAX_PAGES,
} = require('./report-fetch');
const { getSummary, _buildSummary } = require('./summary');
const {
  getBankTransactions, getBankSummary,
  _buildBankTransactions, _buildPayments, _buildBankSummary, _splitIntoReportWindows, _clampReportFrom,
} = require('./bank');
const {
  getBudgetVariance,
  _reportLines, _pnlCallPlan, _buildBudgetVariance, _mergeChunks, _cents, _netRow,
  _mapWithConcurrency, _variancePct, _sectionKind,
} = require('./budget-variance');
const {
  getPerformance,
  _buildCustomerRevenue, _buildQuotePipeline, _growthPct, _buildGrowth, _sectionTotal,
  _isRecurringName, _buildPerformance, _buildWatchList, _recurringFor, _xeroDay,
} = require('./performance');
const { getAgeing, _buildAgeing, _creditsOf } = require('./ageing');
const { getCashFlow, _buildInvoiceHygiene } = require('./cash-flow-report');
const {
  getVarianceInsights, getFinancialNarrative, _narrateFrom, INSIGHT_CACHE_TTL_MS,
} = require('./ai-commentary');

// ── Currency ────────────────────────────────────────────────────────────────
// Base-currency conversion lives in ./currency. See the notes there: Xero
// reports return base currency and documents return their own, and summing
// the two without converting is silent and wrong.
const { _toBase, _foreignCurrency } = require('./currency');

// ── Date-range engine (daily/weekly/monthly/yearly/custom) ──────────────────
// Everything here works in calendar dates (Y/M/D), never real instants — Xero's
// filter syntax (`DateTime(y,m,d)`) takes a plain calendar date with no
// timezone component, so day-boundary math never needs to resolve a UTC
// offset. "Today" itself is the one place a timezone actually matters (what
// counts as today depends on where the user is), resolved once via
// Intl.DateTimeFormat against the user's stored timezone preference.
//
// Date, month and period arithmetic — see ./periods. Re-exported below so
// callers and tests continue to reach them through this module.
const {
  _actualThroughIndex,
  _chunkMonths,
  _closedCount,
  _fiscalYearMonths,
  _monthMeta,
  _monthsBetween,
  _monthsFrom,
  _resolvePeriod,
  _resolveWindow,
  _toDateLabel,
} = require('./periods');

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
  _buildUnreconciled,
  _buildPaymentDays,
  _raisedByMonth,
  _bankByCurrency,
} = require('./cash-flow');

// Numbers big enough to be a money amount rather than a percentage or a count.
// Prompts, grounding and the facts the model is allowed to see — see
// ./ai-insights. Re-exported below so tests reach them through this module.
const {
  _buildCategoryVariances,
  _groundNarrative,
  _insightIsGrounded,
  _largeNumbersIn,
  _narrativeFacts,
  _narrativePrompt,
  _parseInsights,
  _varianceCandidates,
  INSIGHT_FAILURE_TTL_MS,
} = require('./ai-insights');

module.exports = {
  FORCE_GRACE_MS, DIRECTORY_TTL_MS,
  getSummary, getAccounts, getBankAccounts, getContacts,
  getBankTransactions, getBankSummary, getBudgetVariance, getPerformance, getCashFlow, getVarianceInsights, getFinancialNarrative, clearCache,
  getAgeing, _buildAgeing, _creditsOf,
  _buildSummary, _buildAccounts, _buildBankAccounts, _buildContacts,
  _buildBankTransactions, _buildPayments, _buildBankSummary,
  _splitIntoReportWindows, _clampReportFrom,
  _fiscalYearMonths, _monthsFrom, _monthMeta, _monthsBetween, _chunkMonths,
  _resolveWindow, _resolvePeriod, _actualThroughIndex, _reportLines, _pnlCallPlan, _buildBudgetVariance,
  _mergeChunks, _cents, _netRow, _toDateLabel, _buildCustomerRevenue, _buildInvoiceHygiene, _buildQuotePipeline, _buildCashMovement, _buildWorkingCapital, _buildCashForecast,
  _toBase, _foreignCurrency, _closedCount, _growthPct, _buildGrowth, _buildRunway, _buildCashWaterfall,
  _buildAlerts, ALERT_THRESHOLDS,
  _isTransfer, _isReceiptPayment, _isLive, _buildUnreconciled, _buildPaymentDays, _raisedByMonth, _sectionTotal, _periodCacheTtl, _pruneCache, _cache, CACHE_MAX_ENTRIES, TTL_OPEN_MS, TTL_RECENT_MS, TTL_CLOSED_MS, _mapWithConcurrency, _variancePct, _sectionKind, _isRecurringName, _buildPerformance, _buildWatchList,
  _allPages, LIST_PAGE_SIZE, LIST_MAX_PAGES, _recurringFor, _xeroDay, _bankByCurrency,
  INSIGHT_CACHE_TTL_MS, INSIGHT_FAILURE_TTL_MS,
  _largeNumbersIn, _insightIsGrounded, _varianceCandidates, _parseInsights, _buildCategoryVariances,
  _narrativeFacts, _groundNarrative, _narrativePrompt, _narrateFrom,
  _canonical, _dedupeKey,
};
