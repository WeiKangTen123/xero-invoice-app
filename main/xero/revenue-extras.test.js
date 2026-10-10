// The Revenue tab's extras, top customers and the quote pipeline, were read
// from Xero on every visit to the tab: getPerformance is built from reports
// cached where they are fetched, and these two were fetched in it, with no
// entry of their own. Pinned here: a second visit costs no Xero call, a
// refresh past the grace window reads them again, each period keeps its own
// entry for as long as its figures are kept, two requests for the same
// period's extras share one read and the Overview never pays for them, quotes
// that cannot be read are asked for again next time, and a cold Dashboard load
// reads the organisation once.
//
// Xero is mocked; nothing here leaves the process.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
    getReportBankSummary:   jest.fn(),
    getBudgets:             jest.fn(),
    getInvoices:            jest.fn(),
    getAccounts:            jest.fn(),
    getQuotes:              jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

const { __api: api } = require('xero-node');
const reports = require('./reports');

const U = 'u-rev';
const PAST  = { from: '2025-01', to: '2025-03' };   // wholly past and settled: kept for hours
const PAST2 = { from: '2025-04', to: '2025-06' };
let n = 0, T;

const INVOICES = [
  { type: 'ACCREC', status: 'AUTHORISED', total: 200, amountDue: 200, date: '2025-02-01T00:00:00', dueDate: '2099-01-01T00:00:00', contact: { name: 'Acme' } },
  { type: 'ACCREC', status: 'PAID',       total: 100, amountDue: 0,   date: '2025-03-01T00:00:00', dueDate: '2099-01-01T00:00:00', contact: { name: 'Bolt' } },
];
const QUOTES = [{ quoteID: 'q1', status: 'SENT', total: 100, expiryDateString: '2099-01-01T00:00:00' }];

const extrasKey = (tenant, { from, to }) => `perfcustomers:${U}:${tenant}:${from}:${to}`;
// The extras' own reads: the period's sales invoices (the summary's invoice
// fetch has no where-clause) and the quotes.
const extrasCalls = () => ({
  invoices: api.getInvoices.mock.calls.filter(c => /ACCREC/.test(c[2] || '')).length,
  quotes:   api.getQuotes.mock.calls.length,
});
// Every call to the mocked SDK, whichever method. The SDK guard may add a
// marker to the instance that is not a mock, hence the optional chaining.
const totalCalls = () => Object.values(api).reduce((sum, fn) => sum + (fn?.mock?.calls.length || 0), 0);
const revenue  = (tenant, period, extra = {}) => reports.getPerformance(U, tenant, { period, customers: true, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  reports._cache.clear();
  T = `t-rev-${++n}`;
  const empty = { body: { reports: [{ rows: [] }] } };
  api.getOrganisations.mockResolvedValue({ body: { organisations: [
    { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 },
  ] } });
  api.getReportProfitAndLoss.mockResolvedValue(empty);
  api.getReportBudgetSummary.mockResolvedValue(empty);
  api.getReportBankSummary.mockResolvedValue(empty);
  api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
  api.getInvoices.mockResolvedValue({ body: { invoices: INVOICES } });
  api.getAccounts.mockResolvedValue({ body: { accounts: [] } });
  api.getQuotes.mockResolvedValue({ body: { quotes: QUOTES } });
});

describe('the Revenue tab\'s extras are cached, per period, for as long as the period\'s figures', () => {
  test('a second visit costs no Xero call at all, and shows the same figures', async () => {
    const first = await revenue(T, PAST);
    expect(first.customerRevenue).toMatchObject({ available: true, count: 2, total: 300 });
    expect(first.customerRevenue.customers.map(c => c.name)).toEqual(['Acme', 'Bolt']);
    expect(first.quotePipeline).toMatchObject({ available: true, sent: 100, total: 100, fromISO: '2025-01-01' });
    expect(extrasCalls()).toEqual({ invoices: 1, quotes: 1 });

    jest.clearAllMocks();
    const again = await revenue(T, PAST);
    expect(totalCalls()).toBe(0);
    expect(again.customerRevenue).toEqual(first.customerRevenue);
    expect(again.quotePipeline).toEqual(first.quotePipeline);
  });

  test('a refresh within seconds reuses the entry; one past the grace window reads both again', async () => {
    await revenue(T, PAST);
    jest.clearAllMocks();
    await revenue(T, PAST, { force: true });
    expect(extrasCalls()).toEqual({ invoices: 0, quotes: 0 });

    for (const [k, v] of reports._cache) if (k.includes(`:${U}:${T}`)) v.fetchedAt -= reports.FORCE_GRACE_MS + 1;
    const perf = await revenue(T, PAST, { force: true });
    expect(extrasCalls()).toEqual({ invoices: 1, quotes: 1 });
    expect(perf.customerRevenue).toMatchObject({ available: true, total: 300 });
  });

  test('each period keeps its own entry, asked for by its own months', async () => {
    await revenue(T, PAST);
    await revenue(T, PAST2);
    expect(extrasCalls()).toEqual({ invoices: 2, quotes: 2 });
    const invoiceWheres = api.getInvoices.mock.calls.map(c => c[2]).filter(w => /ACCREC/.test(w || ''));
    expect(invoiceWheres[0]).toMatch(/DateTime\(2025,1,1\).*DateTime\(2025,4,1\)/);
    expect(invoiceWheres[1]).toMatch(/DateTime\(2025,4,1\).*DateTime\(2025,7,1\)/);
    expect(api.getQuotes.mock.calls.map(c => c[2])).toEqual(['2025-01-01', '2025-04-01']);
    expect(reports._cache.has(extrasKey(T, PAST))).toBe(true);
    expect(reports._cache.has(extrasKey(T, PAST2))).toBe(true);

    jest.clearAllMocks();
    await revenue(T, PAST);
    await revenue(T, PAST2);
    expect(totalCalls()).toBe(0);
  });

  test('a settled period is kept for hours, a period still running for minutes', async () => {
    await revenue(T, PAST);
    expect(reports._cache.get(extrasKey(T, PAST)).ttl).toBe(reports.TTL_CLOSED_MS);

    const open = await revenue(T, { preset: 'this-month' });
    const key  = extrasKey(T, { from: open.period.fromKey, to: open.period.toKey });
    expect(reports._cache.get(key).ttl).toBe(reports.TTL_OPEN_MS);
  });

  test('the Overview never pays for them, and two Revenue requests for one period share one read', async () => {
    const [overview, revenueTab, withCash] = await Promise.all([
      reports.getPerformance(U, T, { period: PAST }),
      revenue(T, PAST),
      revenue(T, PAST, { cashFlow: true }),   // a different getPerformance request, the same extras
    ]);
    expect(extrasCalls()).toEqual({ invoices: 1, quotes: 1 });
    expect(overview.customerRevenue).toMatchObject({ available: false, customers: [] });
    expect(overview.quotePipeline).toMatchObject({ available: false, total: 0 });
    expect(revenueTab.customerRevenue).toEqual(withCash.customerRevenue);
    expect(revenueTab.quotePipeline).toEqual(withCash.quotePipeline);
  });

  test('quotes that cannot be read leave the customers shown and nothing cached, so the next visit asks again', async () => {
    api.getQuotes.mockRejectedValueOnce(new Error('403 Forbidden'));
    const a = await revenue(T, PAST);
    expect(a.customerRevenue).toMatchObject({ available: true, total: 300 });
    expect(a.quotePipeline).toMatchObject({ available: false, total: 0, counts: { sent: 0, accepted: 0 } });
    expect(reports._cache.has(extrasKey(T, PAST))).toBe(false);

    const b = await revenue(T, PAST);
    expect(b.quotePipeline).toMatchObject({ available: true, sent: 100 });
    expect(extrasCalls()).toEqual({ invoices: 2, quotes: 2 });
    expect(reports._cache.has(extrasKey(T, PAST))).toBe(true);
  });

  test('invoices that cannot be read leave both cards unavailable, and the report stands', async () => {
    api.getInvoices.mockImplementation((tenant, since, where) =>
      (/ACCREC/.test(where || '') ? Promise.reject(new Error('rate limited')) : Promise.resolve({ body: { invoices: INVOICES } })));
    const perf = await revenue(T, PAST);
    expect(perf.customerRevenue).toMatchObject({ available: false, customers: [], count: 0 });
    expect(perf.quotePipeline).toMatchObject({ available: false });
    expect(perf.months).toHaveLength(3);
    expect(reports._cache.has(extrasKey(T, PAST))).toBe(false);
  });
});

describe('a cold Dashboard load reads the organisation once', () => {
  test('getPerformance, which pulls the summary and Budget vs Actual together, makes one organisation call', async () => {
    await reports.getPerformance(U, T, { period: PAST });
    expect(api.getOrganisations).toHaveBeenCalledTimes(1);
    await revenue(T, PAST);
    expect(api.getOrganisations).toHaveBeenCalledTimes(1);
  });
});
