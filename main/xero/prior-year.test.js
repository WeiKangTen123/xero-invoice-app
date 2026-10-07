// The Overview and Profitability compare this period with the same months a
// year earlier. Year on year used to need thirteen closed months inside the
// period, which no preset has, so it always read "needs a full prior year".
//
// Pinned here: which months are fetched for last year (a December and a March
// year end, a custom range, a period longer than a year), that only months
// closed this year are compared and percentages are never invented from a zero
// or negative base, that a failure or an empty year never fails the report,
// and what it costs in Xero calls — nothing without the flag, one call pair
// for the year-earlier months with it, nothing again on a repeat.
//
// Xero is mocked; nothing here leaves the process. Only Date is faked, so the
// closed months are known and nothing waits on a timer.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
    getReportBankSummary:   jest.fn(),
    getBudgets:             jest.fn(),
    getInvoices:            jest.fn(),
    getAccounts:            jest.fn(),
    getPayments:            jest.fn(),
    getBankTransactions:    jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

const { __api: api } = require('xero-node');
const logger  = require('../utils/logger');
const reports = require('./reports');
const { _buildPriorYear, _priorYearSpan, _yearEarlier, PRIOR_YEAR } = require('./performance');
const { _monthsBetween } = require('./periods');

const U = 'u-prior';
const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
const TODAY = '2026-10-07T03:00:00Z';   // Jan–Sep 2026 closed, October in progress

// ── A Profit & Loss built from a table of figures per month ────────────────
const cell = value => ({ value });
const row = (label, values, rowType = 'Row') => ({ rowType, cells: [label, ...values].map(cell) });
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const money = v => (v < 0 ? `(${Math.abs(v).toFixed(2)})` : v.toFixed(2));
const monthsBack = (key, n) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const ZERO = { rev: 0, cogs: 0, opex: 0 };
// This year sells 1,100 a month on 100 of cost of sales and 500 of overheads;
// last year 1,000 on 100 and 400. October 2026 is part-booked.
const BASE = {
  2024: { rev: 800,  cogs: 0,   opex: 300 },
  2025: { rev: 1000, cogs: 100, opex: 400 },
  2026: { rev: 1100, cogs: 100, opex: 500 },
  '2026-10': { rev: 300, cogs: 0, opex: 50 },
};
let table = BASE;
let emptyYears = new Set();
const figures = key => table[key] || table[key.slice(0, 4)] || ZERO;

// ProfitAndLoss answers newest first, anchored on `from`'s month and running
// `periods` months back from it, as Xero does.
function pnl(fromISO, periods) {
  const keys = Array.from({ length: (periods || 0) + 1 }, (_, i) => monthsBack(fromISO.slice(0, 7), i));
  if (keys.every(k => emptyYears.has(k.slice(0, 4)))) return { body: { reports: [{ rows: [] }] } };
  const f = keys.map(figures);
  const col = fn => f.map(x => money(fn(x)));
  return { body: { reports: [{ rows: [
    { rowType: 'Header', cells: [cell(''), ...keys.map(cell)] },
    section('Income', [row('Sales', col(x => x.rev)), row('Total Income', col(x => x.rev), 'SummaryRow')]),
    section('Less Cost of Sales', [row('Purchases', col(x => x.cogs)), row('Total Cost of Sales', col(x => x.cogs), 'SummaryRow')]),
    section('', [row('Gross Profit', col(x => x.rev - x.cogs))]),
    section('Less Operating Expenses', [row('Rent', col(x => x.opex)), row('Total Operating Expenses', col(x => x.opex), 'SummaryRow')]),
    section('', [row('Net Profit', col(x => x.rev - x.cogs - x.opex))]),
  ] }] } };
}

const org = month => ({ body: { organisations: [
  { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: month },
] } });

const pnlCalls    = () => api.getReportProfitAndLoss.mock.calls.map(c => c.slice(1, 5));
const budgetCalls = () => api.getReportBudgetSummary.mock.calls.map(c => c.slice(1));
const callCounts  = () => ({
  pnl: api.getReportProfitAndLoss.mock.calls.length,
  budget: api.getReportBudgetSummary.mock.calls.length,
  budgets: api.getBudgets.mock.calls.length,
});
const perfFor = (tenant, period, extra = {}) =>
  reports.getPerformance(U, tenant, { timezone: 'UTC', period, ...extra });
const compareFor = (tenant, period, extra = {}) => perfFor(tenant, period, { compare: PRIOR_YEAR, ...extra });

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(TODAY), doNotFake: REAL_TIMERS });
  jest.clearAllMocks();
  reports._cache.clear();
  table = BASE;
  emptyYears = new Set();
  const empty = { body: { reports: [{ rows: [] }] } };
  api.getOrganisations.mockResolvedValue(org(12));
  api.getReportProfitAndLoss.mockImplementation((tenant, from, to, periods) => Promise.resolve(pnl(from, periods)));
  api.getReportBudgetSummary.mockResolvedValue(empty);
  api.getReportBankSummary.mockResolvedValue(empty);
  api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
  api.getInvoices.mockResolvedValue({ body: { invoices: [] } });
  api.getAccounts.mockResolvedValue({ body: { accounts: [] } });
  api.getPayments.mockResolvedValue({ body: { payments: [] } });
  api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: [] } });
});
afterEach(() => jest.useRealTimers());

// ── Which months are fetched ────────────────────────────────────────────────
describe('the same months last year — which are fetched', () => {
  test('a month a year earlier, across a year boundary and in February', () => {
    expect(_yearEarlier('2026-01')).toEqual({ key: '2025-01', label: 'Jan 2025' });
    expect(_yearEarlier('2028-02')).toEqual({ key: '2027-02', label: 'Feb 2027' });
  });

  test('the span is the period a year earlier, less what a period over twelve months already holds', () => {
    expect(_priorYearSpan(_monthsBetween('2026-01', '2026-10'))).toEqual({ from: '2025-01', to: '2025-10' });
    expect(_priorYearSpan(_monthsBetween('2026-04', '2027-03'))).toEqual({ from: '2025-04', to: '2026-03' });
    expect(_priorYearSpan(_monthsBetween('2026-10', '2026-10'))).toEqual({ from: '2025-10', to: '2025-10' });
    expect(_priorYearSpan(_monthsBetween('2025-01', '2026-12'))).toEqual({ from: '2024-01', to: '2024-12' });
    expect(_priorYearSpan(_monthsBetween('2016-01', '2026-12'))).toEqual({ from: '2015-01', to: '2015-12' });
  });

  test('financial year to date, December year end: Jan–Oct 2025, asked for as the budget route would', async () => {
    const perf = await compareFor('t-dec', { preset: 'fy-ytd' });
    // This year's pair first, then last year's.
    expect(budgetCalls()).toEqual([['2026-01-31', 10, 1], ['2025-01-31', 10, 1]]);
    expect(pnlCalls()).toEqual([['2026-10-01', '2026-10-31', 9, 'MONTH'], ['2025-10-01', '2025-10-31', 9, 'MONTH']]);

    const py = perf.priorYear;
    expect(py.available).toBe(true);
    expect(py.months.map(m => m.key)).toEqual(_monthsBetween('2025-01', '2025-10').map(m => m.key));
    expect(py.months[0]).toEqual({ key: '2025-01', label: 'Jan 2025', compared: true });
    expect(py.months.map(m => m.compared)).toEqual([...Array(9).fill(true), false]);   // October has not closed
    expect(py.compared).toEqual({
      count: 9, keys: _monthsBetween('2026-01', '2026-09').map(m => m.key),
      fromLabel: 'Jan 2026', toLabel: 'Sep 2026', priorFromLabel: 'Jan 2025', priorToLabel: 'Sep 2025',
      firstActivityLabel: null,
    });
  });

  test('a March year end: this financial year is Apr 2026–Mar 2027, compared with Apr 2025–Mar 2026', async () => {
    api.getOrganisations.mockResolvedValue(org(3));
    const perf = await compareFor('t-mar', { preset: 'fy' });
    expect(perf.months[0].key).toBe('2026-04');
    expect(budgetCalls()[1]).toEqual(['2025-04-30', 12, 1]);
    expect(pnlCalls()[1]).toEqual(['2026-03-01', '2026-03-31', 11, 'MONTH']);
    const py = perf.priorYear;
    expect(py.months.map(m => m.key)).toEqual(_monthsBetween('2025-04', '2026-03').map(m => m.key));
    // Apr–Sep have closed this year; Oct–Mar have not, so last year's Oct–Mar are shown but not compared.
    expect(py.compared).toMatchObject({ count: 6, fromLabel: 'Apr 2026', toLabel: 'Sep 2026', priorFromLabel: 'Apr 2025', priorToLabel: 'Sep 2025' });
    expect(py.totals.revenue).toMatchObject({ total: 6000, thisYearTotal: 6600, change: 600 });
    expect(py.totals.revenue.pct).toBeCloseTo(0.1, 10);
    // Jan–Mar 2026 are last year's figures for Jan–Mar 2027, and are there for the chart.
    expect(py.totals.revenue.monthly.slice(9)).toEqual([1100, 1100, 1100]);
  });

  test('a March year end, year to date: Apr–Oct 2026 against Apr–Oct 2025', async () => {
    api.getOrganisations.mockResolvedValue(org(3));
    const perf = await compareFor('t-mar-ytd', { preset: 'fy-ytd' });
    expect(perf.priorYear.months.map(m => m.key)).toEqual(_monthsBetween('2025-04', '2025-10').map(m => m.key));
    expect(perf.priorYear.compared).toMatchObject({ count: 6, toLabel: 'Sep 2026', priorToLabel: 'Sep 2025' });
  });

  test('a custom range ending in February: the same four months a year earlier, every one compared', async () => {
    const perf = await compareFor('t-custom', { from: '2025-11', to: '2026-02' });
    expect(perf.priorYear.months.map(m => m.key)).toEqual(['2024-11', '2024-12', '2025-01', '2025-02']);
    // A span ending in a short month is two ProfitAndLoss calls (see _pnlCallPlan), last year's as well.
    expect(pnlCalls().slice(2)).toEqual([['2025-01-01', '2025-01-31', 2, 'MONTH'], ['2025-02-01', '2025-02-28', undefined, undefined]]);
    expect(budgetCalls()[1]).toEqual(['2024-11-30', 4, 1]);
    const r = perf.priorYear.totals.revenue;
    expect(r.monthly).toEqual([800, 800, 1000, 1000]);
    expect(r.thisYearMonthly).toEqual([1000, 1000, 1100, 1100]);
    expect(r).toMatchObject({ total: 3600, thisYearTotal: 4200, change: 600 });
    expect(r.pct).toBeCloseTo(600 / 3600, 10);
    expect(perf.priorYear.compared).toMatchObject({ count: 4, fromLabel: 'Nov 2025', toLabel: 'Feb 2026' });
  });

  test('a period longer than a year fetches only the twelve months before it; the rest are its own', async () => {
    const before = await perfFor('t-long', { from: '2025-01', to: '2026-12' });
    const base = callCounts();
    expect(base).toMatchObject({ pnl: 2, budget: 2 });
    reports._cache.clear();
    jest.clearAllMocks();

    const perf = await compareFor('t-long', { from: '2025-01', to: '2026-12' });
    expect(callCounts()).toEqual({ pnl: base.pnl + 1, budget: base.budget + 1, budgets: base.budgets + 1 });
    expect(budgetCalls().at(-1)).toEqual(['2024-01-31', 12, 1]);
    const r = perf.priorYear.totals.revenue;
    expect(perf.priorYear.months[12].key).toBe('2025-01');
    expect(r.monthly.slice(0, 12)).toEqual(Array(12).fill(800));                  // 2024, fetched
    expect(r.monthly.slice(12)).toEqual(before.totals.revenue.actual.slice(0, 12)); // 2025, already held
    expect(perf.priorYear.compared).toMatchObject({ count: 21, fromLabel: 'Jan 2025', toLabel: 'Sep 2026' });
  });

  test('a period running a year ahead has no figure yet for last year\'s open months, and never compares them', async () => {
    const perf = await compareFor('t-ahead', { from: '2026-01', to: '2027-12' });
    const r = perf.priorYear.totals.netProfit;
    // Jan–Sep 2026 are last year's for Jan–Sep 2027; October 2026 is still open.
    expect(r.monthly.slice(12, 21)).toEqual(Array(9).fill(500));
    expect(r.monthly.slice(21)).toEqual([null, null, null]);
    expect(perf.priorYear.compared.count).toBe(9);
  });

  test('with no month of the period closed there is nothing to compare, and nothing is fetched for it', async () => {
    await perfFor('t-open', { preset: 'this-month' });
    const base = callCounts();
    reports._cache.clear();
    jest.clearAllMocks();
    const perf = await compareFor('t-open', { preset: 'this-month' });
    expect(callCounts()).toEqual(base);
    expect(perf.priorYear).toMatchObject({ available: false, reason: 'no-closed-month', totals: null });
    expect(perf.priorYear.months).toEqual([{ key: '2025-10', label: 'Oct 2025', compared: false }]);
  });
});

// ── Like with like ──────────────────────────────────────────────────────────
describe('the same months last year — like with like', () => {
  test('closed months only: the part-booked October is in neither sum', async () => {
    const perf = await compareFor('t-sums', { preset: 'fy-ytd' });
    const t = perf.priorYear.totals;
    expect(t.revenue).toMatchObject({ total: 9000, thisYearTotal: 9900, change: 900 });
    expect(t.revenue.pct).toBeCloseTo(0.1, 10);
    expect(t.grossProfit).toMatchObject({ total: 8100, thisYearTotal: 9000, change: 900 });
    expect(t.grossProfit.pct).toBeCloseTo(900 / 8100, 10);
    expect(t.opex).toMatchObject({ total: 3600, thisYearTotal: 4500, change: 900, pct: 0.25 });
    expect(t.netProfit).toMatchObject({ total: 4500, thisYearTotal: 4500, change: 0, pct: 0 });
    // Shown month by month, October included, for the chart.
    expect(t.revenue.monthly[9]).toBe(1000);
    expect(t.revenue.thisYearMonthly[9]).toBe(300);
    // The figures this year are the report's own.
    expect(t.revenue.thisYearMonthly).toEqual(perf.totals.revenue.actual);
  });

  test('months last year before anything was recorded are left out, and the payload says where records begin', async () => {
    table = { ...BASE, '2025-01': ZERO, '2025-02': ZERO };
    const perf = await compareFor('t-started', { preset: 'fy-ytd' });
    const py = perf.priorYear;
    expect(py.compared).toMatchObject({ count: 7, fromLabel: 'Mar 2026', priorFromLabel: 'Mar 2025', firstActivityLabel: 'Mar 2025' });
    expect(py.months.slice(0, 3).map(m => m.compared)).toEqual([false, false, true]);
    expect(py.totals.revenue).toMatchObject({ total: 7000, thisYearTotal: 7700 });
    // No figure, rather than a zero nobody booked, for the chart's line.
    expect(py.totals.revenue.monthly.slice(0, 3)).toEqual([null, null, 1000]);
  });

  test('a percentage is null, never invented, when last year was zero or a loss; the amount is still given', async () => {
    table = { ...BASE, 2025: { rev: 0, cogs: 0, opex: 400 } };   // costs but no sales: a loss every month
    const perf = await compareFor('t-loss', { preset: 'fy-ytd' });
    const t = perf.priorYear.totals;
    expect(perf.priorYear.available).toBe(true);
    expect(t.revenue).toMatchObject({ total: 0, thisYearTotal: 9900, change: 9900, pct: null });
    expect(t.grossProfit).toMatchObject({ total: 0, pct: null });
    expect(t.netProfit).toMatchObject({ total: -3600, thisYearTotal: 4500, change: 8100, pct: null });
    expect(t.opex).toMatchObject({ total: 3600, pct: 0.25 });   // a positive base still has one
  });

  test('the pure builder: gross profit falls back to revenue less cost of sales where there is no gross line', () => {
    const months = _monthsBetween('2026-01', '2026-02');
    const series = (actual) => ({ actual, budget: actual.map(() => 0) });
    const totals = (rev, cogs) => ({
      revenue: series(rev), otherIncome: series([0, 0]), cogs: series(cogs),
      grossProfit: series([0, 0]), opex: series([0, 0]), netProfit: series(rev.map((r, i) => r - cogs[i])),
    });
    const py = _buildPriorYear({ months, current: totals([200, 300], [50, 50]), prior: totals([100, 100], [0, 40]), closed: 2, priorClosed: 2 });
    expect(py.totals.grossProfit).toMatchObject({ monthly: [100, 60], thisYearMonthly: [150, 250], total: 160, thisYearTotal: 400 });
    expect(py.totals.grossProfit.pct).toBeCloseTo(240 / 160, 10);
  });
});

// ── Never fails the report ──────────────────────────────────────────────────
describe('the same months last year — never fails the report', () => {
  test('no figures in Xero for last year: available:false, no-data, and the report is whole', async () => {
    emptyYears = new Set(['2025']);
    const perf = await compareFor('t-new-org', { preset: 'fy-ytd' });
    expect(perf.priorYear).toMatchObject({ available: false, reason: 'no-data', totals: null, compared: null });
    expect(perf.priorYear.months).toHaveLength(10);
    expect(perf.totals.revenue.actual.slice(0, 3)).toEqual([1100, 1100, 1100]);
  });

  test('last year\'s fetch failing: available:false, unavailable, logged, and every other figure as without the flag', async () => {
    const warn = jest.spyOn(logger, 'warn');
    api.getReportProfitAndLoss.mockImplementation((tenant, from, to, periods) => (from.startsWith('2025')
      ? Promise.reject(new Error('Xero is having a moment'))
      : Promise.resolve(pnl(from, periods))));
    const perf = await compareFor('t-fail', { preset: 'fy-ytd' });
    expect(perf.priorYear).toMatchObject({ available: false, reason: 'unavailable', totals: null });
    expect(warn.mock.calls.some(([msg]) => /last year's figures unavailable/.test(msg))).toBe(true);
    expect(perf.totals.netProfit.actual[0]).toBe(500);
    expect(perf.growth.available).toBe(true);
    warn.mockRestore();
  });

  test('a year earlier that falls before 1990: out-of-range, and no report is fetched for it', async () => {
    const perf = await compareFor('t-1990', { from: '1990-01', to: '1990-03' });
    expect(perf.priorYear).toMatchObject({ available: false, reason: 'out-of-range' });
    expect(perf.months.map(m => m.key)).toEqual(['1990-01', '1990-02', '1990-03']);
    expect(pnlCalls().some(([from]) => from.startsWith('1989'))).toBe(false);
    expect(budgetCalls().some(([anchor]) => anchor.startsWith('1989'))).toBe(false);
  });
});

// ── What it costs ───────────────────────────────────────────────────────────
describe('the same months last year — what it costs in Xero calls', () => {
  test('without the flag nothing extra is fetched, and the payload is exactly as it was', async () => {
    const without = await perfFor('t-cost', { preset: 'fy-ytd' });
    expect(callCounts()).toEqual({ pnl: 1, budget: 1, budgets: 1 });
    expect(without).not.toHaveProperty('priorYear');

    reports._cache.clear();
    jest.clearAllMocks();
    const withIt = await compareFor('t-cost', { preset: 'fy-ytd' });
    // One more call pair, for last year's months (and the budget list that
    // getBudgetVariance reads alongside every report it fetches).
    expect(callCounts()).toEqual({ pnl: 2, budget: 2, budgets: 2 });
    const strip = ({ priorYear, cached, fetchedAt, ...rest }) => rest;
    expect(strip(withIt)).toEqual(strip(without));
  });

  test('one call pair per twelve months of last year, and a repeat is served from the cache', async () => {
    await compareFor('t-repeat', { preset: 'fy' });
    expect(callCounts()).toEqual({ pnl: 2, budget: 2, budgets: 2 });

    const again = await compareFor('t-repeat', { preset: 'fy' });
    expect(callCounts()).toEqual({ pnl: 2, budget: 2, budgets: 2 });
    expect(again.priorYear).toMatchObject({ available: true, cached: true });

    // Last year has closed, so it is kept for hours rather than minutes.
    const key = [...reports._cache.keys()].find(k => k.startsWith(`budgetvar:${U}:t-repeat:custom:2025-01:2025-12:`));
    expect(reports._cache.get(key).ttl).toBe(reports.TTL_CLOSED_MS);
  });

  test('work in flight is shared: the figures with and without the comparison, and the budget route asking for last year', async () => {
    const P = { preset: 'fy-ytd' };
    await Promise.all([
      reports.getPerformance(U, 't-shared', { timezone: 'UTC', period: P, cashFlow: false, customers: false, force: false, compare: PRIOR_YEAR }),
      reports.getPerformance(U, 't-shared', { timezone: 'UTC', period: P, cashFlow: false, customers: false, force: false }),
      reports.getVarianceInsights(U, 't-shared', { timezone: 'UTC', period: P, force: false, reanalyse: false }),
    ]);
    await reports.getBudgetVariance(U, 't-shared', { timezone: 'UTC', force: false, period: { from: '2025-01', to: '2025-10' } });
    expect(callCounts()).toEqual({ pnl: 2, budget: 2, budgets: 2 });
  });
});
