// The fetch path of Budget vs Actual: what is done with Xero's answers, and the
// cache around them. reports-contract.test.js pins the ARGUMENTS of each call;
// these pin the way the answers are put back together and when a new one is
// asked for — the places a column can slide, a closed month can go on being
// served as budget, or a 429 can turn into a hang or a duplicated call.
//
// Everything is mocked. No test in this file reaches Xero, and the first thing
// it checks is that the SDK in use is the mock.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getBudgets:             jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));
// reports.js gathers every report module, the AI commentary included; the
// model client is stubbed so nothing here can reach for a key.
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

const { AccountingApi, __api: api } = require('xero-node');
const reports = require('./reports');
const { xeroErrMsg } = require('./xero-utils');

const U   = 'u1';
const ORG = { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 3 };

// Xero's report cell shape, and a report with one income line and the bottom
// line, each carrying the given column values. Both endpoints answer this
// shape under the standard layout, so the two reports match line for line and
// nothing here depends on how a retitled line is reconciled.
const cell    = value => ({ value });
const row     = (label, values, rowType = 'Row') => ({ rowType, cells: [cell(label), ...values.map(cell)] });
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const money   = v => (typeof v === 'number' ? v.toFixed(2) : v);
const report  = (sales, net = sales) => ({ body: { reports: [{ rows: [
  { rowType: 'Header', cells: [cell('')] },
  section('Income', [row('Sales', sales.map(money))]),
  section('', [row('Net Profit', net.map(money), 'SummaryRow')]),
] }] } });
const TWELVE = Array(12).fill(1);

// The clock is fixed so the closed months are known. Only Date is faked, so
// nothing waits on a timer; the rate-limit tests below fake setTimeout as
// well, because that is what a retry waits on.
const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
const NOW = '2026-10-07T03:00:00Z';
const at  = iso => jest.setSystemTime(new Date(iso));

const get  = (period, tenant) => reports.getBudgetVariance(U, tenant, { timezone: 'UTC', period });
const find = (out, label) => out.rows.find(r => r.label === label);

beforeAll(() => {
  // The guard every call below relies on: the SDK in use is the mock above, so
  // a call can only ever land on these jest.fn()s.
  expect(jest.isMockFunction(AccountingApi)).toBe(true);
  expect(new AccountingApi()).toBe(api);
});

beforeEach(() => {
  // Reset rather than clear: a mockRejectedValueOnce queued by one test must
  // not fire in the next. Only the methods: _apiFor writes accessToken onto
  // this same object, and a token is not a mock.
  for (const fn of Object.values(api)) if (jest.isMockFunction(fn)) fn.mockReset();
  reports._cache.clear();
  jest.useFakeTimers({ now: new Date(NOW), doNotFake: REAL_TIMERS });
  api.getOrganisations.mockResolvedValue({ body: { organisations: [ORG] } });
  api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
  // Twelve columns whatever was asked for: a call that asked for fewer reads
  // only the ones it asked for, so the surplus is harmless.
  api.getReportProfitAndLoss.mockResolvedValue(report(TWELVE));
  api.getReportBudgetSummary.mockResolvedValue(report(TWELVE));
});
afterEach(() => jest.useRealTimers());

// Xero applies the ProfitAndLoss anchor's day count to every comparison period,
// so a span ending in a 30-day month is fetched in two calls: the months before
// it anchored on the 31-day month, and the last month alone. The merge has to
// put the newest-first head back into month order and the lone tail at the
// end, and the only way to see that it did is to give every month a figure of
// its own.
describe('the two-call plan for a period ending in a short month', () => {
  test('Oct 2025 – Sep 2026: head anchored on August with periods=10, September alone, one Budget call — and every month in its own column', async () => {
    // Month i (Oct 2025 = 0 … Sep 2026 = 11) has an actual of 1000+i and a
    // budget of 2000+i, so a column that slid would be seen at once.
    const idx    = Array.from({ length: 12 }, (_, i) => i);
    const actual = i => 1000 + i;
    const budget = i => 2000 + i;
    api.getReportProfitAndLoss.mockImplementation(async (_tenant, from) => {
      // Xero answers a comparison call NEWEST-first: Aug 2026 … Oct 2025.
      if (from === '2026-08-01') return report(idx.slice(0, 11).reverse().map(actual), idx.slice(0, 11).reverse().map(i => actual(i) * 10));
      if (from === '2026-09-01') return report([actual(11)], [actual(11) * 10]);
      throw new Error(`unplanned ProfitAndLoss call from ${from}`);
    });
    // BudgetSummary answers OLDEST-first, anchored on the first month.
    api.getReportBudgetSummary.mockResolvedValue(report(idx.map(budget), idx.map(i => budget(i) * 10)));

    const out = await get({ from: '2025-10', to: '2026-09' }, 't-plan');

    expect(api.getReportProfitAndLoss.mock.calls.map(c => c.slice(1, 5))).toEqual([
      ['2026-08-01', '2026-08-31', 10, 'MONTH'],
      ['2026-09-01', '2026-09-30', undefined, undefined],
    ]);
    expect(api.getReportBudgetSummary.mock.calls.map(c => c.slice(1))).toEqual([['2025-10-31', 12, 1]]);

    expect(out.months.map(m => m.key)).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
    const sales = find(out, 'Sales'), net = find(out, 'Net Profit');
    expect(sales.monthly.map(m => m.actual)).toEqual(idx.map(actual));
    expect(sales.monthly.map(m => m.budget)).toEqual(idx.map(budget));
    expect(net.monthly.map(m => m.actual)).toEqual(idx.map(i => actual(i) * 10));
    // By 7 Oct 2026 every month of the period has closed, so the grid is
    // actuals throughout and the total is their sum.
    expect(out.months.every(m => m.source === 'actual')).toBe(true);
    expect(sales.cells).toEqual(idx.map(actual));
    expect(sales.total).toBe(idx.map(actual).reduce((s, v) => s + v, 0));
  });
});

// A cached entry lives five minutes, and a month can close inside that: the
// entry written at 23:58 on the 30th says September is still in progress, and
// at 00:01 on the 1st it is not. The month that has closed is part of the key,
// so the request after midnight is a different entry, not a stale hit.
describe('the cache and a month closing', () => {
  test('the same period asked for either side of a month end is two entries, and the month flips to actual', async () => {
    const period = { from: '2026-01', to: '2026-12' };
    at('2026-09-30T23:58:00Z');
    const before = await get(period, 't-close');
    expect(before.months[8]).toMatchObject({ key: '2026-09', source: 'budget', current: true });
    expect(before.kpis.monthsElapsed).toBe(8);

    // Three minutes later, well inside the life of the entry just written:
    // only the key can send this back to Xero.
    at('2026-10-01T00:01:00Z');
    const after = await get(period, 't-close');
    expect(after.cached).toBe(false);
    expect(after.months[8]).toMatchObject({ key: '2026-09', source: 'actual', current: false });
    expect(after.months[9]).toMatchObject({ key: '2026-10', source: 'budget', current: true });
    expect(after.kpis.monthsElapsed).toBe(9);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(2);
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(2);

    // Both entries sit in the cache under their own keys, so the first was not
    // replaced, dropped or expired: it was simply not the one asked for.
    const keys = [...reports._cache.keys()].filter(k => k.startsWith('budgetvar:') && k.includes(':t-close:'));
    expect(keys).toHaveLength(2);

    // Asked again on the same day, it is the second entry that answers.
    const again = await get(period, 't-close');
    expect(again.cached).toBe(true);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(2);
  });
});

// BudgetSummary only ever reports the Overall budget. The list of budgets says
// so outright on the payload, and it is the one call here behind a scope
// (accounting.budgets.read) a connection made before it existed does not have.
describe('the budget list', () => {
  test('is fetched once per report and mapped to {id, type, description}', async () => {
    api.getBudgets.mockResolvedValue({ body: { budgets: [
      { budgetID: 'b-1', type: 'OVERALL',  description: 'Overall Budget', updatedDateUTC: '2026-09-01T00:00:00' },
      { budgetID: 'b-2', type: 'TRACKING', description: 'Sales team',     updatedDateUTC: '2026-09-01T00:00:00' },
    ] } });
    const out = await get({ preset: 'fy' }, 't-budgets');
    expect(out.budgets).toEqual([
      { id: 'b-1', type: 'OVERALL',  description: 'Overall Budget' },
      { id: 'b-2', type: 'TRACKING', description: 'Sales team' },
    ]);
    expect(api.getBudgets).toHaveBeenCalledTimes(1);
    expect(api.getBudgets).toHaveBeenCalledWith('t-budgets');

    // A repeat is the cached report, list included: no second call.
    await get({ preset: 'fy' }, 't-budgets');
    expect(api.getBudgets).toHaveBeenCalledTimes(1);
  });

  test('a refused list leaves budgets empty and the report whole', async () => {
    // The shape Xero answers a missing scope with: a 401 naming insufficient_scope.
    api.getBudgets.mockRejectedValue(new Error(JSON.stringify({
      response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' } }, body: {},
    })));
    const out = await get({ preset: 'fy' }, 't-nobudgets');
    expect(out.budgets).toEqual([]);
    expect(out.months).toHaveLength(12);
    expect(find(out, 'Sales').cells).toHaveLength(12);
    expect(out.budgetMissing).toBe(false);
    expect(api.getBudgets).toHaveBeenCalledTimes(1);
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(1);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
  });
});

// withRetry is the real one. setTimeout and Date are faked here as well, since
// a retry waits on the one and reads the other; the SDK rejects the way
// xero-node does, with the response serialised and the organisation's id in
// the request headers.
describe('a 429 on a report call', () => {
  const sdk429 = (headers, tenantId) => JSON.stringify({
    response: { statusCode: 429, body: {}, headers, request: { headers: { 'xero-tenant-id': tenantId } } },
    body: {},
  });
  const ONE_MONTH = { from: '2026-08', to: '2026-08' };   // one ProfitAndLoss call, so a retry is the second
  beforeEach(() => jest.useFakeTimers({ now: new Date(NOW), doNotFake: REAL_TIMERS.filter(t => !/^(set|clear)Timeout$/.test(t)) }));

  test('on the minute limit is retried once, after Retry-After, and the report comes back', async () => {
    api.getReportProfitAndLoss
      .mockRejectedValueOnce(sdk429({ 'x-rate-limit-problem': 'minute', 'retry-after': '3' }, 't-429'))
      .mockResolvedValueOnce(report([5]));
    const p = get(ONE_MONTH, 't-429');
    await jest.advanceTimersByTimeAsync(2_999);
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const out = await p;
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(2);
    // Both attempts asked for the same thing, and the answer to the second is
    // what was built and cached.
    expect(api.getReportProfitAndLoss.mock.calls[1]).toEqual(api.getReportProfitAndLoss.mock.calls[0]);
    expect(find(out, 'Sales').cells).toEqual([5]);
    expect(out.cached).toBe(false);
    expect((await get(ONE_MONTH, 't-429')).cached).toBe(true);
  });

  test('on the daily limit is not retried: it fails at once with the XERO_DAILY_LIMIT message and caches nothing', async () => {
    api.getReportProfitAndLoss.mockRejectedValue(sdk429({ 'x-rate-limit-problem': 'day', 'retry-after': '7200', 'x-daylimit-remaining': '0' }, 't-day'));
    // With setTimeout faked a wait would never end, so settling at all is the
    // proof that there was none.
    const err = await get(ONE_MONTH, 't-day').catch(e => e);
    expect(err).toMatchObject({ code: 'XERO_DAILY_LIMIT', statusCode: 429, tenantId: 't-day' });
    expect(err.message).toBe("Xero's daily limit for this organisation is used up; it resets at 2026-10-07 05:00 UTC (in about 2 hours). Try again after that.");
    expect(xeroErrMsg(err)).toBe(err.message);
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(1);
    expect([...reports._cache.keys()].some(k => k.includes(':t-day:'))).toBe(false);
  });
});

// Xero allows five concurrent calls per organisation and the minute budget is
// shared with invoice posting, so a long period is fetched two chunks at a
// time, each chunk's P&L pieces one after the other beside its one Budget
// call: four in flight at most.
describe('a long period', () => {
  test('24 months is six report calls with never more than four in flight', async () => {
    // Every mock holds its answer for a tick, so calls made side by side are
    // seen side by side; the peak is what the limit is about.
    let inFlight = 0, peak = 0;
    const held = answer => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return answer;
    };
    api.getOrganisations.mockImplementation(held({ body: { organisations: [ORG] } }));
    api.getBudgets.mockImplementation(held({ body: { budgets: [] } }));
    api.getReportProfitAndLoss.mockImplementation(held(report(TWELVE)));
    api.getReportBudgetSummary.mockImplementation(held(report(TWELVE)));

    const out = await get({ from: '2024-10', to: '2026-09' }, 't-24');

    // Two chunks of twelve, each ending in September: two P&L calls and one
    // Budget call apiece.
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(4);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(2);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThanOrEqual(2);   // the counter did see calls overlap, so the ceiling was tested
    expect(out.months).toHaveLength(24);
    expect(out.period.chunks).toBe(2);
  });
});

// Xero writes report cells as text: brackets for a negative, a comma every
// three digits, and an empty string for nothing. Pinned at the unit in
// report-fetch; this is the same reading arriving on the payload.
describe('Xero number formats, through the whole path', () => {
  test('brackets are negative, thousands are separated, and a blank cell is nil', async () => {
    api.getReportProfitAndLoss.mockResolvedValue({ body: { reports: [{ rows: [
      { rowType: 'Header', cells: [cell('')] },
      section('Income', [row('Sales', ['(17,670.00)']), row('Fees', [''])]),
      section('', [row('Net Profit', ['(17,670.00)'], 'SummaryRow')]),
    ] }] } });
    api.getReportBudgetSummary.mockResolvedValue({ body: { reports: [{ rows: [
      { rowType: 'Header', cells: [cell('Account')] },
      section('Income', [row('Sales', ['1,030.00']), row('Fees', [''])]),
      section('', [row('Net Profit', ['1,030.00'], 'SummaryRow')]),
    ] }] } });

    const out = await get({ from: '2026-08', to: '2026-08' }, 't-parse');

    const sales = find(out, 'Sales');
    expect(sales.monthly[0]).toMatchObject({ actual: -17670, budget: 1030, variance: -18700 });
    expect(sales.monthly[0].variancePct).toBeCloseTo(-18700 / 1030, 10);
    expect(sales.cells).toEqual([-17670]);            // August has closed by 7 Oct
    expect(sales.total).toBe(-17670);
    expect(find(out, 'Fees').monthly[0]).toEqual({ actual: 0, budget: 0, variance: 0, variancePct: null });
    expect(out.kpis).toMatchObject({ monthsElapsed: 1, ytdActualNet: -17670, forecastNet: -17670 });
  });
});
