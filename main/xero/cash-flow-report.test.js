// The Cash Flow tab as fetched, when a read fails. An audit found two reads
// whose failure was drawn as a figure:
//
//   * a failed Payments or BankTransactions read became an empty list, so the
//     tab said "0.00 from customers", drew empty months and raised the "does
//     not tie" alert against a bank whose money had simply not been read;
//   * a failed Bank Summary made the waterfall walk 0 → receipts →
//     "Unreconciled" → 0.
//
// Xero is mocked, as everywhere in this suite; nothing here reaches it.
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
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

const { AccountingApi, __api: api } = require('xero-node');
const reports = require('./reports');

const U = 'u-cfr';
const PERIOD = { from: '2025-01', to: '2025-03' };   // wholly past: every month closed
const cell = value => ({ value });
const row = (label, values) => ({ rowType: 'Row', cells: [label, ...values].map(cell) });
const BANK_SUMMARY = [
  { rowType: 'Header', cells: ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'].map(cell) },
  { rowType: 'Section', title: '', rows: [row('Operating', ['10,000.00', '2,400.00', '(660.00)', '11,740.00'])] },
];
// Received 2,200 from customers and 200 otherwise, paid 660 to suppliers:
// exactly the Bank Summary's 2,400 and 660, so the records tie.
const PAYMENTS = [
  { paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: '2025-01-20', amount: 1100 },
  { paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: '2025-02-20', amount: 1100 },
  { paymentType: 'ACCPAYPAYMENT', status: 'AUTHORISED', date: '2025-01-25', amount: 330 },
  { paymentType: 'ACCPAYPAYMENT', status: 'AUTHORISED', date: '2025-02-25', amount: 330 },
];
const BANK_TX = [{ type: 'RECEIVE', status: 'AUTHORISED', date: '2025-03-01', total: 200 }];
// The cash flow's own payments read, over the period. The summary behind
// getPerformance reads payments too, open-ended over the year that dates its
// paid invoices (summary.js#_readPaidOn); these pay no invoice, so it uses none.
const CF_WHERE = 'Date >= DateTime(2025,1,1) && Date < DateTime(2025,4,1)';
const cashFlowReads = () => api.getPayments.mock.calls.filter(c => c[2] === CF_WHERE);

let n = 0;
const T = () => `t-cfr-${++n}`;

beforeEach(() => {
  jest.clearAllMocks();
  reports._cache.clear();
  const empty = { body: { reports: [{ rows: [] }] } };
  api.getOrganisations.mockResolvedValue({ body: { organisations: [
    { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 },
  ] } });
  api.getReportProfitAndLoss.mockResolvedValue(empty);
  api.getReportBudgetSummary.mockResolvedValue(empty);
  api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
  api.getReportBankSummary.mockResolvedValue({ body: { reports: [{ rows: BANK_SUMMARY }] } });
  api.getInvoices.mockResolvedValue({ body: { invoices: [] } });
  api.getPayments.mockResolvedValue({ body: { payments: PAYMENTS } });
  api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: BANK_TX } });
  api.getAccounts.mockResolvedValue({ body: { accounts: [{ accountID: 'a-op', name: 'Operating', type: 'BANK', currencyCode: 'SGD' }] } });
});

test('the SDK is the mock: nothing here reaches Xero', () => {
  expect(jest.isMockFunction(AccountingApi)).toBe(true);
  expect(jest.isMockFunction(api.getPayments)).toBe(true);
});

test('with every read in, the records are available, tie to the bank, and walk the waterfall', async () => {
  const cf = await reports.getCashFlow(U, T(), { period: PERIOD });
  expect(cf.recordsAvailable).toBe(true);
  expect(cf.movement).toMatchObject({ customerReceipts: 2200, cashIn: 2400, cashOut: 660 });
  expect(cf.unreconciled.material).toBe(false);
  expect(cf.waterfall).toMatchObject({ reconciles: true, bankClosing: 11740 });
  expect(cashFlowReads()).toHaveLength(1);
  expect(api.getPayments).toHaveBeenCalledTimes(2);   // and the summary's
  expect(api.getBankTransactions).toHaveBeenCalledTimes(1);
});

test.each([
  ['payments', () => api.getPayments.mockRejectedValue(new Error('rate limited'))],
  ['bank transactions', () => api.getBankTransactions.mockRejectedValue(new Error('rate limited'))],
])('a failed %s read is not a nil one: records unavailable, no runway, no waterfall, no "does not tie"', async (_, fail) => {
  fail();
  const cf = await reports.getCashFlow(U, T(), { period: PERIOD });
  expect(cf.recordsAvailable).toBe(false);
  // The bank's own figures stand; what was set against them does not.
  expect(cf.cash.available).toBe(true);
  expect(cf.unreconciled).toMatchObject({ material: false, inGap: 0, outGap: 0 });
  expect(cf.alerts.alerts.map(a => a.code)).not.toContain('unreconciled');
  expect(cf.runway).toEqual({ available: false, reason: 'Couldn’t read payments or bank transactions from Xero' });
  expect(cf.waterfall).toBeNull();
});

test('a failed Bank Summary leaves no waterfall rather than one from a balance of nothing', async () => {
  api.getReportBankSummary.mockRejectedValue(new Error('bank summary down'));
  const cf = await reports.getCashFlow(U, T(), { period: PERIOD });
  expect(cf.cash).toMatchObject({ available: false, opening: 0, closing: 0 });
  expect(cf.waterfall).toBeNull();
  // The records were read, and stand on their own.
  expect(cf.recordsAvailable).toBe(true);
  expect(cf.movement.customerReceipts).toBe(2200);
  expect(cf.unreconciled.material).toBe(false);
});

test('a payload missing a read is asked for again on the next load, not kept as long as a settled one', async () => {
  const t = T();
  let failed = false;
  api.getPayments.mockImplementation(async (tenantId, since, where) => {
    if (where === CF_WHERE && !failed) { failed = true; throw new Error('rate limited'); }
    return { body: { payments: PAYMENTS } };
  });
  const first = await reports.getCashFlow(U, t, { period: PERIOD });
  expect(first.recordsAvailable).toBe(false);
  const realNow = Date.now;
  // Past the short TTL, inside the hours a closed period's payload is kept.
  Date.now = () => realNow() + 6 * 60 * 1000;
  try {
    const again = await reports.getCashFlow(U, t, { period: PERIOD });
    expect(again.recordsAvailable).toBe(true);
    expect(cashFlowReads()).toHaveLength(2);
  } finally {
    Date.now = realNow;
  }
});
