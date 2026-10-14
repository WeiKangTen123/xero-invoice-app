// The Trial Balance and what is built from it: Xero's report read into
// balances per account, those balances laid out as a balance sheet by
// account type, the gate that sets that construction against Xero's own
// Balance Sheet before any exact date is offered, and the exact-date sheet.
//
// Everything is mocked. No test in this file reaches Xero, and the first
// thing it checks is that the SDK in use is the mock. The mock is one
// consistent "Xero": the Trial Balance and the Balance Sheet are both built
// from the same balances, so agreement is the expected case, and a
// disagreement is made by bending one answer.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:      jest.fn(),
    getReportBalanceSheet: jest.fn(),
    getReportTrialBalance: jest.fn(),
    getAccounts:           jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));

const { AccountingApi, __api: api } = require('xero-node');
const {
  getTrialBalance, getTrialBalanceSheet, _parseTrialBalance, _sheetFromTrialBalances, _exactColumnDates, _compareSheets,
  MAX_EXACT_PERIODS,
} = require('./trial-balance');
const { getBalanceSheet, getExactDates, _buildBalanceSheet, GATE_TTL_MS } = require('./balance-sheet');
const { _cache, FORCE_GRACE_MS } = require('./report-cache');

const U = 'u1', T = 't-tb';
const ORG = { name: 'Flovon Pte Ltd', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 };

// ── The chart of accounts ───────────────────────────────────────────────────
// In Xero's order (Code ASC), with the types the sheet places them by.
const CHART = [
  { id: 'acc-dbs',   code: '090', name: 'DBS Current Account', type: 'BANK' },
  { id: 'acc-petty', code: '091', name: 'Petty Cash',          type: 'BANK' },
  { id: 'acc-sales', code: '200', name: 'Sales',               type: 'REVENUE' },
  { id: 'acc-rent',  code: '400', name: 'Rent',                type: 'OVERHEADS' },
  { id: 'acc-wages', code: '477', name: 'Wages and Salaries',  type: 'WAGESEXPENSE' },
  { id: 'acc-ar',    code: '610', name: 'Accounts Receivable', type: 'CURRENT' },
  { id: 'acc-pre',   code: '620', name: 'Prepayments',         type: 'PREPAYMENT' },
  { id: 'acc-oe',    code: '710', name: 'Office Equipment',    type: 'FIXED' },
  { id: 'acc-dep',   code: '711', name: 'Less Accumulated Depreciation on Office Equipment', type: 'FIXED' },
  { id: 'acc-ap',    code: '800', name: 'Accounts Payable',    type: 'CURRLIAB' },
  { id: 'acc-gst',   code: '820', name: 'GST',                 type: 'CURRLIAB' },
  { id: 'acc-loan',  code: '900', name: 'Loan',                type: 'TERMLIAB' },
  { id: 'acc-re',    code: '960', name: 'Retained Earnings',   type: 'EQUITY' },
  { id: 'acc-sc',    code: '970', name: 'Share Capital',       type: 'EQUITY' },
];
const byId = Object.fromEntries(CHART.map(a => [a.id, a]));
const chartAnswer = () => ({ body: { accounts: CHART.map(a => ({ accountID: a.id, code: a.code, name: a.name, type: a.type })) } });
const chartList = CHART.map(a => ({ accountId: a.id, code: a.code, name: a.name, type: a.type }));

// The balances at 30 Sep 2026, signed as the Balance Sheet prints them:
// assets debit-positive, liabilities and equity credit-positive; revenue
// credit-positive and expenses debit-positive for the year to date. Current
// Year Earnings is 60,000 − 24,000 − 20,600 = 15,400.
const SEP = {
  'acc-dbs': 52000, 'acc-petty': 500, 'acc-ar': 18250, 'acc-pre': 1200, 'acc-oe': 9000, 'acc-dep': -3000,
  'acc-ap': 7400, 'acc-gst': 2150, 'acc-loan': 20000, 'acc-re': 23000, 'acc-sc': 10000,
  'acc-sales': 60000, 'acc-rent': 24000, 'acc-wages': 20600,
};
const CYE = b => b['acc-sales'] - b['acc-rent'] - b['acc-wages'];
// Another day's balances: more cash, from more sales, so the books still
// balance and the day is recognisable in every figure.
const later = (b, extra) => ({ ...b, 'acc-dbs': b['acc-dbs'] + extra, 'acc-sales': b['acc-sales'] + extra });
const BAL = {
  '2026-09-30': SEP,
  '2026-10-11': later(SEP, 1111.11),
  '2026-09-11': later(SEP, -2000),
  '2026-08-11': later(SEP, -4000.5),
};

// ── Xero's shapes ───────────────────────────────────────────────────────────
const money   = v => { const s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return v < 0 ? `(${s})` : s; };
const cell    = (value, accountId) => (accountId ? { value, attributes: [{ id: 'account', value: accountId }] } : { value });
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const answer  = rows => ({ body: { reports: [{ rows }] } });

const DEBIT_NORMAL = new Set(['BANK', 'CURRENT', 'PREPAYMENT', 'FIXED', 'OVERHEADS', 'WAGESEXPENSE']);
const TB_SECTION = { BANK: 'Assets', CURRENT: 'Assets', PREPAYMENT: 'Assets', FIXED: 'Assets', CURRLIAB: 'Liabilities', TERMLIAB: 'Liabilities', EQUITY: 'Equity', REVENUE: 'Revenue', OVERHEADS: 'Expenses', WAGESEXPENSE: 'Expenses' };

// One Trial Balance row as Xero writes it: "Name (Code)" with the AccountID
// on every cell, the month's movement in Debit or Credit, and the balance in
// YTD Debit or YTD Credit, the other cell of each pair empty. Plain numbers,
// as in Xero's own example.
function tbRow(a, balance) {
  const debitSide = DEBIT_NORMAL.has(a.type) ? balance >= 0 : balance < 0;
  const v = Math.abs(balance).toFixed(2);
  return { rowType: 'Row', cells: [`${a.name} (${a.code})`, debitSide ? '0.00' : '', debitSide ? '' : '0.00', debitSide ? v : '', debitSide ? '' : v].map(x => cell(x, a.id)) };
}
// The whole report: the Header, a Section per class in Xero's order, and the
// untitled section with the Total.
function tbRows(bal = SEP, { header = ['Account', 'Debit', 'Credit', 'YTD Debit', 'YTD Credit'], bend = {} } = {}) {
  const rows = [{ rowType: 'Header', cells: header.map(h => cell(h)) }];
  for (const title of ['Revenue', 'Expenses', 'Assets', 'Liabilities', 'Equity']) {
    rows.push(section(title, CHART.filter(a => TB_SECTION[a.type] === title && a.id in bal).map(a => tbRow(a, bend[a.id] ?? bal[a.id]))));
  }
  rows.push(section('', [{ rowType: 'SummaryRow', cells: ['Total', '0.00', '0.00', '125550.00', '125550.00'].map(v => cell(v)) }]));
  return rows;
}

// Xero's Balance Sheet for the same balances, in its standard layout (see
// balance-sheet.test.js): a flat list of sections, totals in untitled ones.
function bsRows(b = SEP, { bend = {} } = {}) {
  const r = (label, v, { id, type = 'Row' } = {}) => ({ rowType: type, cells: [cell(label, id), cell(money(bend[label] ?? v), id)] });
  const acct = id => r(byId[id].name, b[id], { id });
  const sum = ids => ids.reduce((s, id) => s + b[id], 0);
  const bank = ['acc-dbs', 'acc-petty'], ca = ['acc-ar', 'acc-pre'], fa = ['acc-oe', 'acc-dep'], cl = ['acc-ap', 'acc-gst'], ncl = ['acc-loan'];
  const ta = sum([...bank, ...ca, ...fa]), tl = sum([...cl, ...ncl]);
  return [
    { rowType: 'Header', cells: [cell(''), cell('30 Sep 2026'), cell('30 Sep 2025')] },
    section('Assets', []),
    section('Bank', [...bank.map(acct), r('Total Bank', sum(bank), { type: 'SummaryRow' })]),
    section('Current Assets', [...ca.map(acct), r('Total Current Assets', sum(ca), { type: 'SummaryRow' })]),
    section('Fixed Assets', [...fa.map(acct), r('Total Fixed Assets', sum(fa), { type: 'SummaryRow' })]),
    section('', [r('Total Assets', ta, { type: 'SummaryRow' })]),
    section('Liabilities', []),
    section('Current Liabilities', [...cl.map(acct), r('Total Current Liabilities', sum(cl), { type: 'SummaryRow' })]),
    section('Non-current Liabilities', [...ncl.map(acct), r('Total Non-current Liabilities', sum(ncl), { type: 'SummaryRow' })]),
    section('', [r('Total Liabilities', tl, { type: 'SummaryRow' })]),
    section('', [r('Net Assets', ta - tl)]),
    section('Equity', [r('Current Year Earnings', CYE(b)), acct('acc-re'), acct('acc-sc'),
      r('Total Equity', CYE(b) + b['acc-re'] + b['acc-sc'], { type: 'SummaryRow' })]),
  ];
}

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
const NOW = '2026-10-11T02:00:00Z';
const at  = iso => jest.setSystemTime(new Date(iso));
// A Trial Balance off from the Balance Sheet on two accounts: the receivable
// by 12.50 and the prepayments by 0.50.
const BEND = { 'acc-ar': 18262.5, 'acc-pre': 1200.5 };
const scopeError = () => new Error(JSON.stringify({ response: { statusCode: 403 }, body: { Detail: 'AuthorizationUnsuccessful' } }));
const tbCalls = () => api.getReportTrialBalance.mock.calls;

beforeAll(() => {
  // The guard every call below relies on: the SDK in use is the mock above, so
  // a call can only ever land on these jest.fn()s.
  expect(jest.isMockFunction(AccountingApi)).toBe(true);
  expect(new AccountingApi()).toBe(api);
});

beforeEach(() => {
  for (const fn of Object.values(api)) if (jest.isMockFunction(fn)) fn.mockReset();
  _cache.clear();
  jest.useFakeTimers({ now: new Date(NOW), doNotFake: REAL_TIMERS });
  api.getOrganisations.mockResolvedValue({ body: { organisations: [ORG] } });
  api.getAccounts.mockResolvedValue(chartAnswer());
  api.getReportTrialBalance.mockImplementation(async (_t, date) => answer(tbRows(BAL[date])));
  api.getReportBalanceSheet.mockImplementation(async (_t, date) => answer(bsRows(BAL[date])));
});
afterEach(() => jest.useRealTimers());

describe('reading the Trial Balance', () => {
  test('each account row becomes its balance, named without the code, with the Total left out', () => {
    const { accounts } = _parseTrialBalance(tbRows());
    expect(accounts).toHaveLength(CHART.length);
    expect(accounts.find(a => a.accountId === 'acc-ar')).toEqual({
      accountId: 'acc-ar', label: 'Accounts Receivable', code: '610', section: 'Assets',
      debit: 0, credit: 0, ytdDebit: 18250, ytdCredit: 0, balance: 18250,
    });
    // Assets are debit-positive, so a contra asset with a credit balance is negative…
    expect(accounts.find(a => a.accountId === 'acc-dep')).toMatchObject({ ytdDebit: 0, ytdCredit: 3000, balance: -3000 });
    // …and liabilities, equity and revenue credit-positive.
    expect(accounts.find(a => a.accountId === 'acc-ap')).toMatchObject({ section: 'Liabilities', ytdCredit: 7400, balance: 7400 });
    expect(accounts.find(a => a.accountId === 'acc-re')).toMatchObject({ section: 'Equity', balance: 23000 });
    expect(accounts.find(a => a.accountId === 'acc-sales')).toMatchObject({ section: 'Revenue', label: 'Sales', code: '200', balance: 60000 });
    expect(accounts.some(a => a.label === 'Total')).toBe(false);
  });

  test('the columns are found by their names, not their positions', () => {
    const rows = tbRows();
    // The same report with the YTD pair first: every row's cells moved too.
    const swap = r => (r.cells ? { ...r, cells: [r.cells[0], r.cells[3], r.cells[4], r.cells[1], r.cells[2]] } : r);
    const moved = rows.map(r => (r.rowType === 'Section' ? { ...r, rows: r.rows.map(swap) } : swap(r)));
    expect(moved[0].cells.map(c => c.value)).toEqual(['Account', 'YTD Debit', 'YTD Credit', 'Debit', 'Credit']);
    expect(_parseTrialBalance(moved).accounts.find(a => a.accountId === 'acc-ar').ytdDebit).toBe(18250);
  });

  test('Xero\'s money format is read, and an empty cell is nil', () => {
    const rows = tbRows();
    const ar = rows.find(r => r.title === 'Assets').rows.find(r => r.cells[0].attributes[0].value === 'acc-ar');
    ar.cells[3].value = '1,234.50';
    ar.cells[4].value = '';
    expect(_parseTrialBalance(rows).accounts.find(a => a.accountId === 'acc-ar')).toMatchObject({ ytdDebit: 1234.5, ytdCredit: 0, balance: 1234.5 });
  });

  test('without the YTD columns there is no balance to read, and that is an error, not a nil sheet', () => {
    expect(() => _parseTrialBalance(tbRows(SEP, { header: ['Account', 'Debit', 'Credit'] }))).toThrow(/without its YTD Debit and YTD Credit columns/);
    // No Header row at all: Xero's documented positions.
    const noHeader = tbRows().slice(1);
    expect(_parseTrialBalance(noHeader).accounts.find(a => a.accountId === 'acc-ar').ytdDebit).toBe(18250);
    expect(_parseTrialBalance([]).accounts).toEqual([]);
  });
});

describe('the sheet built from it', () => {
  const built = () => _sheetFromTrialBalances([_parseTrialBalance(tbRows())], { columns: ['2026-09-30'], chart: chartList });

  test('balance-sheet accounts are grouped by account type, in chart order, with Xero\'s headings and totals', () => {
    const s = built();
    expect(s.columns).toEqual([{ iso: '2026-09-30', label: '30 Sep 2026' }]);
    expect(s.groups.map(g => [g.key, g.title, g.subgroups.map(x => x.title)])).toEqual([
      ['assets',      'Assets',      ['Bank', 'Current Assets', 'Fixed Assets']],
      ['liabilities', 'Liabilities', ['Current Liabilities', 'Non-current Liabilities']],
      ['equity',      'Equity',      ['Equity']],
    ]);
    expect(s.groups[0].subgroups[0]).toEqual({
      title: 'Bank',
      rows: [
        { label: 'DBS Current Account', accountId: 'acc-dbs',   code: '090', values: [52000] },
        { label: 'Petty Cash',          accountId: 'acc-petty', code: '091', values: [500] },
      ],
      total: { label: 'Total Bank', values: [52500] },
    });
    expect(s.groups[0].subgroups[2].rows.map(r => r.values[0])).toEqual([9000, -3000]);
    expect(s.groups[0].total).toEqual({ label: 'Total Assets', values: [77950] });
    expect(s.groups[1].total).toEqual({ label: 'Total Liabilities', values: [29550] });
    expect(s.netAssets).toEqual({ label: 'Net Assets', values: [48400] });
    expect(s.notes).toEqual([]);
  });

  test('every account type is placed where Xero\'s standard layout puts it', () => {
    const types = { BANK: 'Bank', CURRENT: 'Current Assets', INVENTORY: 'Current Assets', PREPAYMENT: 'Current Assets', FIXED: 'Fixed Assets',
      NONCURRENT: 'Non-current Assets', CURRLIAB: 'Current Liabilities', LIABILITY: 'Current Liabilities', TERMLIAB: 'Non-current Liabilities', EQUITY: 'Equity' };
    const chart = Object.keys(types).map((type, i) => ({ accountId: `x${i}`, code: String(i), name: type, type }));
    const tb = { accounts: chart.map(a => ({ accountId: a.accountId, label: a.name, section: '', ytdDebit: 0, ytdCredit: 1 })) };
    const s = _sheetFromTrialBalances([tb], { columns: ['2026-09-30'], chart });
    const placed = {};
    for (const g of s.groups) for (const sg of g.subgroups) for (const r of sg.rows) if (r.accountId) placed[r.label] = sg.title;
    expect(placed).toEqual(types);
  });

  test('Current Year Earnings is the year\'s revenue less its expenses, first under Equity', () => {
    const equity = built().groups[2].subgroups[0];
    expect(equity.rows.map(r => [r.label, r.accountId, r.code, r.values[0]])).toEqual([
      ['Current Year Earnings', null, null, 15400], ['Retained Earnings', 'acc-re', '960', 23000], ['Share Capital', 'acc-sc', '970', 10000],
    ]);
    expect(equity.total).toEqual({ label: 'Total Equity', values: [48400] });
    expect(built().groups[2].total).toBeNull();
    // A loss: expenses over revenue.
    const loss = { ...SEP, 'acc-sales': 10000, 'acc-dbs': SEP['acc-dbs'] - 50000 };
    const s = _sheetFromTrialBalances([_parseTrialBalance(tbRows(loss))], { columns: ['2026-09-30'], chart: chartList });
    expect(s.groups[2].subgroups[0].rows[0].values).toEqual([-34600]);
  });

  test('totals are summed in cents, so float noise cannot creep into them', () => {
    const tb = { accounts: [
      { accountId: 'acc-dbs', label: 'DBS', section: 'Assets', ytdDebit: 0.1, ytdCredit: 0 },
      { accountId: 'acc-petty', label: 'Petty', section: 'Assets', ytdDebit: 0.2, ytdCredit: 0 },
    ] };
    const s = _sheetFromTrialBalances([tb], { columns: ['2026-09-30'], chart: chartList });
    expect(s.groups[0].subgroups[0].total.values).toEqual([0.3]);
    expect(s.netAssets.values).toEqual([0.3]);
  });

  test('an account the chart does not know is placed by its Trial Balance section, and said so', () => {
    const tb = { accounts: [
      { accountId: 'new-1', label: 'Bond Deposit', section: 'Assets', ytdDebit: 800, ytdCredit: 0 },
      { accountId: 'new-2', label: 'Accrued Interest', section: 'Liabilities', ytdDebit: 0, ytdCredit: 40 },
      { accountId: 'new-3', label: 'Consulting', section: 'Revenue', ytdDebit: 0, ytdCredit: 300 },
      { accountId: 'new-4', label: 'Odd line', section: 'Memo', ytdDebit: 5, ytdCredit: 0 },
    ] };
    const s = _sheetFromTrialBalances([tb], { columns: ['2026-09-30'], chart: chartList });
    expect(s.groups[0].subgroups[0]).toMatchObject({ title: 'Current Assets', rows: [{ label: 'Bond Deposit', values: [800] }] });
    expect(s.groups[1].subgroups[0]).toMatchObject({ title: 'Current Liabilities', rows: [{ label: 'Accrued Interest', values: [40] }] });
    expect(s.groups[2].subgroups[0].rows[0]).toMatchObject({ label: 'Current Year Earnings', values: [300] });
    expect(s.notes).toEqual([
      expect.stringMatching(/^Bond Deposit has no account type in the chart of accounts.*shown under Current Assets/),
      expect.stringMatching(/^Accrued Interest has no account type.*shown under Current Liabilities/),
      expect.stringMatching(/lists Odd line under "Memo".*left out of the sheet/),
    ]);
  });

  test('several dates: one column each, an account missing from one is nil there', () => {
    const oct = _parseTrialBalance(tbRows(BAL['2026-10-11']));
    const { 'acc-petty': _petty, ...noPetty } = SEP;
    const sep = _parseTrialBalance(tbRows(noPetty));
    const s = _sheetFromTrialBalances([oct, sep], { columns: ['2026-10-11', '2026-09-30'], chart: chartList });
    expect(s.columns.map(c => c.label)).toEqual(['11 Oct 2026', '30 Sep 2026']);
    expect(s.groups[0].subgroups[0].rows.map(r => [r.label, r.values])).toEqual([
      ['DBS Current Account', [53111.11, 52000]], ['Petty Cash', [500, 0]],
    ]);
    expect(s.groups[2].subgroups[0].rows[0].values).toEqual([16511.11, 15400]);
  });
});

describe('the exact-date columns', () => {
  test('the same day in earlier months, quarters or years, clamped to each month\'s length', () => {
    expect(_exactColumnDates('2026-10-14', 2, 'MONTH')).toEqual(['2026-10-14', '2026-09-14', '2026-08-14']);
    expect(_exactColumnDates('2026-03-31', 2, 'MONTH')).toEqual(['2026-03-31', '2026-02-28', '2026-01-31']);
    expect(_exactColumnDates('2026-05-31', 1, 'QUARTER')).toEqual(['2026-05-31', '2026-02-28']);
    expect(_exactColumnDates('2024-02-29', 2, 'YEAR')).toEqual(['2024-02-29', '2023-02-28', '2022-02-28']);
    expect(_exactColumnDates('2026-01-15', 1, 'MONTH')).toEqual(['2026-01-15', '2025-12-15']);
    expect(_exactColumnDates('2026-10-14')).toEqual(['2026-10-14']);
  });

  test('at most four earlier dates, each its own Trial Balance call', () => {
    expect(MAX_EXACT_PERIODS).toBe(4);
    expect(_exactColumnDates('2026-10-14', 9, 'MONTH')).toHaveLength(5);
  });
});

describe('comparing two sheets', () => {
  const tbSheet = () => _sheetFromTrialBalances([_parseTrialBalance(tbRows())], { columns: ['2026-09-30'], chart: chartList });
  const bsSheet = (opts) => _buildBalanceSheet(bsRows(SEP, opts), { columns: ['2026-09-30'] });

  test('agree on every account, every group total, Net Assets and the subtotals both name', () => {
    const cmp = _compareSheets(tbSheet(), bsSheet());
    // 11 accounts and Current Year Earnings, 3 group totals, Net Assets, 5 subtotals.
    expect(cmp).toEqual({ lines: 21, matched: 21, differences: [] });
  });

  test('a line that differs is named with both figures, and the totals it moves differ too', () => {
    const cmp = _compareSheets(tbSheet(), bsSheet({ bend: { 'Accounts Receivable': 18262.5, 'Total Current Assets': 19462.5, 'Total Assets': 77962.5, 'Net Assets': 48412.5 } }));
    expect(cmp.differences).toEqual([
      { label: 'Accounts Receivable',  column: '30 Sep 2026', app: 18250, xero: 18262.5, diff: -12.5, kind: 'account' },
      { label: 'Total Assets',         column: '30 Sep 2026', app: 77950, xero: 77962.5, diff: -12.5, kind: 'total' },
      { label: 'Net Assets',           column: '30 Sep 2026', app: 48400, xero: 48412.5, diff: -12.5, kind: 'total' },
      { label: 'Total Current Assets', column: '30 Sep 2026', app: 19450, xero: 19462.5, diff: -12.5, kind: 'total' },
    ]);
  });

  test('an account in one sheet only is set against nil', () => {
    const tb = tbSheet();
    tb.groups[0].subgroups[0].rows.push({ label: 'Savings', accountId: 'acc-sav', code: '092', values: [10] });
    const cmp = _compareSheets(tb, bsSheet());
    expect(cmp.differences[0]).toEqual({ label: 'Savings', column: '30 Sep 2026', app: 10, xero: 0, diff: 10, kind: 'account' });
  });
});

describe('fetching the Trial Balance', () => {
  test('one call with the date, and paymentsOnly only on the cash basis', async () => {
    await getTrialBalance(U, T, { date: '2026-09-30' });
    await getTrialBalance(U, T, { date: '2026-09-30', basis: 'cash' });
    expect(tbCalls()).toEqual([[T, '2026-09-30', undefined], [T, '2026-09-30', true]]);
  });

  test('is cached by user, organisation, date and basis; force past the grace window asks again', async () => {
    const first = await getTrialBalance(U, T, { date: '2026-09-30' });
    const again = await getTrialBalance(U, T, { date: '2026-09-30' });
    expect([first.cached, again.cached]).toEqual([false, true]);
    expect(tbCalls()).toHaveLength(1);
    expect([..._cache.keys()].filter(k => k.startsWith('trialbal:'))).toEqual([`trialbal:${U}:${T}:2026-09-30:accrual`]);
    at(new Date(new Date(NOW).getTime() + FORCE_GRACE_MS + 1000).toISOString());
    expect((await getTrialBalance(U, T, { date: '2026-09-30', force: true })).cached).toBe(false);
    expect(tbCalls()).toHaveLength(2);
  });

  test('a sheet of several dates makes one call per date and says how many went to Xero', async () => {
    await getTrialBalance(U, T, { date: '2026-09-30' });
    const s = await getTrialBalanceSheet(U, T, { dates: ['2026-10-11', '2026-09-30'] });
    expect(tbCalls().map(c => c[1])).toEqual(['2026-09-30', '2026-10-11']);
    expect(s.calls).toBe(1);
    expect(s.cached).toBe(false);
    expect(s.columns.map(c => c.iso)).toEqual(['2026-10-11', '2026-09-30']);
  });
});

describe('the gate before exact dates are offered', () => {
  test('a month-end sheet carries it: the Trial Balance at the last month end agrees with the Balance Sheet', async () => {
    const out = await getBalanceSheet(U, T, { timezone: 'UTC' });
    expect(out.asAt.source).toBe('balance-sheet');
    expect(out.exactDates).toMatchObject({
      ok: true, reason: 'ok', at: '2026-09-30', atLabel: '30 Sep 2026', basis: 'accrual', lines: 21, matched: 21, differences: [], message: '',
    });
    // One Trial Balance call; the Balance Sheet on screen is the one compared with.
    expect(tbCalls()).toEqual([[T, '2026-09-30', undefined]]);
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(1);
  });

  test('a sheet for another month end asks for the last month end\'s Balance Sheet too, once', async () => {
    const out = await getBalanceSheet(U, T, { timezone: 'UTC', preset: 'last-fy-end' });
    expect(out.exactDates.ok).toBe(true);
    expect(api.getReportBalanceSheet.mock.calls.map(c => c[1])).toEqual(['2025-12-31', '2026-09-30']);
    await getBalanceSheet(U, T, { timezone: 'UTC', preset: 'last-quarter-end' });
    expect(tbCalls()).toHaveLength(1);
  });

  test('a mismatch is kept with the differences, accounts first and largest first, and worded with the worst account', async () => {
    api.getReportTrialBalance.mockImplementation(async () => answer(tbRows(SEP, { bend: BEND })));
    const out = await getBalanceSheet(U, T, { timezone: 'UTC' });
    expect(out.exactDates).toMatchObject({ ok: false, reason: 'mismatch', at: '2026-09-30' });
    expect(out.exactDates.differences.map(d => [d.label, d.diff, d.kind])).toEqual([
      ['Accounts Receivable', 12.5, 'account'], ['Prepayments', 0.5, 'account'],
      ['Total Assets', 13, 'total'], ['Net Assets', 13, 'total'], ['Total Current Assets', 13, 'total'],
    ]);
    expect(out.exactDates.differences[0]).toEqual({ label: 'Accounts Receivable', column: '30 Sep 2026', app: 18262.5, xero: 18250, diff: 12.5, kind: 'account' });
    expect(out.exactDates.message).toBe("Exact dates unavailable: Xero's Trial Balance does not reconcile with its Balance Sheet (difference SGD 12.50 on Accounts Receivable)");
    // The month-end sheet itself is untouched.
    expect(out.groups[0].subgroups[1].rows[0].values).toEqual([18250]);
  });

  test('a connection without the Trial Balance scope leaves the month end whole and says to reconnect', async () => {
    api.getReportTrialBalance.mockRejectedValue(scopeError());
    const out = await getBalanceSheet(U, T, { timezone: 'UTC' });
    expect(out.groups.map(g => g.key)).toEqual(['assets', 'liabilities', 'equity']);
    expect(out.exactDates).toMatchObject({ ok: false, reason: 'scope', message: 'Exact dates unavailable: Reconnect Xero in Setup with Balance Sheet ticked.' });
  });

  test('a pass is kept six hours under its own key; a failure is asked again on a Refresh', async () => {
    await getExactDates(U, T, { timezone: 'UTC' });
    expect([..._cache.keys()].filter(k => k.startsWith('balgate:'))).toEqual([`balgate:${U}:${T}:2026-09-30:accrual`]);
    expect(_cache.get(`balgate:${U}:${T}:2026-09-30:accrual`).ttl).toBe(GATE_TTL_MS);
    expect((await getExactDates(U, T, { timezone: 'UTC', force: true })).cached).toBe(true);

    _cache.clear();
    api.getReportTrialBalance.mockRejectedValueOnce(scopeError());
    expect((await getExactDates(U, T, { timezone: 'UTC' })).reason).toBe('scope');
    expect((await getExactDates(U, T, { timezone: 'UTC' })).reason).toBe('scope');   // kept, not asked again
    expect(tbCalls()).toHaveLength(2);
    at(new Date(new Date(NOW).getTime() + FORCE_GRACE_MS + 1000).toISOString());
    expect((await getExactDates(U, T, { timezone: 'UTC', force: true })).ok).toBe(true);
  });
});

describe('a sheet as at an exact date', () => {
  test('today: built from the Trial Balance for today, after the gate passed', async () => {
    const out = await getBalanceSheet(U, T, { timezone: 'UTC', preset: 'today' });
    expect(out.asAt).toEqual({ iso: '2026-10-11', label: '11 October 2026', preset: 'today', inProgress: true, source: 'trial-balance' });
    expect(out.columns).toEqual([{ iso: '2026-10-11', label: '11 Oct 2026' }]);
    expect(out.groups[0].subgroups[0].rows[0].values).toEqual([53111.11]);
    expect(out.netAssets.values).toEqual([49511.11]);
    expect(out.exactDates.ok).toBe(true);
    expect(out.compare).toEqual({ type: 'none', periods: 0 });
    expect(tbCalls().map(c => c[1]).sort()).toEqual(['2026-09-30', '2026-10-11']);
  });

  test('a date with comparisons: the same day in earlier months, a Trial Balance each', async () => {
    const out = await getBalanceSheet(U, T, { timezone: 'UTC', preset: 'date', date: '2026-10-11', compare: 'month', periods: 2, basis: 'accrual' });
    expect(out.columns.map(c => c.iso)).toEqual(['2026-10-11', '2026-09-11', '2026-08-11']);
    expect(out.groups[0].subgroups[0].rows[0].values).toEqual([53111.11, 50000, 47999.5]);
    expect(out.compare).toEqual({ type: 'month', periods: 2 });
    expect(out.asAt).toMatchObject({ preset: 'date', inProgress: true, source: 'trial-balance' });
  });

  test('refused while the gate does not pass: a mismatch is a 400 in its own words, a missing scope a 403', async () => {
    api.getReportTrialBalance.mockImplementation(async (_t, date) => answer(tbRows(BAL[date], { bend: BEND })));
    await expect(getBalanceSheet(U, T, { timezone: 'UTC', preset: 'today' }))
      .rejects.toMatchObject({ name: 'PeriodError', status: 400, message: expect.stringMatching(/does not reconcile.*SGD 12\.50 on Accounts Receivable/) });
    _cache.clear();
    api.getReportTrialBalance.mockRejectedValue(scopeError());
    const err = await getBalanceSheet(U, T, { timezone: 'UTC', preset: 'today' }).catch(e => e);
    expect(err.statusCode).toBe(403);
    expect(require('./xero-utils').isScopeError(err)).toBe(true);
  });

  test('a day after today is refused before any call', async () => {
    await expect(getBalanceSheet(U, T, { timezone: 'UTC', preset: 'date', date: '2026-10-12' }))
      .rejects.toMatchObject({ name: 'PeriodError', message: '12 October 2026 is after today' });
    expect(tbCalls()).toHaveLength(0);
  });

  test('today is the reader\'s today', async () => {
    at('2026-10-11T23:00:00Z');   // already 12 October in Singapore
    const out = await getBalanceSheet(U, T, { timezone: 'Asia/Singapore', preset: 'today' }).catch(e => e);
    expect(tbCalls().map(c => c[1])).toContain('2026-10-12');
    expect(out).toBeDefined();
  });
});
