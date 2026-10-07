// Fixes to the financial reports after review, each pinned here:
//
//   * payments, bank transactions, contacts and quotes were fetched unpaged —
//     every matching record in one response, on an API billed by volume;
//   * the quote pipeline counted sent quotes long past their expiry date;
//   * the recurring-revenue guess read "Project Management Fees", "Management
//     Consulting" and "Software Licence Sale" as recurring, and could not be
//     corrected;
//   * bank totals added accounts in other currencies to the base-currency
//     total at face value;
//   * an unreadable model reply was labelled as the model's and kept for half
//     an hour, and a cut-off narrative was asked for twice.
//
// Xero and the model are mocked; nothing here leaves the process.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
    getReportBankSummary:   jest.fn(),
    getBudgets:             jest.fn(),
    getInvoices:            jest.fn(),
    getPayments:            jest.fn(),
    getBankTransactions:    jest.fn(),
    getAccounts:            jest.fn(),
    getContacts:            jest.fn(),
    getQuotes:              jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn(), GEMINI_MODELS: [] }));
// The commentary's inputs are fixed here so the cache behaviour can be tested
// without building a budget that varies. The model call itself, its schema and
// its parsing are ai-insights' own, run for real against the mocked model.
jest.mock('./ai-insights', () => {
  const actual = jest.requireActual('./ai-insights');
  return {
    ...actual,
    _buildCategoryVariances: jest.fn(() => []),
    _varianceCandidates:     jest.fn(() => []),
  };
});

const { __api: api } = require('xero-node');
const { callGemini } = require('../utils/gemini-client');
const aiInsights = require('./ai-insights');
const logger = require('../utils/logger');
const reports = require('./reports');
const { _isRecurringName, _buildPerformance, _buildQuotePipeline, _bankByCurrency, LIST_PAGE_SIZE, LIST_MAX_PAGES } = reports;

const U = 'u-hard';
const PERIOD = { from: '2025-01', to: '2025-03' };
const cell = value => ({ value });
const row = (label, values, rowType = 'Row') => ({ rowType, cells: [label, ...values].map(cell) });
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const isoDaysFromNow = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const BANK_SUMMARY = [
  { rowType: 'Header', cells: ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'].map(cell) },
  section('', [
    row('Operating',   ['1,000.00', '300.00', '(100.00)', '1,200.00']),
    row('USD Account', ['5,000.00', '50.00', '0.00', '5,050.00']),
  ]),
];
const BANK_ACCOUNTS = [
  { accountID: 'acc-op',  name: 'Operating',   type: 'BANK', currencyCode: 'SGD', status: 'ACTIVE' },
  { accountID: 'acc-usd', name: 'USD Account', type: 'BANK', currencyCode: 'USD', status: 'ACTIVE' },
];

beforeEach(() => {
  jest.clearAllMocks();
  reports._cache.clear();
  const empty = { body: { reports: [{ rows: [] }] } };
  api.getOrganisations.mockResolvedValue({ body: { organisations: [
    { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 },
  ] } });
  api.getReportProfitAndLoss.mockResolvedValue(empty);
  api.getReportBudgetSummary.mockResolvedValue(empty);
  api.getReportBankSummary.mockResolvedValue(empty);
  api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
  api.getInvoices.mockResolvedValue({ body: { invoices: [] } });
  api.getPayments.mockResolvedValue({ body: { payments: [] } });
  api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: [] } });
  api.getAccounts.mockResolvedValue({ body: { accounts: [] } });
  api.getContacts.mockResolvedValue({ body: { contacts: [] } });
  api.getQuotes.mockResolvedValue({ body: { quotes: [] } });
});

// ── 1. Paging ───────────────────────────────────────────────────────────────
describe('list fetches are paged, 100 at a time, up to a cap', () => {
  const capWarned = what => logger.warn.mock.calls.some(([msg]) => msg === `${what} fetch hit the page cap; figures may be incomplete`);
  beforeEach(() => jest.spyOn(logger, 'warn'));
  afterEach(() => logger.warn.mockRestore());

  test('a page is Xero\'s fixed 100, and the cap stops only a runaway fetch', () => {
    expect(LIST_PAGE_SIZE).toBe(100);
    // These lists came back whole before paging, so the cap must not bite in an
    // ordinary busy year (2,000 payments did with 20 pages), but must still stop
    // a fetch heading for Xero's 100,000-record unpaged ceiling.
    expect(LIST_MAX_PAGES * LIST_PAGE_SIZE).toBeGreaterThanOrEqual(10000);
    expect(LIST_MAX_PAGES * LIST_PAGE_SIZE).toBeLessThan(100000);
  });

  test('contacts: pages are followed until a short one', async () => {
    const contact = i => ({ contactID: `c${i}`, name: `Contact ${i}` });
    api.getContacts
      .mockResolvedValueOnce({ body: { contacts: many(100, contact) } })
      .mockResolvedValueOnce({ body: { contacts: many(100, i => contact(100 + i)) } })
      .mockResolvedValueOnce({ body: { contacts: many(37, i => contact(200 + i)) } });
    const { contacts } = await reports.getContacts(U, 't-contacts');
    expect(api.getContacts.mock.calls.map(c => c[5])).toEqual([1, 2, 3]);   // page is the sixth argument
    expect(api.getContacts.mock.calls[0][7]).toBe(true);                     // still summaryOnly
    expect(contacts).toHaveLength(237);
    expect(capWarned('Contact')).toBe(false);
  });

  test('contacts: a full page every time stops at the cap and says so', async () => {
    api.getContacts.mockResolvedValue({ body: { contacts: many(100, i => ({ contactID: `c${i}`, name: 'C' })) } });
    const { contacts } = await reports.getContacts(U, 't-contacts-cap');
    expect(api.getContacts).toHaveBeenCalledTimes(LIST_MAX_PAGES);
    expect(contacts).toHaveLength(LIST_MAX_PAGES * 100);
    expect(capWarned('Contact')).toBe(true);
  });

  test('a bank statement pages both its bank transactions and its payments', async () => {
    const tx = i => ({ bankTransactionID: `bt${i}`, type: 'RECEIVE', status: 'AUTHORISED', date: '2026-08-05', total: 1 });
    const pay = i => ({ paymentID: `p${i}`, paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: '2026-08-06', amount: 1 });
    api.getBankTransactions
      .mockResolvedValueOnce({ body: { bankTransactions: many(100, tx) } })
      .mockResolvedValueOnce({ body: { bankTransactions: many(20, i => tx(100 + i)) } });
    api.getPayments
      .mockResolvedValueOnce({ body: { payments: many(100, pay) } })
      .mockResolvedValueOnce({ body: { payments: [] } });
    const { transactions } = await reports.getBankTransactions(U, 't-stmt', 'acc-1');
    // page is the fifth argument of both; the filter and order are unchanged.
    expect(api.getBankTransactions.mock.calls.map(c => c[4])).toEqual([1, 2]);
    expect(api.getPayments.mock.calls.map(c => c[4])).toEqual([1, 2]);
    expect(api.getBankTransactions.mock.calls[1][2]).toMatch(/^BankAccount\.AccountID==Guid\("acc-1"\) && Date >= DateTime\(/);
    expect(api.getPayments.mock.calls[1][3]).toBe('Date DESC');
    expect(transactions).toHaveLength(220);
  });

  test('a bank statement\'s transactions stop at the cap and say so', async () => {
    api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: many(100, i => ({ bankTransactionID: `bt${i}`, type: 'SPEND', status: 'AUTHORISED', total: 1 })) } });
    const { transactions } = await reports.getBankTransactions(U, 't-stmt-cap', 'acc-1');
    expect(api.getBankTransactions).toHaveBeenCalledTimes(LIST_MAX_PAGES);
    expect(transactions).toHaveLength(LIST_MAX_PAGES * 100);
    expect(capWarned('Bank transaction')).toBe(true);
  });

  test('cash flow pages payments and bank transactions over the period, and counts every page', async () => {
    const pay = i => ({ paymentID: `p${i}`, paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: '2025-02-10', amount: 1 });
    const tx = i => ({ bankTransactionID: `t${i}`, type: 'SPEND', status: 'AUTHORISED', date: '2025-02-11', total: 1 });
    api.getPayments
      .mockResolvedValueOnce({ body: { payments: many(100, pay) } })
      .mockResolvedValueOnce({ body: { payments: many(100, i => pay(100 + i)) } })
      .mockResolvedValueOnce({ body: { payments: many(3, i => pay(200 + i)) } });
    api.getBankTransactions
      .mockResolvedValueOnce({ body: { bankTransactions: many(100, tx) } })
      .mockResolvedValueOnce({ body: { bankTransactions: many(1, i => tx(100 + i)) } });
    const cf = await reports.getCashFlow(U, 't-cf-pages', { period: PERIOD });
    expect(api.getPayments.mock.calls.map(c => c[4])).toEqual([1, 2, 3]);
    expect(api.getBankTransactions.mock.calls.map(c => c[4])).toEqual([1, 2]);
    for (const c of [...api.getPayments.mock.calls, ...api.getBankTransactions.mock.calls]) {
      expect(c[2]).toBe('Date >= DateTime(2025,1,1) && Date < DateTime(2025,4,1)');
    }
    expect(cf.movement.customerReceipts).toBe(203);
    expect(cf.movement.otherPayments).toBe(101);
  });

  test('cash flow payments stop at the cap and say so; a failed list still does not fail the report', async () => {
    api.getPayments.mockResolvedValue({ body: { payments: many(100, i => ({ paymentID: `p${i}`, paymentType: 'ACCPAYPAYMENT', status: 'AUTHORISED', date: '2025-02-10', amount: 1 })) } });
    api.getBankTransactions.mockRejectedValue(new Error('rate limited'));
    const cf = await reports.getCashFlow(U, 't-cf-cap', { period: PERIOD });
    expect(api.getPayments).toHaveBeenCalledTimes(LIST_MAX_PAGES);
    expect(cf.movement.supplierPayments).toBe(LIST_MAX_PAGES * 100);
    expect(capWarned('Payment')).toBe(true);
  });
});

// ── 2. Quote pipeline ───────────────────────────────────────────────────────
describe('quote pipeline — expired quotes are not pipeline', () => {
  test('a sent quote past its expiry date is left out and counted as expired; accepted ones stay', () => {
    const q = _buildQuotePipeline([
      { status: 'SENT',     total: 100, expiryDateString: '2026-10-06T00:00:00' },        // expired yesterday
      { status: 'SENT',     total: 200, expiryDateString: '2026-10-07T00:00:00' },        // expires today: still live
      { status: 'SENT',     total: 300, expiryDate: new Date(Date.UTC(2026, 8, 1)) },     // a Date object, expired
      { status: 'SENT',     total: 400, expiryDate: '/Date(1798761600000+0000)/' },        // 2027-01-01, live
      { status: 'SENT',     total: 500 },                                                  // no expiry date: live
      { status: 'ACCEPTED', total: 600, expiryDateString: '2026-01-01T00:00:00' },        // accepted: stays
      { status: 'INVOICED', total: 999, expiryDateString: '2027-01-01T00:00:00' },
    ], 'SGD', { todayISO: '2026-10-07' });
    expect(q).toMatchObject({ sent: 1100, accepted: 600, total: 1700, counts: { sent: 3, accepted: 1 }, expired: { count: 2, total: 400 } });
  });

  test('the expired figure is in base currency, and an expired quote\'s currency is not reported as part of the total', () => {
    const q = _buildQuotePipeline([
      { status: 'SENT', total: 100, currencyCode: 'USD', currencyRate: 0.5, expiryDateString: '2020-01-01T00:00:00' },
      { status: 'SENT', total: 50, currencyCode: 'SGD' },
    ], 'SGD', { todayISO: '2026-10-07' });
    expect(q.expired).toEqual({ count: 1, total: 200 });
    expect(q.total).toBe(50);
    expect(q.currency.mixed).toBe(false);
  });

  test('getPerformance pages the quotes from the period start and leaves out the expired ones', async () => {
    const live = i => ({ quoteID: `q${i}`, status: 'SENT', total: 10, expiryDateString: `${isoDaysFromNow(30)}T00:00:00` });
    api.getQuotes
      .mockResolvedValueOnce({ body: { quotes: many(100, live) } })
      .mockResolvedValueOnce({ body: { quotes: [
        { quoteID: 'old', status: 'SENT', total: 5000, expiryDateString: `${isoDaysFromNow(-10)}T00:00:00` },
        { quoteID: 'acc', status: 'ACCEPTED', total: 700 },
      ] } });
    const perf = await reports.getPerformance(U, 't-quotes', { period: PERIOD, customers: true });
    expect(api.getQuotes.mock.calls.map(c => c[8])).toEqual([1, 2]);        // page is the ninth argument
    expect(api.getQuotes.mock.calls[0][2]).toBe('2025-01-01');              // dateFrom: the period's first day
    expect(perf.quotePipeline).toMatchObject({
      sent: 1000, accepted: 700, total: 1700, counts: { sent: 100, accepted: 1 },
      expired: { count: 1, total: 5000 }, fromISO: '2025-01-01', available: true,
    });
  });
});

// ── 3. Recurring revenue ────────────────────────────────────────────────────
describe('recurring revenue — a tighter guess, and the person\'s marks override it', () => {
  test.each(['Project Management Fees', 'Management Consulting', 'Software Licence Sale',
             'Sale of Software Licences', 'Perpetual Licence', 'Ad-hoc Support', 'Support', 'Management Fees'])(
    '"%s" is not recurring by name', label => expect(_isRecurringName(label)).toBe(false));

  test.each(['Sales - Maintenance (Recurring)', 'Managed Services ARR', 'Managed IT Services', 'Software and Licenses',
             'Licence Fees', 'Software Licensing', 'Monthly Subscription', 'Client Retainers', 'Web Hosting',
             'SaaS Revenue', 'Support Contracts', 'Annual Support Plan'])(
    '"%s" is still recurring by name', label => expect(_isRecurringName(label)).toBe(true));

  const months = [{ key: '2025-01', label: 'Jan 2025' }, { key: '2025-02', label: 'Feb 2025' }];
  const acct = (label, actual) => ({ kind: 'account', label, section: 'Income', monthly: actual.map(a => ({ actual: a, budget: 0 })) });
  const rows = [
    { kind: 'section', label: 'Income', section: 'Income' },
    acct('Hosting', [100, 100]),
    acct('Consulting', [40, 60]),
    acct('Project Management Fees', [5, 5]),
  ];

  test('a mark either way overrides the name, matched with case and spacing ignored; unmarked lines keep the guess', () => {
    const { serviceLines, split } = _buildPerformance({ months, rows, cash: {},
      recurringOverride: { recurring: ['  consulting '], notRecurring: ['HOSTING'] } });
    const by = Object.fromEntries(serviceLines.map(l => [l.label, l]));
    expect(by.Hosting).toMatchObject({ recurring: false, recurringByName: true, recurringSource: 'set' });
    expect(by.Consulting).toMatchObject({ recurring: true, recurringByName: false, recurringSource: 'set' });
    expect(by['Project Management Fees']).toMatchObject({ recurring: false, recurringByName: false, recurringSource: 'name' });
    expect(split.recurring.actual).toEqual([40, 60]);
    expect(split.project.actual).toEqual([105, 105]);
  });

  test('with no marks every line is the name-based guess', () => {
    const { serviceLines, split } = _buildPerformance({ months, rows, cash: {} });
    expect(serviceLines.every(l => l.recurringSource === 'name')).toBe(true);
    expect(split.recurring.actual).toEqual([100, 100]);
  });

  describe('end to end, through the saved settings', () => {
    let users, settingsStore;
    beforeAll(() => {
      require('../db/migrate').run();
      users = require('../utils/users');
      settingsStore = require('../utils/settings-store');
    });

    // Budget rows for three months, which is all a service line needs.
    const budgetRows = [
      { rowType: 'Header', cells: ['Account', 'Jan-25', 'Feb-25', 'Mar-25'].map(cell) },
      section('Income', [
        row('Hosting',                 ['100.00', '100.00', '100.00']),
        row('Project Management Fees', ['50.00', '50.00', '50.00']),
        row('Total Income',            ['150.00', '150.00', '150.00'], 'SummaryRow'),
      ]),
    ];

    test('getPerformance applies the account\'s own marks', async () => {
      api.getReportBudgetSummary.mockResolvedValue({ body: { reports: [{ rows: budgetRows }] } });
      const u = await users.createUser('marks@test.com', 'password123', 'user');
      settingsStore.forUser(u.id).set({ recurringAccounts: ['Project Management Fees'], notRecurringAccounts: ['Hosting'] });

      const perf = await reports.getPerformance(u.id, 't-marks', { period: PERIOD });
      const by = Object.fromEntries(perf.serviceLines.map(l => [l.label, l]));
      expect(by.Hosting).toMatchObject({ recurring: false, recurringSource: 'set' });
      expect(by['Project Management Fees']).toMatchObject({ recurring: true, recurringSource: 'set' });
      expect(perf.recurringAccounts).toEqual(['Project Management Fees']);
      expect(perf.split.recurring.budget).toEqual([50, 50, 50]);

      // Another account without marks gets the guess from the names.
      const other = await reports.getPerformance('someone-else', 't-marks', { period: PERIOD });
      expect(other.recurringAccounts).toEqual(['Hosting']);
    });
  });
});

// ── 4. Bank balances by currency ────────────────────────────────────────────
describe('bank totals add base-currency accounts only', () => {
  test('pure: foreign-currency lines are listed apart and flagged; an unlisted line is taken as base', () => {
    const bank = { accounts: [
      { name: 'Operating',   cashReceived: 100, cashSpent: 40, closingBalance: 1000, openingBalance: 940 },
      { name: 'USD Account', cashReceived: 50,  cashSpent: 0,  closingBalance: 5000, openingBalance: 4950 },
      { name: 'Petty Cash',  cashReceived: 0,   cashSpent: 0,  closingBalance: 10,   openingBalance: 10 },
    ] };
    const list = [{ accountId: 'a1', name: 'Operating', currency: 'SGD' }, { accountId: 'a2', name: 'usd  account', currency: 'USD' }];
    const r = _bankByCurrency(bank, list, 'SGD');
    expect(r).toMatchObject({ currency: 'SGD', closing: 1010, opening: 950, cashIn: 100, cashOut: 40, net: 60, baseOnly: true });
    expect(r.accounts.map(a => [a.name, a.currency])).toEqual([['Operating', 'SGD'], ['Petty Cash', 'SGD']]);
    expect(r.foreignAccounts).toEqual([expect.objectContaining({ name: 'USD Account', currency: 'USD', accountId: 'a2', closingBalance: 5000 })]);
  });

  test('pure: all base, or no base currency known, is the old sum with nothing flagged', () => {
    const bank = { accounts: [{ name: 'A', cashReceived: 1, cashSpent: 0, closingBalance: 5 }, { name: 'B', cashReceived: 2, cashSpent: 0, closingBalance: 7 }] };
    expect(_bankByCurrency(bank, [{ name: 'A', currency: 'SGD' }, { name: 'B', currency: 'SGD' }], 'SGD')).toMatchObject({ closing: 12, baseOnly: false, foreignAccounts: [] });
    expect(_bankByCurrency(bank, [{ name: 'A', currency: 'USD' }], '')).toMatchObject({ closing: 12, baseOnly: false });
  });

  test('performance: the USD account is not in cash at bank, cash in or cash out, and is listed in USD', async () => {
    api.getReportBankSummary.mockResolvedValue({ body: { reports: [{ rows: BANK_SUMMARY }] } });
    api.getAccounts.mockResolvedValue({ body: { accounts: BANK_ACCOUNTS } });
    const perf = await reports.getPerformance(U, 't-cur-perf', { period: PERIOD });
    expect(perf.cash).toMatchObject({ available: true, total: 1200, cashIn: 300, cashOut: 100, net: 200, baseOnly: true, currency: 'SGD' });
    expect(perf.cash.accounts).toEqual([{ name: 'Operating', currency: 'SGD', balance: 1200, cashIn: 300, cashOut: 100 }]);
    expect(perf.cash.foreignAccounts).toEqual([{ name: 'USD Account', currency: 'USD', balance: 5050, cashIn: 50, cashOut: 0 }]);
  });

  test('performance: without the bank account list every line is taken as base, as before', async () => {
    api.getReportBankSummary.mockResolvedValue({ body: { reports: [{ rows: BANK_SUMMARY }] } });
    api.getAccounts.mockRejectedValue(new Error('accounts down'));
    const perf = await reports.getPerformance(U, 't-cur-nolist', { period: PERIOD });
    expect(perf.cash).toMatchObject({ available: true, total: 6250, baseOnly: false, foreignAccounts: [] });
  });

  test('cash flow: closing and opening are base only, and the USD account\'s payments do not break the tie-out', async () => {
    api.getReportBankSummary.mockResolvedValue({ body: { reports: [{ rows: BANK_SUMMARY }] } });
    api.getAccounts.mockResolvedValue({ body: { accounts: BANK_ACCOUNTS } });
    api.getPayments.mockResolvedValue({ body: { payments: [
      { paymentID: 'p1', paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: '2025-02-10', amount: 300, account: { accountID: 'acc-op' } },
      { paymentID: 'p2', paymentType: 'ACCPAYPAYMENT', status: 'AUTHORISED', date: '2025-02-12', amount: 100, account: { accountID: 'acc-op' } },
      // 50 USD at 0.5 USD per SGD: 100 SGD into the USD account.
      { paymentID: 'p3', paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: '2025-02-15', amount: 50, currencyRate: 0.5, account: { accountID: 'acc-usd' } },
    ] } });
    const cf = await reports.getCashFlow(U, 't-cur-cf', { period: PERIOD });
    expect(cf.cash).toMatchObject({ available: true, closing: 1200, opening: 1000, cashIn: 300, cashOut: 100, baseOnly: true, currency: 'SGD' });
    expect(cf.cash.accounts).toEqual([{ name: 'Operating', currency: 'SGD', balance: 1200 }]);
    expect(cf.cash.foreignAccounts).toEqual([{ name: 'USD Account', currency: 'USD', balance: 5050 }]);
    // The movement is every account's, converted.
    expect(cf.movement.customerReceipts).toBe(400);
    // Compared with the bank like for like: base accounts' records against
    // base accounts' figures, so the USD receipt is no "gap".
    expect(cf.unreconciled.material).toBe(false);
    expect(cf.alerts.alerts.map(a => a.code)).not.toContain('unreconciled');
    expect(cf.waterfall).toMatchObject({ reconciles: true, bankClosing: 1200 });
  });
});

// ── 5. Commentary failures are short-lived and labelled ─────────────────────
describe('variance commentary — structured output, and a failure is not cached as the model\'s answer', () => {
  const CATEGORIES = [{
    key: 'revenue', title: 'Revenue', status: 'under', actual: 1000, budget: 1500, variance: -500,
    deltaText: '', topDrivers: [], defaultReason: 'Computed reason',
  }];
  const CANDIDATES = [{ account: 'Sales', actual: 1000, budget: 1500, variance: -500 }];
  beforeEach(() => {
    aiInsights._buildCategoryVariances.mockReturnValue(CATEGORIES);
    aiInsights._varianceCandidates.mockReturnValue(CANDIDATES);
  });
  const entryFor = T => [...reports._cache.entries()].find(([k]) => k.startsWith(`insights:v3:${U}:${T}:`))?.[1];
  const FALLBACK = { categories: [{ ...CATEGORIES[0], reason: 'Computed reason' }], lines: CANDIDATES };

  test('the call asks for the reply in the insights schema, naming only the accounts it was shown', async () => {
    callGemini.mockResolvedValue(JSON.stringify({ categories: [], reasons: [] }));
    await reports.getVarianceInsights(U, 't-ins-schema', { period: PERIOD });
    const { responseFormat } = callGemini.mock.calls[0][2];
    expect(responseFormat).toEqual(aiInsights._insightResponseFormat(CANDIDATES));
    expect(JSON.stringify(responseFormat)).toMatch(/"enum":\["Sales"\]/);
  });

  test('an unreadable reply is labelled as computed figures and cached for two minutes, then asked again', async () => {
    callGemini.mockResolvedValue('not json at all');
    const r = await reports.getVarianceInsights(U, 't-ins-parse', { period: PERIOD });
    expect(r).toMatchObject({ source: 'figures', failed: 'unparsed', ...FALLBACK });
    expect(entryFor('t-ins-parse').ttl).toBe(aiInsights.INSIGHT_FAILURE_TTL_MS);
    expect(aiInsights.INSIGHT_FAILURE_TTL_MS).toBeLessThanOrEqual(2 * 60 * 1000);

    // Within the two minutes it is served from the cache; after them the model is asked again.
    await reports.getVarianceInsights(U, 't-ins-parse', { period: PERIOD });
    expect(callGemini).toHaveBeenCalledTimes(1);
    entryFor('t-ins-parse').fetchedAt -= aiInsights.INSIGHT_FAILURE_TTL_MS + 1;
    await reports.getVarianceInsights(U, 't-ins-parse', { period: PERIOD });
    expect(callGemini).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['unavailable', new Error('every model failed')],
    ['truncated', Object.assign(new Error('cut off'), { code: 'GEMINI_TRUNCATED' })],
  ])('no reply (%s) is treated the same way', async (failed, err) => {
    callGemini.mockRejectedValue(err);
    const r = await reports.getVarianceInsights(U, `t-ins-${failed}`, { period: PERIOD });
    expect(r).toMatchObject({ source: 'figures', failed, ...FALLBACK });
    expect(entryFor(`t-ins-${failed}`).ttl).toBe(aiInsights.INSIGHT_FAILURE_TTL_MS);
  });

  test('a reply that was read is the model\'s, and is kept for the full half hour', async () => {
    callGemini.mockResolvedValue(JSON.stringify({
      categories: [{ key: 'revenue', reason: 'Fewer projects started than planned.' }],
      reasons: [{ account: 'Sales', reason: 'Two projects slipped into next quarter.' }],
    }));
    const r = await reports.getVarianceInsights(U, 't-ins-ok', { period: PERIOD });
    expect(r.source).toBe('gemini');
    expect(r.failed).toBeUndefined();
    expect(r.categories[0].reason).toBe('Fewer projects started than planned.');
    expect(r.lines[0].reason).toBe('Two projects slipped into next quarter.');
    expect(entryFor('t-ins-ok').ttl).toBe(reports.INSIGHT_CACHE_TTL_MS);
  });
});

// ── 6. A cut-off narrative is not asked for twice ───────────────────────────
describe('financial narrative — a truncated reply is not retried', () => {
  const cf = {
    organisation: { currency: 'SGD' }, period: { label: 'FY' },
    reconciliation: { revenueAccrual: 109330, customerReceipts: 26000 },
    workingCapital: { receivable: 109330, overdue: 57330, dso: 349, collectionRate: 0 },
    alerts: { alerts: [] },
  };

  test('one call, and the card says why it is missing', async () => {
    callGemini.mockRejectedValue(Object.assign(new Error('cut off'), { code: 'GEMINI_TRUNCATED' }));
    const started = Date.now();
    const r = await reports._narrateFrom(U, 't-narr-cut', cf, { force: true });
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ available: false, reason: 'truncated' });
    // No pause for a second attempt that would stop in the same place.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a reply still becomes the card, asked for in the narrative\'s own messages', async () => {
    callGemini.mockResolvedValue('The alerts share one cause.');
    const r = await reports._narrateFrom(U, 't-narr-ok', cf, { force: true });
    expect(r).toMatchObject({ available: true, text: 'The alerts share one cause.', source: 'gemini' });
    expect(callGemini.mock.calls[0][1]).toEqual(aiInsights._narrativeMessages(reports._narrativeFacts(cf)));
  });
});
