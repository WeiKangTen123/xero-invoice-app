// Check against Xero for the Balance Sheet: the two arithmetic checks on the
// payload, the bank check against a Bank Summary, and what is said when a
// line cannot be checked.
//
// Everything is mocked. No test in this file reaches Xero, and the first
// thing it checks is that the SDK in use is the mock. The mock is one
// consistent "Xero": the sheet and the Bank Summary are built from the same
// account table, so agreement is the expected case, and a disagreement is
// made by bending one answer.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:      jest.fn(),
    getReportBalanceSheet: jest.fn(),
    getReportBankSummary:  jest.fn(),
    getAccounts:           jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));

const { AccountingApi, __api: api } = require('xero-node');
const { getBalanceCheck, _identityCheck, _subtotalsCheck, _groupTotal } = require('./balance-check');
const { _buildBalanceSheet } = require('./balance-sheet');
const { _cache } = require('./report-cache');

const U = 'u1', T = 't-balcheck';
const ORG = { name: 'Flovon Pte Ltd', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 };

const cell    = (value, accountId) => (accountId ? { value, attributes: [{ id: 'account', value: accountId }] } : { value });
const money   = v => { const s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return v < 0 ? `(${s})` : s; };
const row     = (label, values, { type = 'Row', accountId } = {}) =>
  ({ rowType: type, cells: [cell(label, accountId), ...values.map(v => cell(money(v), accountId))] });
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const header  = labels => ({ rowType: 'Header', cells: [cell(''), ...labels.map(l => cell(l))] });

// Two columns, 30 Sep and 31 Aug 2026. The bank accounts are the ones the
// Bank Summary knows, one of them in USD.
const BANK = [
  { name: 'DBS Current Account', id: 'acc-dbs', currency: 'SGD', values: [52000, 48000] },
  { name: 'Petty Cash',          id: 'acc-pc',  currency: 'SGD', values: [500, 500] },
  { name: 'USD Account',         id: 'acc-usd', currency: 'USD', values: [13500, 13200] },
];
const AR = [18250, 21000], AP = [7400, 6900], RE = [23000, 23000], CYE = [53850, 52800];
const add = (...s) => s.reduce((a, v) => a.map((x, i) => x + v[i]), [0, 0]);
const totalBank = add(...BANK.map(b => b.values));
const totalAssets = add(totalBank, AR);
const netAssets = add(totalAssets, AP.map(v => -v));
const totalEquity = add(RE, CYE);

// Xero's rows for the sheet, with `bend` applied to a line's values by label.
function sheetRows({ bend = {}, bankRows = BANK } = {}) {
  const v = (label, values) => (bend[label] || values);
  return [
    header(['30 Sep 2026', '31 Aug 2026']),
    section('Assets', []),
    section('Bank', [...bankRows.map(b => row(b.name, v(b.name, b.values), { accountId: b.id })), row('Total Bank', v('Total Bank', totalBank), { type: 'SummaryRow' })]),
    section('Current Assets', [row('Accounts Receivable', AR, { accountId: 'acc-ar' }), row('Total Current Assets', v('Total Current Assets', AR), { type: 'SummaryRow' })]),
    section('', [row('Total Assets', v('Total Assets', totalAssets), { type: 'SummaryRow' })]),
    section('Liabilities', []),
    section('Current Liabilities', [row('Accounts Payable', AP, { accountId: 'acc-ap' }), row('Total Current Liabilities', AP, { type: 'SummaryRow' })]),
    section('', [row('Total Liabilities', v('Total Liabilities', AP), { type: 'SummaryRow' })]),
    section('', [row('Net Assets', v('Net Assets', netAssets))]),
    section('Equity', [row('Current Year Earnings', CYE), row('Retained Earnings', RE, { accountId: 'acc-re' }), row('Total Equity', v('Total Equity', totalEquity), { type: 'SummaryRow' })]),
  ];
}
// The Bank Summary is columnar: a Header naming the columns, a Row per
// account at those positions (see bank.js _buildBankSummary).
function bankSummaryRows(accounts = BANK, closing = a => a.values[0]) {
  return [
    { rowType: 'Header', cells: ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'].map(v => cell(v)) },
    section('', accounts.map(a => ({ rowType: 'Row', cells: [cell(a.name), cell(money(a.values[1])), cell('100.00'), cell('50.00'), cell(money(closing(a)))] }))),
  ];
}
const answer = rows => ({ body: { reports: [{ rows }] } });
const sheetOf = (opts = {}) => _buildBalanceSheet(sheetRows(opts), { columns: ['2026-09-30', '2026-08-31'] });
const COLS = sheetOf().columns;

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
const NOW = '2026-10-11T02:00:00Z';
const check = (opts = {}) => getBalanceCheck(U, T, { timezone: 'UTC', compare: 'month', periods: 1, ...opts });
const find  = (out, key) => out.checks.find(c => c.key === key);

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
  api.getReportBalanceSheet.mockResolvedValue(answer(sheetRows()));
  api.getReportBankSummary.mockResolvedValue(answer(bankSummaryRows()));
  api.getAccounts.mockImplementation(async (_t, _since, where) => ({ body: { accounts: /BANK/.test(where || '')
    ? BANK.map(b => ({ accountID: b.id, code: '09x', name: b.name, type: 'BANK', currencyCode: b.currency }))
    : [{ accountID: 'acc-ar', code: '610', name: 'Accounts Receivable', type: 'CURRENT' }] } }));
});
afterEach(() => jest.useRealTimers());

describe('the identity check, from the payload alone', () => {
  test('agrees on a consistent sheet, in every column', () => {
    const c = _identityCheck(sheetOf());
    expect(c).toMatchObject({ key: 'identity', skipped: false, ok: true, lines: 2, matched: 2, differences: [], onlyInXero: [], onlyInApp: [], calls: 0 });
    expect(c.proves).toMatch(/Net Assets set against Total Assets − Total Liabilities and against Total Equity/);
  });

  test('a Net Assets that is not assets less liabilities, or not equity, is reported per column with both figures', () => {
    const c = _identityCheck(sheetOf({ bend: { 'Net Assets': [netAssets[0] + 10, netAssets[1]] } }));
    expect(c.ok).toBe(false);
    expect(c.matched).toBe(0);
    expect(c.differences).toEqual([
      { label: 'Net Assets = Total Assets − Total Liabilities', column: '30 Sep 2026', app: netAssets[0] + 10, xero: netAssets[0], diff: 10 },
      { label: 'Net Assets = Total Equity', column: '30 Sep 2026', app: netAssets[0] + 10, xero: totalEquity[0], diff: 10 },
    ]);
    // Only the equity side off: one line agrees, the other does not.
    const e = _identityCheck(sheetOf({ bend: { 'Total Equity': [totalEquity[0], totalEquity[1] - 0.5] } }));
    expect(e).toMatchObject({ ok: false, lines: 2, matched: 1 });
    expect(e.differences).toEqual([{ label: 'Net Assets = Total Equity', column: '31 Aug 2026', app: netAssets[1], xero: totalEquity[1] - 0.5, diff: 0.5 }]);
  });

  test('is skipped, with the reason, when the sheet has no Net Assets or nothing to set it against', () => {
    const noNet = sheetOf(); noNet.netAssets = null;
    expect(_identityCheck(noNet)).toMatchObject({ key: 'identity', skipped: true, reason: expect.stringMatching(/no Net Assets line/), calls: 0 });
    const noTotals = sheetOf(); noTotals.groups = noTotals.groups.map(g => ({ ...g, total: null, subgroups: g.subgroups.map(s => ({ ...s, total: null })) }));
    expect(_identityCheck(noTotals)).toMatchObject({ skipped: true, reason: expect.stringMatching(/no Total Assets and Total Liabilities/) });
  });

  test("a group's total is its own line, or its one section's where Xero prints it inside (Equity)", () => {
    const s = sheetOf();
    expect(_groupTotal(s.groups[0]).label).toBe('Total Assets');
    expect(_groupTotal(s.groups[2]).label).toBe('Total Equity');
    expect(_groupTotal({ total: null, subgroups: [{ total: { label: 'a' } }, { total: { label: 'b' } }] })).toBeNull();
    expect(_groupTotal(null)).toBeNull();
  });
});

describe('the subtotals check, from the payload alone', () => {
  test('every section total is the sum of its lines and every group total the sum of its sections', () => {
    const c = _subtotalsCheck(sheetOf());
    // Bank, Current Assets, Total Assets, Current Liabilities, Total Liabilities, Total Equity.
    expect(c).toMatchObject({ key: 'subtotals', skipped: false, ok: true, lines: 6, matched: 6, differences: [], calls: 0 });
    expect(c.proves).toMatch(/6 totals/);
  });

  test('a total that is not the sum of its lines names the total, the column, the sum and the printed figure', () => {
    const c = _subtotalsCheck(sheetOf({ bend: { 'Total Bank': [totalBank[0] + 1, totalBank[1]] } }));
    expect(c.ok).toBe(false);
    expect(c.differences).toEqual([
      // The bent section total, against its lines; and the group total, which
      // is right against its lines but now disagrees with the bent section.
      { label: 'Total Bank',   column: '30 Sep 2026', app: totalBank[0],   xero: totalBank[0] + 1, diff: -1 },
      { label: 'Total Assets', column: '30 Sep 2026', app: totalAssets[0] + 1, xero: totalAssets[0], diff: 1 },
    ]);
    expect(c.matched).toBe(4);
  });

  test('a section without a total adds its lines into the group total', () => {
    const s = sheetOf();
    s.groups[0].subgroups[1].total = null;
    const c = _subtotalsCheck(s);
    expect(c).toMatchObject({ ok: true, lines: 5, matched: 5 });
  });

  test('is skipped when there is no total at all', () => {
    expect(_subtotalsCheck({ columns: COLS, groups: [{ key: 'assets', subgroups: [{ title: 'Bank', rows: [], total: null }], total: null }] }))
      .toMatchObject({ key: 'subtotals', skipped: true, reason: expect.stringMatching(/no total lines/) });
  });
});

describe('the bank check against the Bank Summary', () => {
  test('one Bank Summary call over the month to the as-at date, each line against its closing balance; the USD account is left out with the reason', async () => {
    const out = await check();
    expect(api.getReportBankSummary.mock.calls).toEqual([[T, '2026-08-31', '2026-09-30']]);
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(1);

    const bank = find(out, 'bank');
    expect(bank).toMatchObject({ key: 'bank', skipped: false, ok: true, lines: 2, matched: 2, differences: [], onlyInXero: [], onlyInApp: [], calls: 1 });
    expect(bank.excluded).toEqual([{ label: 'USD Account', reason: expect.stringMatching(/held in USD; the Balance Sheet shows it in SGD/) }]);
    expect(bank.proves).toMatch(/closing balance Xero's Bank Summary gives that account at 30 Sep 2026/);
    expect(bank.proves).toMatch(/1 line left out/);

    expect(out.ok).toBe(true);
    expect(out.calls).toBe(1);
    expect(out.checks.map(c => c.key)).toEqual(['identity', 'subtotals', 'bank']);
    expect(out.checkedAt).toBe(new Date(NOW).toISOString());
    expect(out.currency).toBe('SGD');
    expect(out.period).toEqual({ asAtLabel: '30 September 2026', asAtISO: '2026-09-30', basis: 'accrual', compare: { type: 'month', periods: 1 }, current: null });
    expect(out.notes).toHaveLength(4);
    expect(out.notes[3]).toMatch(/accrual basis/);
  });

  test('a bank line Xero holds a different balance for is a difference, and the verdict is not ok', async () => {
    api.getReportBankSummary.mockResolvedValue(answer(bankSummaryRows(BANK, a => (a.name === 'Petty Cash' ? 450 : a.values[0]))));
    const out = await check();
    const bank = find(out, 'bank');
    expect(bank.ok).toBe(false);
    expect(bank.differences).toEqual([{ label: 'Petty Cash', column: '30 Sep 2026', app: 500, xero: 450, diff: 50 }]);
    expect(bank.matched).toBe(1);
    expect(out.ok).toBe(false);
  });

  test('a line with no Bank Summary line of its name is left out with the reason, and a Bank Summary account the sheet lacks is reported', async () => {
    api.getReportBankSummary.mockResolvedValue(answer(bankSummaryRows([BANK[0], { name: 'Savings', values: [9000, 9000] }])));
    const out = await check();
    const bank = find(out, 'bank');
    expect(bank.excluded).toEqual([
      { label: 'Petty Cash',  reason: 'No line of the Bank Summary is named "Petty Cash", so it could not be matched.' },
      { label: 'USD Account', reason: expect.stringMatching(/held in USD/) },
    ]);
    expect(bank).toMatchObject({ lines: 1, matched: 1, onlyInXero: ['Savings'], ok: false });
  });

  test('is skipped as a whole when no line could be matched, or when the sheet has no Bank section', async () => {
    api.getReportBankSummary.mockResolvedValue(answer(bankSummaryRows([])));
    let out = await check();
    expect(find(out, 'bank')).toMatchObject({ skipped: true, reason: expect.stringMatching(/^None of the 3 bank lines could be checked/), calls: 1 });
    expect(out.ok).toBe(true);   // the two arithmetic checks still ran and agreed

    _cache.clear();
    api.getReportBalanceSheet.mockResolvedValue(answer(sheetRows().filter(r => r.title !== 'Bank')));
    out = await check();
    expect(find(out, 'bank')).toMatchObject({ skipped: true, reason: expect.stringMatching(/no Bank section/), calls: 0 });
    expect(api.getReportBankSummary).toHaveBeenCalledTimes(1);
  });

  test('without the bank account list every line is taken to be in base currency', async () => {
    api.getAccounts.mockImplementation(async (_t, _since, where) => (/BANK/.test(where || '')
      ? Promise.reject(new Error('no list'))
      : { body: { accounts: [] } }));
    const out = await check();
    expect(find(out, 'bank')).toMatchObject({ lines: 3, matched: 3, excluded: [], ok: true });
  });

  test('a failure to reach Xero is a failure, never a verdict, and nothing is cached', async () => {
    api.getReportBankSummary.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));
    await expect(check()).rejects.toThrow(/rate limit/);
    expect([..._cache.keys()].some(k => k.startsWith('balcheck:'))).toBe(false);
  });
});

describe('the verdict as a whole', () => {
  test('is cached ten minutes under its own key, and the month in progress is named', async () => {
    const out = await check({ preset: 'this-month', compare: 'none' });
    expect(out.period.current).toEqual({ key: '2026-10', label: '30 Sep 2026', endISO: '2026-10-31' });
    const again = await check({ preset: 'this-month', compare: 'none' });
    expect(again.cached).toBe(true);
    expect(api.getReportBankSummary).toHaveBeenCalledTimes(1);
    expect([..._cache.keys()].filter(k => k.startsWith('balcheck:'))).toEqual([`balcheck:${U}:${T}:2026-10-31:0:none:accrual`]);
  });

  test('a broken sheet fails on the arithmetic even when the bank agrees', async () => {
    api.getReportBalanceSheet.mockResolvedValue(answer(sheetRows({ bend: { 'Total Assets': [totalAssets[0] + 100, totalAssets[1]] } })));
    const out = await check();
    expect(find(out, 'bank').ok).toBe(true);
    expect(find(out, 'subtotals').ok).toBe(false);
    expect(find(out, 'identity').ok).toBe(false);
    expect(out.ok).toBe(false);
  });
});
