// The Cash Flow Manager checked: its opening balance against the Bank Summary
// per account, and its open invoices and bills against the ageing. Xero is
// mocked; nothing here reaches it.
jest.mock('xero-node', () => {
  const api = {
    getOrganisations:     jest.fn(),
    getInvoices:          jest.fn(),
    getCreditNotes:       jest.fn(),
    getReportBankSummary: jest.fn(),
    getAccounts:          jest.fn(),
    getRepeatingInvoices: jest.fn(),
    getPayments:          jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));

const { AccountingApi, __api: api } = require('xero-node');
require('../db/migrate').run();
const reports = require('./reports');
const { _balanceCheck, _openCheck } = require('./cash-manager-check');

const TODAY = '2026-10-12';
const cell = value => ({ value });
const row = (label, values) => ({ rowType: 'Row', cells: [label, ...values].map(cell) });
const bankRows = lines => [
  { rowType: 'Header', cells: ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'].map(cell) },
  { rowType: 'Section', title: '', rows: lines.map(([name, closing]) => row(name, ['0.00', '0.00', '0.00', closing])) },
];
let seq = 0;
const inv = over => ({
  invoiceID: `i${++seq}`, type: 'ACCREC', status: 'AUTHORISED', invoiceNumber: `INV-${seq}`,
  contact: { contactID: 'c1', name: 'Acme' }, date: '2026-09-01T00:00:00', dueDate: '2026-10-20T00:00:00',
  total: 100, amountDue: 100, currencyCode: 'SGD', ...over,
});
const U = 'u-cmc';
let n = 0, T;

beforeEach(() => {
  jest.clearAllMocks();
  reports._cache.clear();
  jest.useFakeTimers({ now: new Date(`${TODAY}T04:00:00Z`), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
  T = `t-cmc-${++n}`;
  api.getOrganisations.mockResolvedValue({ body: { organisations: [{ name: 'Org', baseCurrency: 'SGD' }] } });
  api.getInvoices.mockResolvedValue({ body: { invoices: [
    inv({ amountDue: 300 }), inv({ amountDue: 74, currencyCode: 'USD', currencyRate: 0.74 }),
    inv({ type: 'ACCPAY', amountDue: 120, contact: { contactID: 's1', name: 'Supplier' }, dueDate: '2027-06-01T00:00:00' }),   // past the horizon
    inv({ status: 'PAID', amountDue: 0 }),
  ] } });
  // A credit note nets the ageing's total and the projection's item; neither
  // side's gross moves.
  api.getCreditNotes.mockResolvedValue({ body: { creditNotes: [
    { creditNoteID: 'cn1', type: 'ACCRECCREDIT', status: 'AUTHORISED', contact: { contactID: 'c1', name: 'Acme' }, date: '2026-10-01T00:00:00', remainingCredit: 50, currencyCode: 'SGD' },
  ] } });
  api.getReportBankSummary.mockResolvedValue({ body: { reports: [{ rows: bankRows([['Operating', '1,000.00'], ['Savings', '250.00'], ['USD Account', '9,000.00']]) }] } });
  api.getAccounts.mockResolvedValue({ body: { accounts: [
    { accountID: 'a-op', name: 'Operating', type: 'BANK', currencyCode: 'SGD' },
    { accountID: 'a-sav', name: 'Savings', type: 'BANK', currencyCode: 'SGD' },
    { accountID: 'a-usd', name: 'USD Account', type: 'BANK', currencyCode: 'USD' },
  ] } });
  api.getRepeatingInvoices.mockResolvedValue({ body: { repeatingInvoices: [] } });
  api.getPayments.mockResolvedValue({ body: { payments: [] } });
});
afterEach(() => jest.useRealTimers());

const xeroCalls = () => Object.values(api).filter(f => f && f.mock).reduce((s, f) => s + f.mock.calls.length, 0);

test('the SDK is the mock', () => {
  expect(jest.isMockFunction(AccountingApi)).toBe(true);
});

test('everything agrees, in the check shape, and with the tab loaded the check costs no Xero call', async () => {
  await reports.getCashManager(U, T, { timezone: 'UTC' });
  const before = xeroCalls();
  const v = await reports.getCashManagerCheck(U, T, { timezone: 'UTC' });
  expect(xeroCalls()).toBe(before);
  expect(v).toMatchObject({ ok: true, calls: 0, period: null, currency: 'SGD' });
  expect(typeof v.checkedAt).toBe('string');
  expect(v.checks.map(c => [c.key, c.skipped, c.ok, c.calls])).toEqual([
    ['balance', false, true, 0], ['receivables', false, true, 0], ['payables', false, true, 0],
  ]);
  for (const c of v.checks) {
    expect(c).toEqual(expect.objectContaining({
      label: expect.any(String), lines: expect.any(Number), matched: expect.any(Number), differences: [],
      onlyInXero: [], onlyInApp: [], proves: expect.any(String),
    }));
  }
  // Two accounts and their total; the USD account is not one of them.
  expect(v.checks[0]).toMatchObject({ lines: 3, matched: 3 });
  expect(v.checks[0].proves).toMatch(/Left out, as on the tab: USD Account \(USD\)/);
  // 300 + 74 USD at 0.74, before the 50 of credit; the bill past the horizon counts.
  expect(v.checks[1].proves).toMatch(/\(2, 400\.00 before credit notes/);
  expect(v.checks[2].proves).toMatch(/\(1, 120\.00 before credit notes/);
  expect(v.notes.length).toBe(4);
});

test('cold, the check reads what the tab reads, once', async () => {
  const v = await reports.getCashManagerCheck(U, T, { timezone: 'UTC' });
  expect(v.ok).toBe(true);
  expect(api.getReportBankSummary).toHaveBeenCalledTimes(1);
  expect(api.getInvoices).toHaveBeenCalledTimes(1);
  expect(api.getCreditNotes).toHaveBeenCalledTimes(1);
});

test('an account switched off here and an adjustment made here are left out of the comparison', async () => {
  const users = require('../utils/users');
  const user  = await users.createUser(`cmc-${Date.now()}@test.com`, 'password123', 'user');
  require('../utils/cash-manager-store').forTenant(user.id, T).setBankOptions({
    'a-sav': { included: false }, 'a-op': { openingAdjustment: 500 },
  });
  const cm = await reports.getCashManager(user.id, T, { timezone: 'UTC' });
  expect(cm.bank.balance).toBe(1500);
  const v = await reports.getCashManagerCheck(user.id, T, { timezone: 'UTC' });
  expect(v.checks[0]).toMatchObject({ ok: true, lines: 2 });
  expect(v.checks[0].proves).toMatch(/Savings \(switched off here\)/);
});

test('a balance that is not Xero\'s is a difference, per account and in total', async () => {
  const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
  const wrong = { ...cm, bank: { ...cm.bank, balance: 1300, accounts: cm.bank.accounts.map(a => (a.name === 'Operating' ? { ...a, balance: 1050 } : a)) } };
  const c = await _balanceCheck(U, T, wrong, { timezone: 'UTC', force: false });
  expect(c.ok).toBe(false);
  expect(c.differences).toEqual([
    { label: 'Operating', column: `Closing ${TODAY}`, app: 1050, xero: 1000, diff: 50 },
    { label: 'Opening balance, less adjustments made here', column: `Closing ${TODAY}`, app: 1300, xero: 1250, diff: 50 },
  ]);
});

test('an account the Bank Summary has and the tab does not list is said', async () => {
  const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
  const missing = { ...cm, bank: { ...cm.bank, accounts: cm.bank.accounts.filter(a => a.name !== 'Savings'), balance: 1000 } };
  const c = await _balanceCheck(U, T, missing, { timezone: 'UTC', force: false });
  expect(c).toMatchObject({ ok: false, onlyInXero: ['Savings'] });
});

test('an open invoice lost on the way to a date is a difference against the ageing', async () => {
  const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
  const lost = { ...cm, open: { ...cm.open, receivables: { amount: 300, count: 1 } } };
  const c = await _openCheck(U, T, lost, 'receivables', { timezone: 'UTC', force: false });
  expect(c.ok).toBe(false);
  expect(c.differences).toEqual([
    { label: 'Open sales invoices, amount', column: TODAY, app: 300, xero: 400, diff: -100 },
    { label: 'Open sales invoices, count', column: TODAY, app: 1, xero: 2, diff: -1 },
  ]);
});

test('without a bank balance the balance check is skipped and says why; the others still run', async () => {
  api.getReportBankSummary.mockRejectedValue(new Error('bank summary down'));
  const v = await reports.getCashManagerCheck(U, T, { timezone: 'UTC' });
  expect(v.checks[0]).toMatchObject({ key: 'balance', skipped: true, reason: expect.stringMatching(/could not be read/), calls: 0 });
  expect(v.ok).toBe(true);
  expect(v.checks.filter(c => !c.skipped).map(c => c.key)).toEqual(['receivables', 'payables']);
});

test('a failure to reach Xero for the invoices is a failure, never an "agrees"', async () => {
  api.getInvoices.mockRejectedValue(new Error('Xero rate limit exceeded'));
  await expect(reports.getCashManagerCheck(U, T, { timezone: 'UTC' })).rejects.toThrow(/rate limit/);
});
