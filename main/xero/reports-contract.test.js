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
    expect(pnlCall.length).toBeLessThanOrEqual(3);   // tenant, from, to — no periods/timeframe
    expect(pnlCall[3]).toBeUndefined();

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
