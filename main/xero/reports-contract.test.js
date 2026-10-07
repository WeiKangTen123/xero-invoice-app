// Contract tests: do we CALL Xero with arguments Xero will accept?
//
// The rest of the suite mocks Xero and tests our logic thoroughly, which means
// it never looks at the arguments we send — a mock accepts anything. Two real
// bugs shipped with 398 tests green because of exactly that blind spot:
//
//   * getInvoices ordered by DueDate alongside summaryOnly → Xero 400
//     "Ordering by DueDate is unavailable on this endpoint when using the
//      summaryOnly flag"
//   * a single-month chunk would have passed periods=0, which the report
//     endpoints reject (documented range starts at 1)
//
// So these assert the CALL, not the result. Everything is still mocked — no test
// in this repo ever reaches Xero.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
    getReportBankSummary:   jest.fn(),
    getInvoices:            jest.fn(),
    getPayments:            jest.fn(),
    getBankTransactions:    jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));

const { __api: api } = require('xero-node');
const reports = require('./reports');

const U = 'u1', T = 't1';
const emptyReport = { body: { reports: [{ rows: [] }] } };

// Xero's documented limits. ProfitAndLoss compares up to 11 periods (12 columns);
// BudgetSummary up to 12. Zero is not a valid comparison count for either.
const PNL_MAX_PERIODS    = 11;
const BUDGET_MAX_PERIODS = 12;

beforeEach(() => {
  jest.clearAllMocks();
  reports._cache.clear();   // each test starts cold; `force` alone no longer busts a fresh entry
  api.getOrganisations.mockResolvedValue({ body: { organisations: [
    { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 3 },
  ] } });
  api.getReportProfitAndLoss.mockResolvedValue(emptyReport);
  api.getReportBudgetSummary.mockResolvedValue(emptyReport);
  api.getReportBankSummary.mockResolvedValue(emptyReport);
  api.getInvoices.mockResolvedValue({ body: { invoices: [] } });
  api.getPayments.mockResolvedValue({ body: { payments: [] } });
  api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: [] } });
});

describe('Xero call contract — report period arguments', () => {
  test('a 12-month period asks for the documented maximum, never more', async () => {
    await reports.getBudgetVariance(U, T, { period: { preset: 'fy' }, force: true });

    const [, , , pnlPeriods, pnlTimeframe] = api.getReportProfitAndLoss.mock.calls[0];
    expect(pnlPeriods).toBe(PNL_MAX_PERIODS);      // 11 → 12 columns
    expect(pnlTimeframe).toBe('MONTH');

    const [, , budPeriods, budTimeframe] = api.getReportBudgetSummary.mock.calls[0];
    expect(budPeriods).toBe(BUDGET_MAX_PERIODS);   // 12
    expect(budTimeframe).toBe(1);                  // 1 = month
  });

  test('a SINGLE month omits `periods` rather than sending 0', async () => {
    // periods=0 is outside the documented range and the endpoint rejects it.
    await reports.getBudgetVariance(U, T, { period: { preset: 'this-month' }, force: true });

    const pnlCall = api.getReportProfitAndLoss.mock.calls[0];
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(1);
    expect(pnlCall[3]).toBeUndefined();               // no periods...
    expect(pnlCall[4]).toBeUndefined();               // ...and so no timeframe
    expect(pnlCall[9]).toBe(true);                    // standardLayout, as on every P&L call

    const [, , budPeriods] = api.getReportBudgetSummary.mock.calls[0];
    expect(budPeriods).toBe(1);                      // Budget accepts 1; never 0
  });

  test('every chunk stays inside BOTH endpoints limits, however long the period', async () => {
    // 32 months → three chunks. No single call may exceed what Xero allows.
    await reports.getBudgetVariance(U, T, { period: { from: '2024-01', to: '2026-08' }, force: true });

    for (const call of api.getReportProfitAndLoss.mock.calls) {
      const periods = call[3];
      if (periods !== undefined) {
        expect(periods).toBeGreaterThanOrEqual(1);
        expect(periods).toBeLessThanOrEqual(PNL_MAX_PERIODS);
      }
    }
    for (const call of api.getReportBudgetSummary.mock.calls) {
      const periods = call[2];
      expect(periods).toBeGreaterThanOrEqual(1);
      expect(periods).toBeLessThanOrEqual(BUDGET_MAX_PERIODS);
    }
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(3);
  });

  test('report dates are plain YYYY-MM-DD, which is the only format these endpoints take', async () => {
    await reports.getBudgetVariance(U, T, { period: { preset: 'fy' }, force: true });
    const [, from, to] = api.getReportProfitAndLoss.mock.calls[0];
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [, budDate] = api.getReportBudgetSummary.mock.calls[0];
    expect(budDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Xero call contract — getInvoices', () => {
  test('summaryOnly is NEVER combined with a DueDate order', async () => {
    // The exact 400 that shipped: "Ordering by DueDate is unavailable on this
    // endpoint when using the summaryOnly flag".
    await reports.getCashFlow(U, T, { period: { preset: 'fy-ytd' }, force: true });

    for (const call of api.getInvoices.mock.calls) {
      const order = call[3], summaryOnly = call[12];
      if (summaryOnly === true && order) {
        expect(String(order)).not.toMatch(/DueDate/i);
      }
    }
    expect(api.getInvoices).toHaveBeenCalled();
  });

  test('the cash-flow invoice fetch is bounded by date, not unfiltered', async () => {
    // Xero bills on data egress since March 2026, so an unfiltered getInvoices
    // is a standing cost that grows with the customer's invoice count. It must
    // still reach back BEFORE the period (open invoices are older than it), so
    // this asserts a lower bound exists and that it precedes the period start.
    //
    // Debtor and creditor days are read through the summary, whose own invoice
    // fetch is unbounded by design (it reports everything still owed) and which
    // the page loads before any tab. Loaded first here as the page does, so
    // what is checked is the cash-flow fetch itself; the test below pins what
    // happens when the summary is not yet cached.
    await reports.getSummary(U, T);
    api.getInvoices.mockClear();
    await reports.getCashFlow(U, T, { period: { from: '2026-04', to: '2027-03' }, force: true });

    const summaryCalls = api.getInvoices.mock.calls.filter(c => c[12] === true);
    expect(summaryCalls.length).toBeGreaterThan(0);
    for (const call of summaryCalls) {
      const where = call[2];
      expect(typeof where).toBe('string');
      expect(where).toMatch(/Date\s*>=\s*DateTime\(/);
      // Must predate the period, or invoices raised earlier and still unpaid
      // vanish from the forecast.
      const [, y] = where.match(/DateTime\((\d{4})/) || [];
      expect(Number(y)).toBeLessThan(2026);
    }
  });

  test('with no summary cached, cash flow adds exactly one unbounded fetch — the summary\'s own — and shares it', async () => {
    // Performance (and through it cash flow) reads debtor and creditor days
    // from the summary. Cold, that costs the summary's one fetch; the summary
    // route asked for at the same moment shares it rather than fetching again.
    const T2 = 't-cold-summary';
    await Promise.all([
      reports.getCashFlow(U, T2, { period: { from: '2026-04', to: '2027-03' } }),
      reports.getSummary(U, T2, { force: false }),
    ]);
    const unbounded = api.getInvoices.mock.calls.filter(c => !c[2]);
    expect(unbounded).toHaveLength(1);
    const bounded = api.getInvoices.mock.calls.filter(c => c[2]);
    expect(bounded.length).toBeGreaterThan(0);
    for (const call of bounded) expect(call[2]).toMatch(/Date\s*>=\s*DateTime\(/);
  });

  test('a Xero where-clause never interpolates an undefined into the query', async () => {
    // `Date >= DateTime(undefined,...)` is a 400 that only shows up live.
    await reports.getCashFlow(U, T, { period: { preset: 'fy-ytd' }, force: true });
    for (const call of [...api.getInvoices.mock.calls, ...api.getPayments.mock.calls, ...api.getBankTransactions.mock.calls]) {
      if (typeof call[2] === 'string') expect(call[2]).not.toMatch(/undefined|NaN|null/);
    }
  });

  test('invoice status filters are real Xero enum values', async () => {
    await reports.getCashFlow(U, T, { period: { preset: 'fy-ytd' }, force: true });
    const VALID = ['DRAFT', 'SUBMITTED', 'DELETED', 'AUTHORISED', 'PAID', 'VOIDED'];
    for (const call of api.getInvoices.mock.calls) {
      for (const status of call[7] || []) expect(VALID).toContain(status);
    }
  });

  test('date filters use Xero\'s DateTime(y,m,d) syntax, not an ISO string', async () => {
    await reports.getPerformance(U, T, { period: { preset: 'fy-ytd' }, customers: true, force: true });
    const withWhere = api.getInvoices.mock.calls.filter(c => c[2]);
    expect(withWhere.length).toBeGreaterThan(0);
    for (const call of withWhere) {
      expect(call[2]).toMatch(/DateTime\(\d{4},\d{1,2},\d{1,2}\)/);
      expect(call[2]).not.toMatch(/\d{4}-\d{2}-\d{2}/);   // ISO here is silently ignored by Xero
    }
  });
});

describe('Xero call contract — nothing in the read path writes', () => {
  test('only get* methods are ever invoked', async () => {
    await reports.getPerformance(U, T, { period: { preset: 'fy-ytd' }, cashFlow: true, customers: true, force: true });
    await reports.getCashFlow(U, T, { period: { preset: 'fy-ytd' }, force: true });

    const called = Object.keys(api).filter(k => api[k].mock?.calls.length > 0);
    expect(called.length).toBeGreaterThan(0);
    for (const name of called) expect(name).toMatch(/^get/);
  });
});

// Cost: identical work must be fetched once. The Insights page fires
// /performance, /variance-insights and /narrative together on first load, and
// each miss used to become its own chain of Xero GETs; a Refresh forwarded
// `force` into every dependent report, refetching Budget-vs-Actual five times.
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

describe('Xero call budget — identical work is fetched once', () => {
  test('three concurrent summary requests make one invoice fetch', async () => {
    const T2 = 't-dedupe-1';
    await Promise.all([reports.getSummary(U, T2), reports.getSummary(U, T2), reports.getSummary(U, T2)]);
    expect(api.getInvoices).toHaveBeenCalledTimes(1);
  });

  test('three concurrent budget-variance requests fetch the budget report once', async () => {
    const T2 = 't-dedupe-2';
    const opts = { period: { preset: 'fy' } };
    await Promise.all([reports.getBudgetVariance(U, T2, opts), reports.getBudgetVariance(U, T2, opts), reports.getBudgetVariance(U, T2, opts)]);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
  });

  test('a forced request seconds after a fresh fetch reuses it; one older than the grace refetches', async () => {
    const T2 = 't-grace';
    await reports.getSummary(U, T2, { force: true });
    await reports.getSummary(U, T2, { force: true });          // within the grace window
    expect(api.getInvoices).toHaveBeenCalledTimes(1);
    reports._cache.get(`summary:${U}:${T2}`).fetchedAt -= reports.FORCE_GRACE_MS + 1;
    await reports.getSummary(U, T2, { force: true });
    expect(api.getInvoices).toHaveBeenCalledTimes(2);
  });

  test('a forced insights request fetches Budget-vs-Actual once, not once per dependent report', async () => {
    const T2 = 't-cascade';
    await reports.getVarianceInsights(U, T2, { period: { preset: 'fy' }, force: true });
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
  });
});

describe('Xero call contract — invoice paging', () => {
  test('invoice fetches page until a short page, so KPIs are not silently capped at 100', async () => {
    // Xero returns at most 100 per page; `page=1` was never followed up, so
    // every invoice-based KPI was computed on the newest hundred.
    const inv = i => ({ type: 'ACCREC', status: 'AUTHORISED', amountDue: 1, total: 1, invoiceNumber: `I-${i}`, dueDate: '2099-01-01' });
    api.getInvoices
      .mockResolvedValueOnce({ body: { invoices: Array.from({ length: 100 }, (_, i) => inv(i)) } })
      .mockResolvedValueOnce({ body: { invoices: Array.from({ length: 30 }, (_, i) => inv(100 + i)) } });
    const s = await reports.getSummary(U, 't-paged');
    expect(api.getInvoices).toHaveBeenCalledTimes(2);
    expect(api.getInvoices.mock.calls[0][8]).toBe(1);
    expect(api.getInvoices.mock.calls[1][8]).toBe(2);
    expect(s.kpis.receivablesCount).toBe(130);
  });
});

// Cost: directory data changes rarely but was refetched every five minutes,
// and a bank statement pulled the account's whole history each time.
describe('Xero call budget — directory data and statements', () => {
  test('chart of accounts, bank accounts, contacts and organisation live in cache for hours, not minutes', async () => {
    api.getAccounts = jest.fn().mockResolvedValue({ body: { accounts: [] } });
    api.getContacts = jest.fn().mockResolvedValue({ body: { contacts: [] } });
    const T2 = 't-ttl';
    await reports.getAccounts(U, T2);
    await reports.getBankAccounts(U, T2);
    await reports.getContacts(U, T2);
    await reports.getBudgetVariance(U, T2, { period: { preset: 'fy' } });   // fetches the organisation
    for (const k of [`accounts:${U}:${T2}`, `bank:${U}:${T2}`, `contacts:${U}:${T2}`, `org:${U}:${T2}`]) {
      expect(reports._cache.get(k).ttl).toBe(reports.DIRECTORY_TTL_MS);
    }
    expect(reports.DIRECTORY_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  test("a bank statement asks for the last twelve months, not the account's whole history", async () => {
    await reports.getBankTransactions(U, 't-stmt', 'acc-1');
    expect(api.getBankTransactions.mock.calls[0][2]).toMatch(/Date >= DateTime\(\d{4},\s?\d{1,2},\s?\d{1,2}\)/);
    expect(api.getPayments.mock.calls[0][2]).toMatch(/Date >= DateTime\(/);
  });
});

// Identical work was fetched twice whenever two callers spelled the same
// request differently. The dedupe key was JSON.stringify(args), which follows
// property order: the /cash-flow route builds { timezone, period, force } and
// the commentary builds { timezone, force, period }; getPerformance added a
// `window` the /budget-variance route never sends. Each pair missed the other
// and both went to Xero.
describe('Xero call budget — one request spelled two ways is fetched once', () => {
  const P = { preset: 'fy' };

  test('cash flow asked for in two property orders makes one set of calls', async () => {
    const T2 = 't-order-cf';
    await Promise.all([
      reports.getCashFlow(U, T2, { timezone: 'UTC', period: P, force: false }),   // the /cash-flow route
      reports.getCashFlow(U, T2, { timezone: 'UTC', force: false, period: P }),   // getVarianceInsights, getFinancialNarrative
    ]);
    expect(api.getPayments).toHaveBeenCalledTimes(1);
    expect(api.getBankTransactions).toHaveBeenCalledTimes(1);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
  });

  test('budget variance from its route and from getPerformance makes one pair of report calls', async () => {
    const T2 = 't-order-bv';
    await Promise.all([
      reports.getBudgetVariance(U, T2, { timezone: 'UTC', force: false, period: P }),   // /budget-variance
      reports.getPerformance(U, T2, { timezone: 'UTC', period: P, cashFlow: false, customers: false, force: false }),   // /performance
    ]);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(1);
  });

  test('the Insights page first load (figures, commentary and cash flow together) fetches each report once', async () => {
    const T2 = 't-order-page';
    await Promise.all([
      reports.getPerformance(U, T2, { timezone: 'UTC', period: P, cashFlow: false, customers: false, force: false }),
      reports.getVarianceInsights(U, T2, { timezone: 'UTC', period: P, force: false, reanalyse: false }),
      reports.getCashFlow(U, T2, { timezone: 'UTC', period: P, force: false }),
    ]);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(1);
    expect(api.getPayments).toHaveBeenCalledTimes(1);
  });

  test('an option left out and the same option at its default are one request', async () => {
    const T2 = 't-defaults';
    await Promise.all([
      reports.getBudgetVariance(U, T2, { timezone: 'UTC', period: P }),                  // how the export reads it
      reports.getBudgetVariance(U, T2, { timezone: 'UTC', force: false, period: P }),
      reports.getBudgetVariance(U, T2, { timezone: 'UTC', force: undefined, period: P }),
    ]);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
  });

  test('different requests are still fetched separately', async () => {
    const T2 = 't-distinct';
    await Promise.all([
      reports.getBudgetVariance(U, T2, { timezone: 'UTC', period: { preset: 'fy' } }),
      reports.getBudgetVariance(U, T2, { timezone: 'UTC', period: { preset: 'prev-fy' } }),
    ]);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(2);
  });

  test('keys sort properties and drop undefined ones, at every depth', () => {
    expect(reports._dedupeKey('f', [U, T, { b: 1, a: { d: 2, c: undefined, e: 3 } }]))
      .toBe(reports._dedupeKey('f', [U, T, { a: { e: 3, d: 2 }, b: 1 }]));
    expect(reports._dedupeKey('f', [U, T, { period: { from: '2026-01', to: '2026-02' } }]))
      .not.toBe(reports._dedupeKey('f', [U, T, { period: { from: '2026-02', to: '2026-01' } }]));
  });
});

// The cache key held the months but not the period's name, while the payload
// carries the name: a custom Jan-Dec and 'fy' for a December year end shared an
// entry, and the second came back titled as the first.
describe('the cache — a period is its months and its name', () => {
  const y = new Date().getUTCFullYear();
  const custom = { from: `${y}-01`, to: `${y}-12` };
  beforeEach(() => {
    api.getOrganisations.mockResolvedValue({ body: { organisations: [
      { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 },
    ] } });
  });

  test('budget variance: fy then a custom range over the same months each keep their own name', async () => {
    const T2 = 't-names-bv';
    const fy = await reports.getBudgetVariance(U, T2, { timezone: 'UTC', period: { preset: 'fy' } });
    const cu = await reports.getBudgetVariance(U, T2, { timezone: 'UTC', period: custom });
    expect(fy.period).toMatchObject({ key: 'fy', label: 'This financial year', fromKey: `${y}-01`, toKey: `${y}-12` });
    expect(cu.period).toMatchObject({ key: 'custom', fromKey: `${y}-01`, toKey: `${y}-12` });
    expect(fy.fiscalYear.label).toBe(`For the year ended 31 December ${y}`);
    expect(cu.fiscalYear.label).not.toMatch(/year ended/);

    // And the other way round, from cold.
    reports._cache.clear();
    const cu2 = await reports.getBudgetVariance(U, T2, { timezone: 'UTC', period: custom });
    const fy2 = await reports.getBudgetVariance(U, T2, { timezone: 'UTC', period: { preset: 'fy' } });
    expect(cu2.period.key).toBe('custom');
    expect(fy2.period.key).toBe('fy');
    expect(fy2.fiscalYear.label).toBe(`For the year ended 31 December ${y}`);
  });

  test('a repeat of the same named period is still served from the cache', async () => {
    const T2 = 't-names-hit';
    await reports.getBudgetVariance(U, T2, { timezone: 'UTC', period: { preset: 'fy' } });
    const again = await reports.getBudgetVariance(U, T2, { timezone: 'UTC', period: { preset: 'fy' } });
    expect(again.cached).toBe(true);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
  });

  test('cash flow, which copies the period into its payload, keeps them apart too', async () => {
    const T2 = 't-names-cf';
    const fy = await reports.getCashFlow(U, T2, { timezone: 'UTC', period: { preset: 'fy' } });
    const cu = await reports.getCashFlow(U, T2, { timezone: 'UTC', period: custom });
    expect(fy.period.key).toBe('fy');
    expect(cu.period.key).toBe('custom');
    expect(cu.period.label).not.toBe(fy.period.label);
  });
});

describe('Xero call budget — an over-long period never reaches the report endpoints', () => {
  test('a direct caller past the route check is refused with a PeriodError, and no report is fetched', async () => {
    await expect(reports.getBudgetVariance(U, 't-too-long', { period: { from: '1900-01', to: '2100-12' } }))
      .rejects.toMatchObject({ name: 'PeriodError', status: 400 });
    await expect(reports.getCashFlow(U, 't-too-long', { period: { from: '2015-12', to: '2026-12' } }))
      .rejects.toMatchObject({ name: 'PeriodError' });
    expect(api.getReportProfitAndLoss).not.toHaveBeenCalled();
    expect(api.getReportBudgetSummary).not.toHaveBeenCalled();
    expect(api.getPayments).not.toHaveBeenCalled();
  });
});

// Xero applies the ProfitAndLoss anchor's date RANGE to every comparison
// period ("if the specified date range is for a 30 day month, each prior
// period will only include the first 30 days"), so any period ending in a
// month of fewer than 31 days lost the 29th to the 31st of the months before
// it, with no error. These pin the calls that avoid it, and what they cost.
describe('Xero call contract — every ProfitAndLoss column is a whole month', () => {
  const STANDARD_LAYOUT = 9;   // xero-node 7: tenant, from, to, periods, timeframe, 4 tracking ids, standardLayout, paymentsOnly
  const pnlCalls = () => api.getReportProfitAndLoss.mock.calls;
  const dayCount = iso => new Date(`${iso}T00:00:00Z`).getUTCDate();

  test('every ProfitAndLoss call asks for the standard layout, never the organisation\'s custom one', async () => {
    for (const period of [{ preset: 'fy' }, { preset: 'this-month' }, { from: '2024-01', to: '2026-08' }, { from: '2026-01', to: '2026-09' }]) {
      reports._cache.clear();
      api.getReportProfitAndLoss.mockClear();
      await reports.getBudgetVariance(U, T, { period, force: true });
      expect(pnlCalls().length).toBeGreaterThan(0);
      for (const call of pnlCalls()) {
        expect(call[STANDARD_LAYOUT]).toBe(true);
        expect(call.length).toBeLessThanOrEqual(11);
        for (const i of [5, 6, 7, 8]) expect(call[i]).toBeUndefined();   // no tracking filter
      }
    }
  });

  test('a period ending in a short month anchors on the 31-day month before it and fetches its last month alone', async () => {
    await reports.getBudgetVariance(U, T, { period: { from: '2026-01', to: '2026-09' }, force: true });
    expect(pnlCalls().map(c => c.slice(1, 5))).toEqual([
      ['2026-08-01', '2026-08-31', 7, 'MONTH'],        // Jan–Aug, each a full month
      ['2026-09-01', '2026-09-30', undefined, undefined],
    ]);
    expect(api.getReportBudgetSummary.mock.calls.map(c => c.slice(1))).toEqual([['2026-01-31', 9, 1]]);
  });

  test('any call with comparison periods is anchored on a whole 31-day month', async () => {
    for (const period of [{ from: '2026-01', to: '2026-11' }, { from: '2025-01', to: '2026-06' }, { from: '2015-10', to: '2026-09' }, { from: '2027-03', to: '2028-02' }]) {
      reports._cache.clear();
      api.getReportProfitAndLoss.mockClear();
      await reports.getBudgetVariance(U, T, { period, force: true });
      for (const [, from, to, periods] of pnlCalls()) {
        expect(from.endsWith('-01')).toBe(true);
        if (periods !== undefined) expect(dayCount(to)).toBe(31);
        else expect(from.slice(0, 7)).toBe(to.slice(0, 7));   // a lone month, whole
      }
    }
  });

  test.each([
    ['Jan–Sep',                        2, 1, { from: '2026-01', to: '2026-09' }],
    ['Jan–Nov',                        2, 1, { from: '2026-01', to: '2026-11' }],
    ['Jan–Feb',                        2, 1, { from: '2026-01', to: '2026-02' }],
    ['Jul–Sep (a quarter)',            2, 1, { from: '2026-07', to: '2026-09' }],
    ['Apr–Jun',                        2, 1, { from: '2026-04', to: '2026-06' }],
    ['Apr–Mar (a March year)',         1, 1, { from: '2026-04', to: '2027-03' }],
    ['18 months ending Dec',           3, 2, { from: '2025-07', to: '2026-12' }],
    ['18 months ending Jun',           3, 2, { from: '2025-01', to: '2026-06' }],
    ['132 months, Jan–Dec chunks',     11, 11, { from: '2016-01', to: '2026-12' }],
    ['132 months, Oct–Sep chunks',     22, 11, { from: '2015-10', to: '2026-09' }],
  ])('%s costs %i ProfitAndLoss and %i BudgetSummary calls', async (_name, pnl, budget, period) => {
    await reports.getBudgetVariance(U, T, { period, force: true });
    expect(api.getReportProfitAndLoss).toHaveBeenCalledTimes(pnl);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(budget);
  });
});

// The payload fields the screen and the exports read. The clock is fixed so the
// closed months are known; only Date is faked, so nothing waits on a timer.
describe('budget variance payload — what a period is called and what has closed', () => {
  const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
  const at = iso => jest.setSystemTime(new Date(iso));
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-07T03:00:00Z'), doNotFake: REAL_TIMERS }));
  afterEach(() => jest.useRealTimers());
  const get = (period, tenant = 't-payload') => reports.getBudgetVariance(U, tenant, { timezone: 'UTC', period });

  test('a year to date only when the period opens the financial year and stays inside it', async () => {
    // The org's year runs Apr–Mar.
    expect((await get({ preset: 'fy' })).period.toDateLabel).toBe('Year to date');
    expect((await get({ preset: 'fy-ytd' })).period.toDateLabel).toBe('Year to date');
    expect((await get({ preset: 'prev-fy' })).period.toDateLabel).toBe('Year to date');
    expect((await get({ from: '2026-04', to: '2026-09' })).period.toDateLabel).toBe('Year to date');
    expect((await get({ preset: 'last-12' })).period.toDateLabel).toBe('Period to date');
    expect((await get({ preset: 'this-quarter' })).period.toDateLabel).toBe('Period to date');
    expect((await get({ from: '2026-04', to: '2027-04' })).period.toDateLabel).toBe('Period to date');   // crosses into the next year
    expect((await get({ from: '2026-01', to: '2026-12' })).period.toDateLabel).toBe('Period to date');
  });

  test('the closed months are named, and are null while none has closed', async () => {
    expect((await get({ preset: 'fy' })).period).toMatchObject({
      closedFromLabel: 'Apr 2026', closedToLabel: 'Sep 2026', closedThroughISO: '2026-09-30',
    });
    expect((await get({ preset: 'prev-fy' })).period).toMatchObject({
      closedFromLabel: 'Apr 2025', closedToLabel: 'Mar 2026', closedThroughISO: '2026-03-31',
    });
    expect((await get({ preset: 'this-quarter' })).period).toMatchObject({
      closedFromLabel: null, closedToLabel: null, closedThroughISO: null,
    });
  });

  test('a custom range is named by its months once, not twice', async () => {
    expect((await get({ from: '2026-07', to: '2027-06' })).fiscalYear.label).toBe('Jul 2026 – Jun 2027');
    expect((await get({ preset: 'fy-ytd' })).fiscalYear.label).toBe('Financial year to date · Apr 2026 – Oct 2026');
    expect((await get({ preset: 'fy' })).fiscalYear.label).toBe('For the year ended 31 March 2027');
  });

  test('budgetMissing is true when BudgetSummary returns nothing, and false once it returns lines', async () => {
    expect((await get({ preset: 'fy' }, 't-nobudget')).budgetMissing).toBe(true);
    api.getReportBudgetSummary.mockResolvedValue({ body: { reports: [{ rows: [
      { rowType: 'Header', cells: [{ value: '' }] },
      { rowType: 'Section', title: 'Income', rows: [{ rowType: 'Row', cells: [{ value: 'Sales' }, ...Array(12).fill({ value: '10.00' })] }] },
    ] }] } });
    const withBudget = await get({ preset: 'fy' }, 't-budget');
    expect(withBudget.budgetMissing).toBe(false);
    expect(withBudget.rows.find(r => r.label === 'Sales')).toMatchObject({ section: 'Income', expense: false, unbudgeted: false });
    expect(withBudget.rows.find(r => r.label === 'Sales').cumulative.at(-1).budget).toBe(120);
  });

  test('a period whose first month has just begun is not served from the day before', async () => {
    // Three minutes either side of midnight: inside the cache lifetime, and no
    // month of the period closes in between — only the month in progress moves.
    at('2026-10-31T23:58:00Z');
    const before = await get({ from: '2026-11', to: '2026-11' }, 't-midnight');
    expect(before.months[0].current).toBe(false);
    at('2026-11-01T00:01:00Z');
    const after = await get({ from: '2026-11', to: '2026-11' }, 't-midnight');
    expect(after.months[0].current).toBe(true);
    expect(after.kpis.currentMonth).toMatchObject({ key: '2026-11' });
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(2);
  });
});
