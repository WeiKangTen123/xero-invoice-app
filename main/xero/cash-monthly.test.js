// The monthly cash forecast: which row money belongs in, how a past month
// ties to Xero's Bank Summary, how this month mixes what moved with what is
// expected, how the months ahead are filled from the Cash Flow Manager and the
// budget, and what it costs in Xero calls. Xero is mocked, as everywhere in
// this suite; nothing here reaches it.
jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getInvoices:            jest.fn(),
    getCreditNotes:         jest.fn(),
    getReportBankSummary:   jest.fn(),
    getAccounts:            jest.fn(),
    getRepeatingInvoices:   jest.fn(),
    getPayments:            jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
    getBudgets:             jest.fn(),
    getBankTransactions:    jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

const { AccountingApi, __api: api } = require('xero-node');
require('../db/migrate').run();
const reportCache = require('./report-cache');
const {
  getCashMonthly, _buildCashMonthly, _accountCategory, _paymentCategory, _entryCategory, _itemCategory, _itemParts,
  _monthlyPaymentsOf, _monthlyBankTransactionsOf, _allocate, _splitToLargest, _movementByMonth, _bankTransactionParts,
  _budgetByMonth, _budgetHasFigures, _monthlySpan, _budgetCalls, _countedBank, _leftOutIds, _cmStamp, ROWS,
} = require('./cash-monthly');
const { _buildCashManager, _manualDates, getCashManager } = require('./cash-manager');
const { _outstandingOf } = require('./summary');
const { _creditsOf } = require('./ageing');

const TODAY = '2026-10-14';
const NOW = new Date(`${TODAY}T04:00:00Z`);
const fakeNow = () => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });

// A payload's row as { key: [values] }, and one cell.
const rowsOf = p => Object.fromEntries(p.rows.map(r => [r.key, r.values]));
const at = (p, key, month) => p.rows.find(r => r.key === key).values[p.months.findIndex(m => m.key === month)];
const src = (p, key, month) => p.rows.find(r => r.key === key).sources[p.months.findIndex(m => m.key === month)];

// ── Fixtures for the pure build ─────────────────────────────────────────────

const BANK_LIST = [
  { accountId: 'a-op',  name: 'Operating',   currency: 'SGD' },
  { accountId: 'a-sav', name: 'Savings',     currency: 'SGD' },
  { accountId: 'a-usd', name: 'USD Account', currency: 'USD' },
];
// Savings is switched off in the bank options; the USD account is foreign.
const OPTIONS = { 'a-sav': { included: false, openingAdjustmentCents: 0, overdraftCents: 0 } };
const ACCOUNTS = [
  { accountId: 'a-op',   code: '090', name: 'Operating',          type: 'BANK' },
  { accountId: 'a-rent', code: '400', name: 'Rent',               type: 'EXPENSE' },
  { accountId: 'a-wage', code: '477', name: 'Wages and Salaries', type: 'EXPENSE' },
  { accountId: 'a-loan', code: '900', name: 'Bank Loan',          type: 'TERMLIAB' },
  { accountId: 'a-gst',  code: '820', name: 'GST',                type: 'CURRLIAB' },
  { accountId: 'a-sale', code: '200', name: 'Sales',              type: 'REVENUE' },
];
const line = (name, o, r, s, c) => ({ name, openingBalance: o, cashReceived: r, cashSpent: s, closingBalance: c });
const BANK_AUG = { accounts: [line('Operating', 1000, 5000, 3000, 3000), line('Savings', 50000, 0, 0, 50000), line('USD Account', 7000, 0, 0, 7000)] };
const BANK_SEP = { accounts: [line('Operating', 3000, 2000, 1500, 3500), line('Savings', 50000, 500, 0, 50500), line('USD Account', 7000, 0, 0, 7000)] };

const pay = (id, type, date, amount, accountId = 'a-op') => ({
  paymentID: id, paymentType: type, status: 'AUTHORISED', date: new Date(`${date}T00:00:00Z`), amount, account: { accountID: accountId },
});
const btx = (id, type, date, total, lines = [], accountId = 'a-op', extra = {}) => ({
  bankTransactionID: id, type, status: 'AUTHORISED', date: new Date(`${date}T00:00:00Z`), total, bankAccount: { accountID: accountId },
  lineAmountTypes: 'Exclusive', lineItems: lines.map(([accountCode, lineAmount, taxAmount = 0]) => ({ accountCode, lineAmount, taxAmount })), ...extra,
});

const PAYMENTS = _monthlyPaymentsOf([
  pay('p-aug', 'ACCRECPAYMENT', '2026-08-10', 4000),
  pay('p-sav', 'ACCRECPAYMENT', '2026-08-11', 999, 'a-sav'),        // an account switched off
  pay('p-usd', 'ACCRECPAYMENT', '2026-08-12', 888, 'a-usd'),        // another currency
  pay('p-clr', 'ACCRECPAYMENT', '2026-08-13', 777, 'a-clearing'),   // not a bank account at all
  pay('p-sep', 'ACCPAYPAYMENT', '2026-09-05', 1000),
  pay('p-oct', 'ACCRECPAYMENT', '2026-10-03', 700),
  pay('p-old', 'ACCRECPAYMENT', '2026-07-31', 12345),               // before the first month shown
]);
const BANK_TX = _monthlyBankTransactionsOf([
  btx('b-rent', 'SPEND', '2026-08-20', 1000, [['400', 1000]]),
  btx('b-loan', 'RECEIVE', '2026-09-15', 2000, [['900', 2000]]),
  // Out of Operating into Savings, which is left out: the counted balance did lose it.
  btx('b-tr-out', 'SPEND-TRANSFER', '2026-09-20', 500, []),
  btx('b-tr-in', 'RECEIVE-TRANSFER', '2026-09-20', 500, [], 'a-sav'),
]);

// The Cash Flow Manager's payload, as much of it as this reads.
const item = (key, over) => ({
  key, direction: 'in', source: 'invoice', date: '2026-10-20', amount: 0, overdue: false, excluded: false, description: null, ...over,
});
const ITEMS = [
  item('invoice:i1', { amount: 300 }),
  item('invoice:b1', { direction: 'out', source: 'bill', date: '2026-10-25', amount: 100 }),
  item('invoice:i0', { date: '2026-09-30', amount: 500, overdue: true }),
  item('invoice:b0', { direction: 'out', source: 'bill', date: '2026-10-01', amount: 80, overdue: true }),
  item('repeating:r1:2026-11-01', { source: 'repeating', date: '2026-11-15', amount: 1000 }),
  item('manual:e1:2026-11-28', { direction: 'out', source: 'manual', date: '2026-11-28', amount: 900, description: 'GST Q3' }),
  item('invoice:ix', { date: '2026-11-20', amount: 5000, excluded: true }),
  item('manual:e2:2026-12-15', { direction: 'out', source: 'manual', date: '2026-12-15', amount: 1500, description: 'Staff bonus' }),
  item('invoice:i2', { date: '2026-12-03', amount: 250.1 }),
  item('invoice:i3', { date: '2026-12-04', amount: 0.2 }),
  item('invoice:far', { date: '2027-03-01', amount: 99, beyondHorizon: true, overridden: true }),
];
const cmOf = (over = {}) => ({
  organisation: { name: 'Org Pte Ltd', currency: 'SGD' },
  today: TODAY,
  bank: {
    available: true, balance: 4000, overdraft: 0,
    accounts: [
      { accountId: 'a-op', name: 'Operating', currency: 'SGD', balance: 4000, included: true, openingAdjustment: 0, overdraft: 0, foreign: false },
      { accountId: 'a-sav', name: 'Savings', currency: 'SGD', balance: 50500, included: false, openingAdjustment: 0, overdraft: 0, foreign: false },
      { accountId: 'a-usd', name: 'USD Account', currency: 'USD', balance: 7000, included: false, openingAdjustment: 0, overdraft: 0, foreign: true },
    ],
  },
  items: ITEMS.map(i => ({ ...i })),
  notes: [],
  ...over,
});

// The Overall Budget over the months ahead, as getBudgetVariance gives it.
const bline = (section, label, budgets) => ({ kind: 'account', section, label, monthly: budgets.map(b => ({ budget: b, actual: 0 })) });
const BUDGET = {
  budgetMissing: false,
  months: [{ key: '2026-11' }, { key: '2026-12' }, { key: '2027-01' }],
  rows: [
    { kind: 'section', label: 'Income', section: 'Income' },
    bline('Income', 'Sales', [800, 2000, 1500]),
    bline('Less Cost of Sales', 'Purchases', [400, 400, 400]),
    bline('Less Operating Expenses', 'Wages and Salaries', [1000, 1000, 1000]),
    bline('Less Operating Expenses', 'Depreciation', [300, 300, 300]),
    bline('Plus Other Income', 'Interest Income', [10, 10, 10]),
    { kind: 'summary', section: '', label: 'Net Profit', monthly: [{ budget: 99 }, { budget: 99 }, { budget: 99 }] },
  ],
};

const build = (over = {}) => _buildCashMonthly({
  todayISO: TODAY, past: 2, future: 3, fill: 'budget',
  cm: cmOf(), bankAccounts: BANK_LIST, bankOptions: OPTIONS,
  bankMonths: [BANK_AUG, BANK_SEP],
  payments: PAYMENTS, bankTransactions: BANK_TX, accounts: ACCOUNTS,
  budget: BUDGET,
  ...over,
});

// ── Which row money belongs in ──────────────────────────────────────────────

describe('which row money belongs in', () => {
  test('by the account a line is coded to: its type, and for expenses and liabilities its name', () => {
    const cases = [
      // A cash sale is a customer's money and a direct cost a supplier's, as
      // the budget fills the months ahead; other income stays other.
      [{ type: 'REVENUE', name: 'Sales' }, 'in', 'in_customer'],
      [{ type: 'SALES', name: 'Sales' }, 'in', 'in_customer'],
      [{ type: 'SALES', name: 'Sales' }, 'out', 'out_other'],
      [{ type: 'OTHERINCOME', name: 'Interest' }, 'in', 'in_other'],
      [{ type: 'EXPENSE', name: 'Rent' }, 'out', 'out_overheads'],
      [{ type: 'OVERHEADS', name: 'Electricity' }, 'out', 'out_overheads'],
      [{ type: 'DIRECTCOSTS', name: 'Purchases' }, 'out', 'out_supplier'],
      [{ type: 'DIRECTCOSTS', name: 'Purchases' }, 'in', 'in_other'],
      [{ type: 'EXPENSE', name: 'Wages and Salaries' }, 'out', 'out_wages'],
      [{ type: 'EXPENSE', name: 'CPF Contributions' }, 'out', 'out_wages'],
      [{ type: 'DIRECTCOSTS', name: 'Director bonus' }, 'out', 'out_wages'],
      [{ type: 'EXPENSE', name: 'Superannuation' }, 'out', 'out_wages'],
      [{ type: 'EXPENSE', name: 'Rent' }, 'in', 'in_other'],
      [{ type: 'WAGESEXPENSE', name: 'Gross pay' }, 'out', 'out_wages'],
      // "Staff" is wages only as staff costs, pay, salaries or wages.
      [{ type: 'EXPENSE', name: 'Staff costs' }, 'out', 'out_wages'],
      [{ type: 'EXPENSE', name: 'Staff salaries' }, 'out', 'out_wages'],
      [{ type: 'EXPENSE', name: 'Staff Wages' }, 'out', 'out_wages'],
      [{ type: 'OVERHEADS', name: 'Staff Amenities' }, 'out', 'out_overheads'],
      [{ type: 'EXPENSE', name: 'Staff welfare' }, 'out', 'out_overheads'],
      [{ type: 'EXPENSE', name: 'Staff training' }, 'out', 'out_overheads'],
      [{ type: 'EXPENSE', name: 'Sewage charges' }, 'out', 'out_overheads'],
      [{ type: 'EXPENSE', name: 'Supplies' }, 'out', 'out_overheads'],
      [{ type: 'CURRLIAB', name: 'GST' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'GST' }, 'in', 'in_other'],
      [{ type: 'CURRLIAB', name: 'VAT Control' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'Income Tax Payable' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'Output control', systemAccount: 'GST' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'Clearing', systemAccount: 'WAGEPAYABLES' }, 'out', 'out_wages'],
      [{ type: 'CURRLIAB', name: 'CPF Payable' }, 'out', 'out_wages'],
      // Payroll taxes held for the tax office are tax; superannuation is wages.
      [{ type: 'CURRLIAB', name: 'PAYE Payable' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'PAYG Withholdings Payable' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'Withholding Payable' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'NI Payable' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'PAYE & NIC Payable' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'National Insurance' }, 'out', 'out_tax'],
      [{ type: 'CURRLIAB', name: 'Superannuation Payable' }, 'out', 'out_wages'],
      [{ type: 'CURRLIAB', name: 'Super Payable' }, 'out', 'out_wages'],
      // Whole words only: none of these is tax or wages.
      [{ type: 'CURRLIAB', name: 'Union fees payable' }, 'out', 'out_finance'],
      [{ type: 'CURRLIAB', name: 'Private loan' }, 'out', 'out_finance'],
      [{ type: 'CURRLIAB', name: 'Supplies on account' }, 'out', 'out_finance'],
      [{ type: 'CURRLIAB', name: 'Staff loan' }, 'out', 'out_finance'],
      [{ type: 'CURRLIAB', name: 'Director Loan' }, 'in', 'in_finance'],
      [{ type: 'CURRLIAB', name: 'Director Loan' }, 'out', 'out_finance'],
      [{ type: 'TERMLIAB', name: 'Bank Loan' }, 'in', 'in_finance'],
      [{ type: 'TERMLIAB', name: 'Bank Loan' }, 'out', 'out_finance'],
      [{ type: 'LIABILITY', name: 'Hire purchase' }, 'out', 'out_finance'],
      [{ type: 'EQUITY', name: 'Share Capital' }, 'in', 'in_finance'],
      [{ type: 'EQUITY', name: 'Drawings' }, 'out', 'out_finance'],
      [{ type: 'FIXED', name: 'Office Equipment' }, 'out', 'out_finance'],
      [{ type: 'FIXED', name: 'Office Equipment' }, 'in', 'in_other'],
      [{ type: 'CURRENT', name: 'Deposits' }, 'out', 'out_other'],
      [null, 'in', 'in_other'],
      [null, 'out', 'out_other'],
    ];
    for (const [account, dir, row] of cases) expect({ account, dir, row: _accountCategory(account, dir) }).toEqual({ account, dir, row });
  });

  test('a payment settling an invoice is a customer\'s, one settling a bill a supplier\'s; a refund is neither', () => {
    const p = (type, amount = 10) => _monthlyPaymentsOf([pay('x', type, '2026-09-01', amount)])[0];
    expect(_paymentCategory(p('ACCRECPAYMENT'))).toBe('in_customer');
    expect(_paymentCategory(p('ACCPAYPAYMENT'))).toBe('out_supplier');
    expect(_paymentCategory(p('ARCREDITPAYMENT'))).toBe('out_other');   // money back to a customer
    expect(_paymentCategory(p('APCREDITPAYMENT'))).toBe('in_other');    // money back from a supplier
  });

  test('an entry going out is tax or wages by its words, else an overhead; one coming in is other income', () => {
    expect(_entryCategory('GST Q3')).toBe('out_tax');
    expect(_entryCategory('BAS payment')).toBe('out_tax');
    expect(_entryCategory('Payroll tax')).toBe('out_tax');
    expect(_entryCategory('Corporate tax instalment')).toBe('out_tax');
    expect(_entryCategory('Taxi fares')).toBe('out_overheads');
    expect(_entryCategory('Staff bonus')).toBe('out_wages');
    expect(_entryCategory('Salaries')).toBe('out_wages');
    expect(_entryCategory('Staff costs')).toBe('out_wages');
    expect(_entryCategory('Staff party')).toBe('out_overheads');
    expect(_entryCategory('Office rent')).toBe('out_overheads');
    expect(_itemCategory({ source: 'manual', direction: 'in', description: 'Loan drawdown' })).toBe('in_other');
    expect(_itemCategory({ source: 'invoice', direction: 'in' })).toBe('in_customer');
    expect(_itemCategory({ source: 'bill', direction: 'out' })).toBe('out_supplier');
    expect(_itemCategory({ source: 'repeating', direction: 'out' })).toBe('out_supplier');
    expect(_itemCategory({ source: 'payment', direction: 'in' })).toBe('in_customer');
  });

  test('a bank transaction is split across its lines by what each adds, tax included, to the cent', () => {
    const maps = { accountsByCode: new Map(ACCOUNTS.map(a => [a.code, a])), accountsById: new Map(), base: 'SGD' };
    const [t] = _monthlyBankTransactionsOf([btx('t', 'SPEND', '2026-09-01', 1090, [['400', 500, 45], ['477', 500, 45]])]);
    expect(_bankTransactionParts(t, maps)).toEqual([{ row: 'out_overheads', cents: 54500 }, { row: 'out_wages', cents: 54500 }]);
    // Inclusive lines already hold their tax.
    const [inc] = _monthlyBankTransactionsOf([btx('t', 'SPEND', '2026-09-01', 300, [['400', 200, 16.51], ['820', 100, 0]], 'a-op', { lineAmountTypes: 'Inclusive' })]);
    expect(_bankTransactionParts(inc, maps)).toEqual([{ row: 'out_overheads', cents: 20000 }, { row: 'out_tax', cents: 10000 }]);
    // A customer's prepayment is a customer's money whatever its lines say;
    // a transaction with no lines is other.
    const [pre] = _monthlyBankTransactionsOf([btx('t', 'RECEIVE-PREPAYMENT', '2026-09-01', 50, [['200', 50]])]);
    expect(_bankTransactionParts(pre, maps)).toEqual([{ row: 'in_customer', cents: 5000 }]);
    const [bare] = _monthlyBankTransactionsOf([btx('t', 'RECEIVE', '2026-09-01', 12, [])]);
    expect(_bankTransactionParts(bare, maps)).toEqual([{ row: 'in_other', cents: 1200 }]);
    // An account the chart does not name is other.
    const [odd] = _monthlyBankTransactionsOf([btx('t', 'SPEND', '2026-09-01', 7, [['999', 7]])]);
    expect(_bankTransactionParts(odd, maps)).toEqual([{ row: 'out_other', cents: 700 }]);
  });

  test('shares add up to exactly the total, however the cents fall', () => {
    expect(_allocate(100, [1, 1, 1])).toEqual([33, 34, 33]);
    expect(_allocate(1001, [3, 7])).toEqual([300, 701]);
    expect(_allocate(500, [0, 0])).toBeNull();
    for (const [total, w] of [[99999, [13, 17, 19, 23]], [1, [5, 5]], [12345, [-100, 300]]]) {
      expect(_allocate(total, w).reduce((s, v) => s + v, 0)).toBe(total);
    }
  });

  test('a budget gap is shared by the budget\'s weights, the rounding cent on the largest row', () => {
    expect(_splitToLargest(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(_splitToLargest(100, [1, 3, 1])).toEqual([20, 60, 20]);
    expect(_splitToLargest(320000, [0, 320000, 500000])).toEqual([0, 124878, 195122]);
    expect(_splitToLargest(500, [0, 0, 0])).toBeNull();
    for (const [total, w] of [[99999, [13, 17, 19]], [1, [5, 5, 5]], [7, [1, 0, 2]]]) {
      const shares = _splitToLargest(total, w);
      expect(shares.reduce((s, v) => s + v, 0)).toBe(total);
      expect(shares.every(v => v >= 0)).toBe(true);
    }
  });

  test('a bank transaction dated ahead is split by its lines\' accounts, or whole under its largest line when they do not add up', () => {
    const byCode = new Map(ACCOUNTS.map(a => [a.code, a]));
    const tx = (amount, accounts, direction = 'out') => ({ source: 'banktx', direction, amount, accounts });
    expect(_itemParts(tx(1090, [{ code: '400', amount: 545 }, { code: '477', amount: 545 }]), byCode))
      .toEqual([{ row: 'out_overheads', cents: 54500 }, { row: 'out_wages', cents: 54500 }]);
    expect(_itemParts(tx(2000, [{ code: '900', amount: 2000 }], 'in'), byCode)).toEqual([{ row: 'in_finance', cents: 200000 }]);
    expect(_itemParts(tx(120.5, [{ code: '200', amount: 120.5 }], 'in'), byCode)).toEqual([{ row: 'in_customer', cents: 12050 }]);
    // An amount changed on the Cash Flow Manager: whole, under the largest line's row.
    expect(_itemParts(tx(700, [{ code: '820', amount: 300 }, { code: '400', amount: 500 }]), byCode)).toEqual([{ row: 'out_overheads', cents: 70000 }]);
    // No lines, or no chart to read them by: other.
    expect(_itemParts(tx(50, []), byCode)).toEqual([{ row: 'out_other', cents: 5000 }]);
    expect(_itemParts(tx(50, undefined, 'in'), byCode)).toEqual([{ row: 'in_other', cents: 5000 }]);
    expect(_itemParts(tx(80, [{ code: '400', amount: 80 }]), new Map())).toEqual([{ row: 'out_other', cents: 8000 }]);
    // One row, by its largest line, where a single row is asked for.
    expect(_itemCategory(tx(800, [{ code: '820', amount: 300 }, { code: '400', amount: 500 }]), byCode)).toBe('out_overheads');
    expect(_itemCategory(tx(800, []), byCode)).toBe('out_other');
    // Every other item is one row, as before.
    expect(_itemParts({ source: 'bill', direction: 'out', amount: 10 }, byCode)).toEqual([{ row: 'out_supplier', cents: 1000 }]);
  });
});

// ── Transfers ───────────────────────────────────────────────────────────────

describe('transfers between your own accounts', () => {
  test('between two counted accounts they are no money in or out, and are kept apart', () => {
    const records = _monthlyBankTransactionsOf([
      btx('o', 'SPEND-TRANSFER', '2026-09-20', 500, [], 'a-op'),
      btx('i', 'RECEIVE-TRANSFER', '2026-09-20', 500, [], 'a-sav'),
    ]);
    const m = _movementByMonth({ payments: [], bankTransactions: records, accounts: ACCOUNTS, base: 'SGD', fromISO: '2026-09-01', toISO: TODAY }).get('2026-09');
    expect(m).toMatchObject({ rows: {}, transfersIn: 50000, transfersOut: 50000 });
    // Both counted: the month's rows hold nothing of it.
    const both = build({ bankOptions: {}, payments: [], bankTransactions: records,
      bankMonths: [BANK_AUG, { accounts: [line('Operating', 3000, 0, 500, 2500), line('Savings', 50000, 500, 0, 50500)] }] });
    expect(at(both, 'in_total', '2026-09')).toBe(0);
    expect(at(both, 'out_total', '2026-09')).toBe(0);
    expect(at(both, 'closing', '2026-09')).toBe(53000);
  });

  test('to an account left out of the balance, the money did leave it, and says so', () => {
    const p = build();
    expect(at(p, 'out_other', '2026-09')).toBe(500);
    expect(src(p, 'out_other', '2026-09')).toBe('transfers with accounts left out');
  });
});

// ── The past months ─────────────────────────────────────────────────────────

describe('the months before this one, as they happened', () => {
  test('rows from the records, the rest unexplained, so each month ties to the Bank Summary to the cent', () => {
    const p = build();
    const r = rowsOf(p);
    expect(p.months.map(m => [m.key, m.kind])).toEqual([
      ['2026-08', 'actual'], ['2026-09', 'actual'], ['2026-10', 'current'], ['2026-11', 'forecast'], ['2026-12', 'forecast'], ['2027-01', 'forecast'],
    ]);
    expect(p.rows.map(x => x.key)).toEqual(ROWS.map(x => x.key));
    // August: 4,000 from a customer and 1,000 of rent explained; the Bank
    // Summary's other 1,000 in and 2,000 out are unexplained. Savings, the
    // USD account and the clearing account are not in it.
    expect([r.opening[0], r.in_customer[0], r.in_other[0], r.in_finance[0], r.in_total[0]]).toEqual([1000, 4000, 1000, 0, 5000]);
    expect([r.out_supplier[0], r.out_overheads[0], r.out_other[0], r.out_total[0], r.net[0], r.closing[0]]).toEqual([0, 1000, 2000, 3000, 2000, 3000]);
    expect(src(p, 'in_customer', '2026-08')).toBe('payments');
    expect(src(p, 'out_overheads', '2026-08')).toBe('bank transactions');
    expect(src(p, 'out_other', '2026-08')).toBe('unexplained');
    expect(src(p, 'opening', '2026-08')).toBe('bank');
    // September: a supplier paid, a loan drawn, a transfer out to Savings.
    expect([r.opening[1], r.in_finance[1], r.out_supplier[1], r.out_other[1], r.closing[1]]).toEqual([3000, 2000, 1000, 500, 3500]);
    expect(p.ties).toEqual([{ key: '2026-08', agrees: true, difference: 0 }, { key: '2026-09', agrees: true, difference: 0 }]);
    for (let i = 0; i < 2; i++) expect(r.opening[i] + r.in_total[i] - r.out_total[i]).toBe(r.closing[i]);
  });

  test('records showing more than the bank on one side are netted on the other: no row negative, still tied', () => {
    // The records explain 4,000 in and 1,000 out; the bank received 3,000 and
    // spent 2,500. The 1,000 received that the records over-explain is netted
    // onto the out side's 1,500 unexplained.
    const p = build({ bankMonths: [{ accounts: [line('Operating', 1000, 3000, 2500, 1500)] }, BANK_SEP] });
    expect(at(p, 'in_other', '2026-08')).toBe(0);
    expect(at(p, 'out_other', '2026-08')).toBe(2500);
    expect(at(p, 'closing', '2026-08')).toBe(1500);
    expect(p.ties[0]).toEqual({ key: '2026-08', agrees: true, difference: 0 });
    for (const row of p.rows.filter(x => x.group === 'in' || x.group === 'out')) {
      for (const v of row.values) if (v !== null) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test('a Bank Summary that does not add up is said, and the closing balance is Xero\'s', () => {
    const p = build({ bankMonths: [{ accounts: [line('Operating', 1000, 5000, 3000, 3010)] }, BANK_SEP] });
    expect(at(p, 'closing', '2026-08')).toBe(3010);
    expect(p.ties[0].agrees).toBe(true);
    expect(p.notes.join(' ')).toMatch(/Bank Summary for Aug 2026 does not add up/);
    // And the jump to September's opening is said too.
    expect(p.notes.join(' ')).toMatch(/opening balance for Sep 2026 is 10\.00 less than Aug 2026's closing balance/);
  });

  test('a month whose Bank Summary could not be read opens on the month before\'s closing, unexplained nothing', () => {
    const p = build({ bankMonths: [BANK_AUG, null] });
    expect(at(p, 'opening', '2026-09')).toBe(3000);
    expect(src(p, 'opening', '2026-09')).toBe('previous closing');
    expect(at(p, 'closing', '2026-09')).toBe(3000 + 2000 - 1500);
    expect(p.ties).toHaveLength(1);
    expect(p.notes.join(' ')).toMatch(/Bank Summary for Sep 2026 could not be read/);
  });

  test('without the records, a past month is the Bank Summary\'s balances and movement, unsplit', () => {
    const p = build({ payments: null, recordsFailure: 'error' });
    expect(at(p, 'in_customer', '2026-08')).toBeNull();
    expect(at(p, 'in_total', '2026-08')).toBeNull();
    expect(at(p, 'net', '2026-08')).toBe(2000);
    expect(at(p, 'closing', '2026-08')).toBe(3000);
    expect(p.notes.join(' ')).toMatch(/Payments or bank transactions could not be read/);
  });

  test('cash sales and direct costs land under customers and suppliers, and the month still ties to the cent', () => {
    const accounts = [...ACCOUNTS,
      { accountId: 'a-cos', code: '310', name: 'Cost of Goods Sold', type: 'DIRECTCOSTS' },
      { accountId: 'a-int', code: '260', name: 'Interest Income', type: 'OTHERINCOME' }];
    const bankTransactions = _monthlyBankTransactionsOf([
      btx('b-rent', 'SPEND', '2026-08-20', 1000, [['400', 1000]]),
      btx('b-sale', 'RECEIVE', '2026-08-05', 1234.56, [['200', 1234.56]]),
      btx('b-cos', 'SPEND', '2026-08-07', 321.09, [['310', 300, 21.09]]),
      btx('b-int', 'RECEIVE', '2026-08-08', 10.01, [['260', 10.01]]),
    ]);
    const p = build({ accounts, bankTransactions, bankMonths: [{ accounts: [line('Operating', 1000, 6500, 3500, 4000)] }, BANK_SEP] });
    // 4,000 from a customer's invoice and 1,234.56 of cash sales; 321.09 of
    // direct costs; interest is other income, with the 1,255.43 the records
    // do not explain.
    expect(at(p, 'in_customer', '2026-08')).toBe(5234.56);
    expect(src(p, 'in_customer', '2026-08')).toBe('payments + bank transactions');
    expect(at(p, 'out_supplier', '2026-08')).toBe(321.09);
    expect(at(p, 'in_other', '2026-08')).toBe(1265.44);
    expect(at(p, 'out_overheads', '2026-08')).toBe(1000);
    expect(at(p, 'out_other', '2026-08')).toBe(2178.91);
    expect(p.ties[0]).toEqual({ key: '2026-08', agrees: true, difference: 0 });
    const c = v => Math.round(v * 100);
    expect(c(at(p, 'opening', '2026-08')) + c(at(p, 'in_total', '2026-08')) - c(at(p, 'out_total', '2026-08'))).toBe(c(at(p, 'closing', '2026-08')));
    expect(at(p, 'closing', '2026-08')).toBe(4000);
    expect(p.notes.join(' ')).toMatch(/cash sales under Customer receipts and direct costs under Supplier payments/);
  });

  test('a Bank Summary with no accounts in it is no balance, not a balance of nil', () => {
    expect(_countedBank({ accounts: [] }, BANK_LIST, 'SGD', OPTIONS)).toBeNull();
    // Lines that are all switched off or foreign are a nil balance of the
    // accounts chosen to count, as on the Cash Flow Manager.
    expect(_countedBank({ accounts: [line('Savings', 50000, 0, 0, 50000), line('USD Account', 7000, 0, 0, 7000)] }, BANK_LIST, 'SGD', OPTIONS))
      .toMatchObject({ opening: 0, closing: 0, accounts: 0, foreign: 1 });
    const p = build({ bankMonths: [{ accounts: [] }, BANK_SEP] });
    expect(at(p, 'opening', '2026-08')).toBeNull();
    expect(at(p, 'closing', '2026-08')).toBeNull();
    expect(src(p, 'opening', '2026-08')).toBe('');
    expect(at(p, 'out_other', '2026-08')).toBe(0);
    expect(at(p, 'opening', '2026-09')).toBe(3000);
    expect(p.ties.map(t => t.key)).toEqual(['2026-09']);
    expect(p.notes.join(' ')).toMatch(/Bank Summary for Aug 2026 lists no bank accounts, so that month has no balance from it/);
    expect(p.notes.join(' ')).not.toMatch(/could not be read just now, so that month/);
    // This month's own, read with no past month to open it.
    const now = build({ past: 0, bankMonths: [], currentBank: { accounts: [] } });
    expect(at(now, 'opening', '2026-10')).toBeNull();
    expect(now.notes.join(' ')).toMatch(/Bank Summary for Oct 2026 lists no bank accounts, so its opening balance is blank/);
  });

  test('without the bank account list, the balances are blank rather than guessed, and it says why', () => {
    const cm = cmOf({ bank: { available: false, unavailableReason: 'accounts', balance: null, overdraft: 0, accounts: [] }, notes: [
      'Xero\'s list of bank accounts could not be read just now, so which accounts are in base currency and which are switched off here is not known.',
      'Spend and Receive Money dated after today could not be read from Xero just now, so none is included.',
    ] });
    const p = build({ bankAccounts: null, cm });
    for (const m of ['2026-08', '2026-09', '2026-10', '2026-11']) {
      expect([m, at(p, 'opening', m), at(p, 'closing', m)]).toEqual([m, null, null]);
    }
    // The records still say what moved; nothing is unexplained without a
    // balance to set them against. An account switched off by its id is
    // still left out; the others cannot be told apart.
    expect(at(p, 'in_customer', '2026-08')).toBe(4000 + 888 + 777);
    expect(src(p, 'in_other', '2026-08')).toBe('');
    expect(src(p, 'out_other', '2026-08')).toBe('');
    expect(at(p, 'out_other', '2026-09')).toBe(500);
    expect(src(p, 'out_other', '2026-09')).toBe('transfers with accounts left out');
    expect(p.ties).toEqual([]);
    expect(at(p, 'adjustment', '2026-10')).toBeNull();
    const notes = p.notes.join(' ');
    expect(notes).toMatch(/list of bank accounts could not be read just now, so which accounts are in another currency or switched off is not known/);
    expect(notes).toMatch(/For the same reason today's bank balance is not known, so no balance is carried into the months ahead/);
    expect(notes).not.toMatch(/Bank Summary for Aug 2026 could not be read/);
    // Said once, in this view's words; the Cash Flow Manager's other gaps pass through.
    expect(p.notes.filter(x => /list of bank accounts could not be read/.test(x))).toHaveLength(1);
    expect(notes).not.toMatch(/which are switched off here is not known\./);
    expect(notes).toMatch(/Spend and Receive Money dated after today could not be read/);
    // The Cash Flow Manager missed the list where this view read it: its balance is still unknown.
    expect(build({ cm }).notes.join(' ')).toMatch(/Today's bank balance is not known: Xero's list of bank accounts could not be read/);
    expect([..._leftOutIds(null, 'SGD', OPTIONS)]).toEqual(['a-sav']);
    expect([..._leftOutIds(null, 'SGD', { 'name:Old': { included: false } })]).toEqual([]);
  });
});

// ── This month ──────────────────────────────────────────────────────────────

describe('this month: actual to today, then forecast', () => {
  test('opens on last month\'s closing, adds what moved and what is expected, and closes on today\'s balance plus the rest', () => {
    const p = build();
    // 700 received; today's balance (4,000) is 200 less than that explains.
    // Then an invoice of 300 on the 20th and a bill of 100 on the 25th.
    expect(at(p, 'opening', '2026-10')).toBe(3500);
    expect(at(p, 'in_customer', '2026-10')).toBe(1000);
    expect(src(p, 'in_customer', '2026-10')).toBe('payments + open invoices');
    expect(at(p, 'out_other', '2026-10')).toBe(200);
    expect(src(p, 'out_other', '2026-10')).toBe('unexplained');
    expect(at(p, 'out_supplier', '2026-10')).toBe(100);
    expect(src(p, 'out_supplier', '2026-10')).toBe('open bills');
    expect(at(p, 'closing', '2026-10')).toBe(4200);
    expect(at(p, 'opening', '2026-10') + at(p, 'in_total', '2026-10') - at(p, 'out_total', '2026-10')).toBe(4200);
    expect(p.currentMonth).toBe('2026-10');
    expect(p.notes.join(' ')).toMatch(/Oct 2026 is actual to today, 2026-10-14, and forecast for the rest of the month/);
  });

  test('the bank options\' opening adjustment is on its own line, not cash, and this month closes on it as the Cash Flow Manager starts', () => {
    const cm = cmOf();
    cm.bank.accounts[0].openingAdjustment = 250;
    cm.bank.accounts[1].openingAdjustment = 999;   // Savings, switched off: not counted
    const p = build({ cm });
    const r = rowsOf(p);
    expect(p.rows.map(x => x.key).slice(-4)).toEqual(['net', 'adjustment', 'closing', 'overdue']);
    expect(p.rows.find(x => x.key === 'adjustment')).toMatchObject({ label: 'Your bank adjustments', group: 'balance' });
    expect(r.adjustment).toEqual([null, null, 250, null, null, null]);
    expect(src(p, 'adjustment', '2026-10')).toBe('opening adjustment');
    // Not cash in or out.
    expect(at(p, 'in_other', '2026-10')).toBe(0);
    expect(src(p, 'in_other', '2026-10')).toBe('');
    expect(at(p, 'in_total', '2026-10')).toBe(1000);
    expect(at(p, 'net', '2026-10')).toBe(700);
    // Opening, net movement and the adjustments make the closing balance.
    expect(at(p, 'closing', '2026-10')).toBe(4450);
    expect(at(p, 'opening', '2026-10') + at(p, 'net', '2026-10') + at(p, 'adjustment', '2026-10')).toBe(at(p, 'closing', '2026-10'));
    expect(at(p, 'opening', '2026-11')).toBe(4450);
    // The past still ties, untouched.
    expect(p.ties.every(t => t.agrees)).toBe(true);
    expect(p.notes.join(' ')).toMatch(/opening adjustments set in the bank options \(250\.00\) are on their own line, Your bank adjustments, under Oct 2026/);
    // No adjustment set is a nil one; no bank, none known.
    expect(at(build(), 'adjustment', '2026-10')).toBe(0);
    expect(at(build({ cm: cmOf({ bank: { available: false, accounts: [], balance: null, overdraft: 0 } }) }), 'adjustment', '2026-10')).toBeNull();
  });

  test('without the records this month is blank per row, as an unread past month is, and its net movement is the balances\'', () => {
    const cm = cmOf();
    cm.bank.accounts[0].openingAdjustment = 250;
    const p = build({ cm, payments: null, recordsFailure: 'error' });
    for (const key of ['in_customer', 'in_other', 'out_supplier', 'out_other', 'in_total', 'out_total']) {
      expect([key, at(p, key, '2026-10')]).toEqual([key, null]);
    }
    // Today's 4,000, the 250 adjustment and the rest of the month's 300 in
    // and 100 out: closing 4,450, as with the records. Net is closing less
    // the adjustment less the opening.
    expect(at(p, 'opening', '2026-10')).toBe(3500);
    expect(at(p, 'adjustment', '2026-10')).toBe(250);
    expect(at(p, 'closing', '2026-10')).toBe(4450);
    expect(at(p, 'net', '2026-10')).toBe(700);
    expect(src(p, 'net', '2026-10')).toBe('bank + forecast');
    // The months ahead carry on from it, filled as ever.
    expect(at(p, 'opening', '2026-11')).toBe(4450);
    expect(at(p, 'in_customer', '2026-11')).toBe(1000);
    expect(p.notes.join(' ')).toMatch(/Without them cash in and out are blank for Aug 2026 to Oct 2026, .*Oct 2026's includes what is expected for the rest of the month, which shows only in its net movement and closing balance/);
    // With nothing expected in the rest of the month, the net movement is the bank's alone.
    const quiet = build({ payments: null, recordsFailure: 'error', cm: cmOf({ items: ITEMS.filter(i => !/^2026-10/.test(i.date) || i.overdue) }) });
    expect(at(quiet, 'net', '2026-10')).toBe(500);
    expect(src(quiet, 'net', '2026-10')).toBe('bank');
  });

  test('with no past month, this month opens on its own Bank Summary', () => {
    const p = build({ past: 0, bankMonths: [], currentBank: { accounts: [line('Operating', 3500, 900, 400, 4000)] } });
    expect(p.months[0]).toEqual({ key: '2026-10', label: 'Oct 2026', kind: 'current' });
    expect(at(p, 'opening', '2026-10')).toBe(3500);
    expect(at(p, 'closing', '2026-10')).toBe(4200);
  });

  test('with no balance today, nothing is carried ahead, and it says so', () => {
    const p = build({ cm: cmOf({ bank: { available: false, accounts: [], balance: 0, overdraft: 0 } }) });
    expect(at(p, 'closing', '2026-10')).toBeNull();
    expect(at(p, 'opening', '2026-11')).toBeNull();
    expect(at(p, 'closing', '2027-01')).toBeNull();
    expect(at(p, 'in_customer', '2026-11')).toBe(1000);
    expect(p.notes.join(' ')).toMatch(/Today's bank balances could not be read/);
  });
});

// ── The months ahead ────────────────────────────────────────────────────────

describe('the months ahead', () => {
  test('each opens on the month before\'s closing, from the forecast\'s items, excluded ones nowhere', () => {
    const p = build({ fill: 'none', budget: null });
    expect(at(p, 'opening', '2026-11')).toBe(at(p, 'closing', '2026-10'));
    expect(at(p, 'opening', '2026-12')).toBe(at(p, 'closing', '2026-11'));
    expect(at(p, 'opening', '2027-01')).toBe(at(p, 'closing', '2026-12'));
    expect(src(p, 'opening', '2026-11')).toBe('previous closing');
    // The repeating invoice, the GST entry; the excluded 5,000 invoice is in no month.
    expect(at(p, 'in_customer', '2026-11')).toBe(1000);
    expect(src(p, 'in_customer', '2026-11')).toBe('repeating');
    expect(at(p, 'out_tax', '2026-11')).toBe(900);
    expect(src(p, 'out_tax', '2026-11')).toBe('your entries');
    expect(at(p, 'out_wages', '2026-12')).toBe(1500);
    // Cents, not floats: 250.10 and 0.20 are 250.30.
    expect(at(p, 'in_customer', '2026-12')).toBe(250.3);
    expect(at(p, 'closing', '2026-11')).toBe(4200 + 1000 - 900);
    // An item a change sent past the last month shown is in none of them.
    expect(at(p, 'in_customer', '2027-01')).toBe(0);
    expect(p.notes.join(' ')).toMatch(/Nothing is filled in from the budget/);
  });

  test('bank transactions dated ahead go under the rows of the accounts their lines are coded to', () => {
    const tx = (key, over) => item(`banktx:${key}`, { source: 'banktx', direction: 'out', date: '2026-11-10', ...over });
    const cm = cmOf({ items: [
      tx('t1', { amount: 1090, accounts: [{ code: '400', amount: 545 }, { code: '477', amount: 545 }] }),
      tx('t2', { direction: 'in', amount: 2000, accounts: [{ code: '900', amount: 2000 }] }),
      tx('t3', { amount: 700, accounts: [{ code: '820', amount: 300 }, { code: '400', amount: 500 }] }),   // amount changed here
      tx('t4', { amount: 50, accounts: [] }),
      tx('t5', { date: '2026-10-28', amount: 30, accounts: [{ code: '820', amount: 30 }] }),                // later this month
      // Undated in Xero: overdue, placed in no month.
      tx('t6', { date: null, dateBasis: 'none', overdue: true, amount: 40, accounts: [{ code: '400', amount: 40 }] }),
    ] });
    const p = build({ cm, fill: 'none', budget: null });
    expect(at(p, 'out_overheads', '2026-11')).toBe(545 + 700);
    expect(at(p, 'out_wages', '2026-11')).toBe(545);
    expect(at(p, 'in_finance', '2026-11')).toBe(2000);
    expect(at(p, 'out_other', '2026-11')).toBe(50);
    expect(src(p, 'out_wages', '2026-11')).toBe('bank transactions dated ahead');
    expect(at(p, 'out_tax', '2026-10')).toBe(30);
    expect(p.overdue).toEqual({ in: 0, out: 40, count: 1 });
    expect(at(p, 'closing', '2026-11')).toBe(at(p, 'opening', '2026-11') + 2000 - 1090 - 700 - 50);
    expect(p.notes.join(' ')).toMatch(/bank transactions dated ahead \(each line under the row of the account it is coded to\)/);
  });

  test('the overdue items stand apart under this month, in no total', () => {
    const p = build();
    const r = rowsOf(p);
    expect(r.overdue).toEqual([null, null, 420, null, null, null]);
    expect(src(p, 'overdue', '2026-10')).toBe('2 overdue items: 500.00 to come in, 80.00 to go out');
    expect(p.overdue).toEqual({ in: 500, out: 80, count: 2 });
    expect(at(p, 'in_total', '2026-10')).toBe(1000);
  });

  test('from the Cash Flow Manager itself: dates, changes, exclusions, credit notes and quarterly entries as on that tab', () => {
    const inv = (id, over) => ({
      invoiceID: id, type: 'ACCREC', status: 'AUTHORISED', invoiceNumber: id, contact: { contactID: 'c1', name: 'Acme' },
      date: '2026-09-01T00:00:00', dueDate: '2026-10-20T00:00:00', total: 1000, amountDue: 1000, currencyCode: 'SGD', ...over,
    });
    const daily = _buildCashManager({
      todayISO: TODAY, timezone: 'UTC', horizonDays: 120, organisation: { name: 'Org' }, baseCurrency: 'SGD',
      outstanding: _outstandingOf([
        inv('moved'), inv('left', { dueDate: '2026-11-03T00:00:00' }), inv('kept', { dueDate: '2026-11-10T00:00:00', contact: { contactID: 'c2', name: 'Beta' } }),
      ]),
      lateness: {},
      credits: _creditsOf([{ creditNoteID: 'cn1', type: 'ACCRECCREDIT', status: 'AUTHORISED', contact: { contactID: 'c2', name: 'Beta' },
        date: '2026-10-01T00:00:00', remainingCredit: 100, currencyCode: 'SGD' }]),
      bank: { accounts: [line('Operating', 3500, 0, 0, 4000)] }, bankAccounts: BANK_LIST, bankOptions: {},
      templates: [], payments: [], bankTransactions: [],
      entries: [{ id: 'q1', direction: 'out', description: 'GST', amountCents: 30000, date: '2026-07-28', frequency: 'quarterly', endDate: null }],
      overrides: {
        'invoice:moved': { date: '2026-12-05', amountCents: null, excluded: false },
        'invoice:left':  { date: null, amountCents: null, excluded: true },
      },
    });
    const p = build({ cm: { ...daily, notes: [] }, fill: 'none', budget: null, past: 0, future: 3, bankMonths: [], payments: [], bankTransactions: [] });
    expect(at(p, 'in_customer', '2026-10')).toBe(0);          // moved out of October
    expect(at(p, 'in_customer', '2026-11')).toBe(900);        // Beta's, less its credit note; the excluded one nowhere
    expect(at(p, 'in_customer', '2026-12')).toBe(1000);       // moved here
    expect(at(p, 'out_tax', '2026-10')).toBe(300);            // a quarter on from 28 Jul
    expect(at(p, 'out_tax', '2027-01')).toBe(300);
    expect(at(p, 'out_tax', '2026-11')).toBe(0);
    expect(_manualDates({ date: '2026-01-31', frequency: 'quarterly' }, TODAY, '2027-12-31')).toEqual(['2026-10-31', '2027-01-31', '2027-04-30', '2027-07-31', '2027-10-31']);
  });
});

// ── The budget ──────────────────────────────────────────────────────────────

describe('filling the months ahead from the budget', () => {
  test('what the budget expects beyond what is scheduled, never below nothing', () => {
    const p = build();
    // November: the repeating 1,000 already passes the 800 revenue budget, so
    // nothing is added; wages and cost of sales are all budget. The GST
    // entry is no row the budget covers.
    expect(at(p, 'in_customer', '2026-11')).toBe(1000);
    expect(src(p, 'in_customer', '2026-11')).toBe('repeating');
    expect(at(p, 'out_wages', '2026-11')).toBe(1000);
    expect(src(p, 'out_wages', '2026-11')).toBe('budget');
    expect(at(p, 'out_supplier', '2026-11')).toBe(400);
    // December: 250.30 of invoices and 1,749.70 of budget make the 2,000.
    // Going out, the 1,500 bonus already passes the 1,400 the budget expects
    // in all (400 cost of sales and 1,000 wages), so nothing is added.
    expect(at(p, 'in_customer', '2026-12')).toBe(2000);
    expect(src(p, 'in_customer', '2026-12')).toBe('open invoices + budget');
    expect(at(p, 'out_wages', '2026-12')).toBe(1500);
    expect(src(p, 'out_wages', '2026-12')).toBe('your entries');
    expect(at(p, 'out_supplier', '2026-12')).toBe(0);
    // January is budget alone.
    expect([at(p, 'in_customer', '2027-01'), at(p, 'out_wages', '2027-01'), at(p, 'out_supplier', '2027-01')]).toEqual([1500, 1000, 400]);
    // Depreciation moves no cash, other income is not added, GST is not budgeted.
    expect(at(p, 'out_overheads', '2026-11')).toBe(0);
    expect(at(p, 'in_other', '2026-11')).toBe(0);
    expect(at(p, 'out_tax', '2027-01')).toBe(0);
    const notes = p.notes.join(' ');
    expect(notes).toMatch(/Depreciation and amortisation in the budget are left out/);
    expect(notes).toMatch(/GST is not in a budget/);
    expect(notes).toMatch(/Other income in the budget is not added/);
    // The balances carry on through it.
    expect(at(p, 'closing', '2026-11')).toBe(4200 + 1000 - 900 - 1000 - 400);
    expect(at(p, 'closing', '2026-12')).toBe(2900 + 2000 - 1500);
    expect(at(p, 'closing', '2027-01')).toBe(3400 + 1500 - 1000 - 400);
    // The current month is not filled, nor the past.
    expect(src(p, 'out_wages', '2026-10')).toBe('');
    expect(p.notes.join(' ')).toMatch(/a bill already scheduled is not counted again under another row/);
    expect(p.notes.join(' ')).not.toMatch(/count against the cost-of-sales budget only/);
  });

  test('a rent bill already scheduled is not budgeted again as Rent: November goes out 8,200, not 13,200', () => {
    const cm = cmOf({ items: [item('repeating:rent:2026-11-01', { direction: 'out', source: 'repeating', date: '2026-11-01', amount: 5000 })] });
    const budget = { budgetMissing: false, months: [{ key: '2026-11' }], rows: [
      bline('Less Operating Expenses', 'Rent', [5000]),
      bline('Less Operating Expenses', 'Wages and Salaries', [3200]),
    ] };
    const p = build({ cm, budget, future: 1 });
    expect(at(p, 'out_supplier', '2026-11')).toBe(5000);
    expect(src(p, 'out_supplier', '2026-11')).toBe('repeating');
    // The 3,200 the budget expects beyond the bill, shared 5,000 : 3,200 as
    // the budget shares it, the rounding cent on the larger row.
    expect(at(p, 'out_overheads', '2026-11')).toBe(1951.22);
    expect(at(p, 'out_wages', '2026-11')).toBe(1248.78);
    expect(src(p, 'out_overheads', '2026-11')).toBe('budget');
    expect(at(p, 'out_total', '2026-11')).toBe(8200);
    expect(at(p, 'closing', '2026-11')).toBe(at(p, 'opening', '2026-11') - 8200);
    // Scheduled past the budget in all: nothing added.
    const over = build({ cm: cmOf({ items: [item('bill:big', { direction: 'out', source: 'bill', date: '2026-11-03', amount: 9000 })] }), budget, future: 1 });
    expect(at(over, 'out_total', '2026-11')).toBe(9000);
    expect(over.notes.join(' ')).toMatch(/Everything the budget expects is already scheduled/);
  });

  test('a budget with no figures for the months ahead says so, not that all is scheduled', () => {
    const zero = build({ budget: { budgetMissing: false, months: BUDGET.months, rows: [bline('Income', 'Sales', [0, 0, 0]), bline('Less Cost of Sales', 'Purchases', [0, 0, 0])] } });
    const notes = zero.notes.join(' ');
    expect(notes).toMatch(/The Overall Budget in Xero has no figures for the months ahead, so nothing is filled in from it\./);
    expect(notes).not.toMatch(/Everything the budget expects is already scheduled/);
    expect(notes).not.toMatch(/Where the Overall Budget in Xero expects more/);
    expect(_budgetHasFigures(BUDGET, ['2026-11'])).toBe(true);
    expect(_budgetHasFigures(BUDGET, ['2027-05'])).toBe(false);
    // Figures, but none of them cash this fills in.
    const dep = build({ budget: { budgetMissing: false, months: BUDGET.months, rows: [bline('Less Operating Expenses', 'Depreciation', [300, 300, 300])] } });
    expect(dep.notes.join(' ')).toMatch(/Depreciation and amortisation in the budget are left out/);
    expect(dep.notes.join(' ')).toMatch(/Nothing the budget holds for the months ahead is cash this fills in/);
  });

  test('an expense line goes to wages or overheads by the account\'s own type where the chart names it', () => {
    const { byMonth } = _budgetByMonth({ budgetMissing: false, months: [{ key: '2026-11' }], rows: [
      bline('Less Operating Expenses', 'Gross pay', [100]),
      bline('Less Operating Expenses', 'Rent', [50]),
      bline('Less Income Tax', 'Income Tax Expense', [70]),
    ] }, [{ name: 'Gross pay', type: 'WAGESEXPENSE' }]);
    expect(byMonth.get('2026-11')).toEqual({ out_wages: 10000, out_overheads: 5000 });
  });

  test('no budget in Xero: a note, and nothing filled', () => {
    const p = build({ budget: { budgetMissing: true, months: BUDGET.months, rows: [] } });
    expect(at(p, 'out_wages', '2027-01')).toBe(0);
    expect(p.notes.join(' ')).toMatch(/Xero has no Overall Budget for the months ahead/);
  });

  test('a budget that could not be read is said, by why', () => {
    expect(build({ budget: null, budgetFailure: 'scope' }).notes.join(' ')).toMatch(/connection does not allow it/);
    expect(build({ budget: null, budgetFailure: 'error' }).notes.join(' ')).toMatch(/could not be read from Xero just now/);
  });
});

describe('the span asked for', () => {
  test('is held to what is offered, a bad value read as the default', () => {
    expect(_monthlySpan({})).toEqual({ past: 6, future: 6, fill: 'budget' });
    expect(_monthlySpan({ past: 0, future: 12, fill: 'none' })).toEqual({ past: 0, future: 12, fill: 'none' });
    expect(_monthlySpan({ past: 13, future: 0, fill: 'x' })).toEqual({ past: 6, future: 6, fill: 'budget' });
    expect(_monthlySpan({ past: '3', future: '2.5' })).toEqual({ past: 3, future: 6, fill: 'budget' });
  });

  test('the payload is keyed on what the Cash Flow Manager shows, not on how old its oldest read is', () => {
    const a = cmOf({ fetchedAt: 1000 });
    expect(_cmStamp(a)).toBe(_cmStamp(cmOf({ fetchedAt: 9999, cached: false })));
    const changed = [
      cm => { cm.items[0].amount = 301; },
      cm => { cm.items[0].date = '2026-10-21'; },
      cm => { cm.items[0].excluded = true; },
      cm => { cm.items[2].overdue = false; },
      cm => { cm.items.push(item('banktx:new', { source: 'banktx', amount: 5, accounts: [{ code: '400', amount: 5 }] })); },
      cm => { cm.bank.accounts[0].balance = 4001; },
      cm => { cm.bank.accounts[1].included = true; },
      cm => { cm.bank.accounts[0].openingAdjustment = 1; },
      cm => { cm.bank.available = false; },
      cm => { cm.today = '2026-10-15'; },
    ];
    for (const change of changed) {
      const cm = cmOf();
      change(cm);
      expect([String(change), _cmStamp(cm)]).not.toEqual([String(change), _cmStamp(a)]);
    }
  });

  test('a budget read costs its list, and per twelve months one summary and one or two P&Ls', () => {
    const months = [{ startISO: '2026-11-01', endISO: '2026-11-30' }, { startISO: '2026-12-01', endISO: '2026-12-31' }];
    expect(_budgetCalls(months)).toBe(3);
    expect(_budgetCalls(months.slice(0, 1))).toBe(3);
  });
});

// ── Fetching ────────────────────────────────────────────────────────────────

describe('getCashMonthly — Xero calls', () => {
  const U = 'u-cmm';
  let n = 0, T;
  const ORG = { name: 'Org Pte Ltd', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 };
  const cell = value => ({ value });
  const row = (label, values, rowType = 'Row') => ({ rowType, cells: [cell(label), ...values.map(cell)] });
  const bankRows = lines => ({ body: { reports: [{ rows: [
    { rowType: 'Header', cells: ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'].map(cell) },
    { rowType: 'Section', title: '', rows: lines.map(([name, ...v]) => row(name, v)) },
  ] }] } });
  const empty = { body: { reports: [{ rows: [] }] } };
  const budgetReport = { body: { reports: [{ rows: [
    { rowType: 'Header', cells: [cell('')] },
    { rowType: 'Section', title: 'Income', rows: [row('Sales', ['1,000.00', '1,000.00'])] },
    { rowType: 'Section', title: 'Less Operating Expenses', rows: [row('Wages and Salaries', ['200.00', '200.00']), row('Depreciation', ['50.00', '50.00'])] },
    { rowType: 'Section', title: '', rows: [row('Net Profit', ['750.00', '750.00'], 'SummaryRow')] },
  ] }] } };

  beforeEach(() => {
    jest.clearAllMocks();
    reportCache._cache.clear();
    fakeNow();
    T = `t-cmm-${++n}`;
    api.getOrganisations.mockResolvedValue({ body: { organisations: [ORG] } });
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      { invoiceID: 'i1', type: 'ACCREC', status: 'AUTHORISED', invoiceNumber: 'INV-1', contact: { contactID: 'c1', name: 'Acme' },
        date: '2026-10-01T00:00:00', dueDate: '2026-11-05T00:00:00', total: 300, amountDue: 300, currencyCode: 'SGD' },
    ] } });
    api.getCreditNotes.mockResolvedValue({ body: { creditNotes: [] } });
    // Each month's own Bank Summary, and the Cash Flow Manager's window to today.
    api.getReportBankSummary.mockImplementation(async (tenant, from) => {
      if (from === '2026-08-01') return bankRows([['Operating', '1,000.00', '500.00', '(200.00)', '1,300.00']]);
      if (from === '2026-09-01') return bankRows([['Operating', '1,300.00', '1,000.00', '(400.00)', '1,900.00']]);
      return bankRows([['Operating', '1,800.00', '450.00', '(250.00)', '2,000.00']]);
    });
    api.getAccounts.mockResolvedValue({ body: { accounts: [
      { accountID: 'a-op', code: '090', name: 'Operating', type: 'BANK', currencyCode: 'SGD' },
      { accountID: 'a-rent', code: '400', name: 'Rent', type: 'EXPENSE' },
      { accountID: 'a-loan', code: '900', name: 'Bank Loan', type: 'TERMLIAB' },
    ] } });
    api.getRepeatingInvoices.mockResolvedValue({ body: { repeatingInvoices: [] } });
    // One list for both reads; each keeps to its own dates.
    api.getPayments.mockResolvedValue({ body: { payments: [
      pay('p1', 'ACCRECPAYMENT', '2026-08-10', 500),
      pay('p2', 'ACCPAYPAYMENT', '2026-09-05', 300),
      pay('p3', 'ACCRECPAYMENT', '2026-10-03', 250),
    ] } });
    api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: [
      btx('b1', 'SPEND', '2026-09-20', 100, [['400', 100]]),
      btx('b2', 'RECEIVE', '2026-09-25', 600, [['900', 600]]),
    ] } });
    api.getReportProfitAndLoss.mockResolvedValue(empty);
    api.getReportBudgetSummary.mockResolvedValue(budgetReport);
    api.getBudgets.mockResolvedValue({ body: { budgets: [{ budgetID: 'b', type: 'OVERALL', description: 'Overall' }] } });
  });
  afterEach(() => jest.useRealTimers());

  const calls = () => Object.fromEntries(Object.entries(api).filter(([, f]) => f && f.mock)
    .map(([k, f]) => [k, f.mock.calls.length]).filter(([, c]) => c > 0));
  const total = () => Object.values(calls()).reduce((s, c) => s + c, 0);
  const get = (opts = {}, user = U) => getCashMonthly(user, T, { timezone: 'UTC', past: 2, future: 2, ...opts });

  test('the SDK is the mock: nothing here reaches Xero', () => {
    expect(jest.isMockFunction(AccountingApi)).toBe(true);
    expect(jest.isMockFunction(api.getReportBankSummary)).toBe(true);
  });

  test('with the Cash Flow Manager loaded: a Bank Summary a month, the records once, the chart and the budget — and the count says so', async () => {
    await getCashManager(U, T, { timezone: 'UTC' });
    const before = calls();
    const p = await get();
    const after = calls();
    const added = Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] || 0)]).filter(([, c]) => c > 0));
    expect(added).toEqual({
      getReportBankSummary: 2, getPayments: 1, getBankTransactions: 1, getAccounts: 1,
      getBudgets: 1, getReportBudgetSummary: 1, getReportProfitAndLoss: 1,
    });
    expect(p.calls).toBe(8);
    expect(p.cached).toBe(false);
    // Each past month on its own dates; the records from the first of them to today, only reads.
    expect(api.getReportBankSummary.mock.calls.slice(-2).map(c => c.slice(1)).sort()).toEqual([['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30']]);
    const where = 'Date >= DateTime(2026,8,1) && Date < DateTime(2026,10,15) && Status=="AUTHORISED"';
    expect(api.getPayments.mock.calls[1]).toEqual([T, undefined, where, 'Date ASC', 1]);
    expect(api.getBankTransactions.mock.calls[1]).toEqual([T, undefined, where, 'Date ASC', 1]);
    expect(api.getReportBudgetSummary.mock.calls[0].slice(1)).toEqual(['2026-11-30', 2, 1]);
    for (const name of Object.keys(after)) expect(name).toMatch(/^get/);

    // August: 500 from a customer, 200 out unexplained. September: a
    // supplier, rent, a loan and 400 in unexplained. October to today: 250
    // received, today's 2,000 another 150 short of it.
    expect(at(p, 'in_customer', '2026-08')).toBe(500);
    expect(at(p, 'out_other', '2026-08')).toBe(200);
    expect([at(p, 'out_supplier', '2026-09'), at(p, 'out_overheads', '2026-09'), at(p, 'in_finance', '2026-09'), at(p, 'in_other', '2026-09')]).toEqual([300, 100, 600, 400]);
    expect([at(p, 'closing', '2026-08'), at(p, 'closing', '2026-09')]).toEqual([1300, 1900]);
    expect(p.ties.every(t => t.agrees)).toBe(true);
    expect(at(p, 'out_other', '2026-10')).toBe(150);
    // November: the open invoice and 700 of budget; wages from the budget;
    // depreciation left out. December: budget alone.
    expect(at(p, 'in_customer', '2026-11')).toBe(1000);
    expect(src(p, 'in_customer', '2026-11')).toBe('open invoices + budget');
    expect(at(p, 'out_wages', '2026-12')).toBe(200);
    expect(at(p, 'closing', '2026-10')).toBe(2000);
    expect(at(p, 'closing', '2026-12')).toBe(2000 + 1000 - 200 + 1000 - 200);
    expect(p).toMatchObject({ organisation: { name: 'Org Pte Ltd', currency: 'SGD' }, today: TODAY, currentMonth: '2026-10', fill: 'budget' });
    expect(typeof p.fetchedAt).toBe('number');
  });

  test('cold, the Cash Flow Manager\'s own reads come first and are not this view\'s to count', async () => {
    const p = await get();
    expect(p.calls).toBe(8);
    expect(total()).toBeGreaterThan(8);
    expect(api.getRepeatingInvoices).toHaveBeenCalledTimes(1);
  });

  test('again within ten minutes: the whole payload from the cache, no call at all', async () => {
    const first = await get();
    const before = total();
    const again = await get();
    expect(total()).toBe(before);
    expect(again).toMatchObject({ cached: true, calls: 0, fetchedAt: first.fetchedAt });
    expect(again.rows).toEqual(first.rows);
  });

  test('closed months are kept for hours, the last one for minutes, the payload for ten', async () => {
    await get();
    const ttl = key => reportCache._cache.get(key)?.ttl;
    expect(ttl(`cmbanksum:${U}:${T}:2026-08-01:2026-08-31`)).toBe(reportCache.TTL_CLOSED_MS);
    expect(ttl(`cmbanksum:${U}:${T}:2026-09-01:2026-09-30`)).toBe(reportCache.TTL_RECENT_MS);
    const payloadKey = [...reportCache._cache.keys()].find(k => k.startsWith(`cashmonthly:${U}:${T}:`));
    expect(ttl(payloadKey)).toBe(10 * 60 * 1000);
  });

  test('an entry made in the Cash Flow Manager is on the next load at once, and costs no Xero call', async () => {
    const users = require('../utils/users');
    const user  = await users.createUser(`cmm-${Date.now()}@test.com`, 'password123', 'user');
    const first = await get({}, user.id);
    const before = total();
    require('../utils/cash-manager-store').forTenant(user.id, T)
      .addEntry({ direction: 'out', description: 'GST Q3', amount: 900, date: '2026-11-28', frequency: 'quarterly' });
    const next = await get({}, user.id);
    expect(total()).toBe(before);
    expect(at(first, 'out_tax', '2026-11')).toBe(0);
    expect(at(next, 'out_tax', '2026-11')).toBe(900);
  });

  test('a change the Cash Flow Manager reads from Xero is on the next load here, though its oldest read is no newer', async () => {
    const first = await get();
    expect(at(first, 'in_customer', '2026-11')).toBe(1000);
    // Later, the Cash Flow Manager's payments read is read again (its cache
    // ran out) and finds a payment dated ahead; its other reads are as old
    // as they were.
    jest.setSystemTime(new Date(NOW.getTime() + 60 * 1000));
    for (const k of [...reportCache._cache.keys()]) if (k.startsWith(`cmpayments:${U}:${T}:`)) reportCache._cache.delete(k);
    api.getPayments.mockResolvedValue({ body: { payments: [
      pay('p1', 'ACCRECPAYMENT', '2026-08-10', 500),
      pay('p2', 'ACCPAYPAYMENT', '2026-09-05', 300),
      pay('p3', 'ACCRECPAYMENT', '2026-10-03', 250),
      pay('p4', 'ACCRECPAYMENT', '2026-11-20', 777),
    ] } });
    const next = await get();
    expect(next.cached).toBe(false);
    // The open invoice's 300 and the payment's 777 now pass the 1,000 budget.
    expect(at(next, 'in_customer', '2026-11')).toBe(300 + 777);
    expect(src(next, 'in_customer', '2026-11')).toMatch(/payments dated ahead/);
  });

  test('without the bank account list the payload says why, and is not kept', async () => {
    api.getAccounts.mockImplementation(async (tenant, since, where) => {
      if (where === 'Type=="BANK"') throw new Error('rate limited');
      return { body: { accounts: [{ accountID: 'a-rent', code: '400', name: 'Rent', type: 'EXPENSE' }] } };
    });
    const p = await get();
    expect(at(p, 'opening', '2026-08')).toBeNull();
    expect(at(p, 'closing', '2026-09')).toBeNull();
    expect(p.notes.join(' ')).toMatch(/list of bank accounts could not be read just now/);
    expect([...reportCache._cache.keys()].some(k => k.startsWith(`cashmonthly:${U}:${T}:`))).toBe(false);
  });

  test('a Refresh reads past the caches', async () => {
    await get();
    jest.setSystemTime(new Date(NOW.getTime() + 60 * 1000));
    const before = calls().getReportBankSummary;
    const p = await get({ force: true });
    expect(calls().getReportBankSummary - before).toBe(3);   // two months and the balance today
    expect(p.calls).toBeGreaterThan(0);
  });

  test('fill=none asks Xero for no budget; past=0 reads this month\'s own Bank Summary instead of a past month\'s', async () => {
    const p = await get({ past: 0, fill: 'none' });
    expect(api.getBudgets).not.toHaveBeenCalled();
    expect(api.getReportBudgetSummary).not.toHaveBeenCalled();
    expect(api.getReportBankSummary.mock.calls.map(c => c.slice(1))).toContainEqual(['2026-10-01', TODAY]);
    expect(p.months.map(m => m.kind)).toEqual(['current', 'forecast', 'forecast']);
    expect(at(p, 'opening', '2026-10')).toBe(1800);
  });

  test('a failed read costs what it adds and is asked for again next time; the payload is not kept', async () => {
    await getCashManager(U, T, { timezone: 'UTC' });
    api.getBankTransactions.mockRejectedValueOnce(new Error('rate limited'));
    const p = await get();
    expect(at(p, 'in_customer', '2026-08')).toBeNull();
    expect(at(p, 'closing', '2026-08')).toBe(1300);
    expect(p.notes.join(' ')).toMatch(/could not be read from Xero just now/);
    const again = await get();
    expect(at(again, 'in_customer', '2026-08')).toBe(500);
  });
});
