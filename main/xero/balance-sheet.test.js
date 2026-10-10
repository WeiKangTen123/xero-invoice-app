// The Balance Sheet tab: which date each preset names, what is sent to Xero,
// how Xero's flat list of sections is read into groups, and when a new
// answer is asked for.
//
// Everything is mocked. No test in this file reaches Xero, and the first
// thing it checks is that the SDK in use is the mock.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:      jest.fn(),
    getReportBalanceSheet: jest.fn(),
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
  getBalanceSheet, _balanceQueryFromParams, _resolveAsAt, _columnDates, _buildBalanceSheet,
  BALANCE_PRESETS, MAX_BALANCE_PERIODS,
} = require('./balance-sheet');
const { _cache, FORCE_GRACE_MS } = require('./report-cache');
const { PeriodError } = require('./periods');

const U = 'u1', T = 't-bal';
const ORG = { name: 'Flovon Pte Ltd', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 };
const DEC = { month: 12, day: 31 }, MAR = { month: 3, day: 31 }, FEB = { month: 2, day: 28 };

// ── Xero's shape ────────────────────────────────────────────────────────────
// A cell, with the AccountID attribute Xero puts on account rows; a row; a
// section. Money is written as Xero writes it: two decimals, thousands
// separated, negatives in brackets.
const money   = v => { const s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return v < 0 ? `(${s})` : s; };
const cell    = (value, accountId) => (accountId ? { value, attributes: [{ id: 'account', value: accountId }] } : { value });
const row     = (label, values, { type = 'Row', accountId } = {}) =>
  ({ rowType: type, cells: [cell(label, accountId), ...values.map(v => cell(money(v), accountId))] });
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const header  = labels => ({ rowType: 'Header', cells: [cell(''), ...labels.map(l => cell(l))] });

// The organisation's sheet at 30 Sep 2026 and the two month ends before it,
// newest first, as Xero lays it out: Assets and Liabilities are titles with
// no rows, each "Total …" of a titled section is its SummaryRow, the group
// totals and Net Assets sit in untitled sections, and Equity carries its own
// rows and total. Totals are summed here so the fixture cannot disagree with
// itself; the tests that need a broken one bend it afterwards.
const ACCOUNTS = {
  'DBS Current Account': { id: 'acc-dbs',   code: '090', values: [52000, 48000, 45000] },
  'Petty Cash':          { id: 'acc-petty', code: '091', values: [500, 500, 400] },
  'Accounts Receivable': { id: 'acc-ar',    code: '610', values: [18250, 21000, 19500] },
  'Prepayments':         { id: 'acc-pre',   code: '620', values: [1200, 1300, 1400] },
  'Office Equipment':    { id: 'acc-oe',    code: '710', values: [9000, 9000, 9000] },
  'Less Accumulated Depreciation on Office Equipment': { id: 'acc-dep', code: '711', values: [-3000, -2750, -2500] },
  'Accounts Payable':    { id: 'acc-ap',    code: '800', values: [7400, 6900, 7100] },
  'GST':                 { id: 'acc-gst',   code: '820', values: [2150, 1900, 2000] },
  'Loan':                { id: 'acc-loan',  code: '900', values: [20000, 20500, 21000] },
  'Current Year Earnings': { id: null, code: null, values: [15400, 14650, 11700] },
  'Retained Earnings':     { id: 'acc-re',  code: '960', values: [23000, 23000, 23000] },
  'Share Capital':         { id: 'acc-sc',  code: '970', values: [10000, 10000, 10000] },
};
const LAYOUT = [
  ['Assets',                  []],
  ['Bank',                    ['DBS Current Account', 'Petty Cash'],        'Total Bank'],
  ['Current Assets',          ['Accounts Receivable', 'Prepayments'],      'Total Current Assets'],
  ['Fixed Assets',            ['Office Equipment', 'Less Accumulated Depreciation on Office Equipment'], 'Total Fixed Assets'],
  ['',                        [],                                          'Total Assets'],
  ['Liabilities',             []],
  ['Current Liabilities',     ['Accounts Payable', 'GST'],                 'Total Current Liabilities'],
  ['Non-current Liabilities', ['Loan'],                                    'Total Non-current Liabilities'],
  ['',                        [],                                          'Total Liabilities'],
  ['',                        ['Net Assets']],
  ['Equity',                  ['Current Year Earnings', 'Retained Earnings', 'Share Capital'], 'Total Equity'],
];
const COLS = ['30 Sep 2026', '31 Aug 2026', '31 Jul 2026'];
const add  = (...series) => series.reduce((s, v) => s.map((x, i) => x + v[i]), [0, 0, 0]);
const sumOf = names => add(...names.map(n => ACCOUNTS[n].values));
const TOTALS = {
  'Total Bank':                  sumOf(['DBS Current Account', 'Petty Cash']),
  'Total Current Assets':        sumOf(['Accounts Receivable', 'Prepayments']),
  'Total Fixed Assets':          sumOf(['Office Equipment', 'Less Accumulated Depreciation on Office Equipment']),
  'Total Current Liabilities':   sumOf(['Accounts Payable', 'GST']),
  'Total Non-current Liabilities': sumOf(['Loan']),
  'Total Equity':                sumOf(['Current Year Earnings', 'Retained Earnings', 'Share Capital']),
};
TOTALS['Total Assets']      = add(TOTALS['Total Bank'], TOTALS['Total Current Assets'], TOTALS['Total Fixed Assets']);
TOTALS['Total Liabilities'] = add(TOTALS['Total Current Liabilities'], TOTALS['Total Non-current Liabilities']);
TOTALS['Net Assets']        = TOTALS['Total Assets'].map((v, i) => v - TOTALS['Total Liabilities'][i]);

// Xero's rows for `n` columns, from `layout`; a value is taken from the
// account table, the totals, or `override` (label → values) first.
function treeOf(n, { layout = LAYOUT, override = {} } = {}) {
  const vals = label => (override[label] || ACCOUNTS[label]?.values || TOTALS[label]).slice(0, n);
  const rows = [header(COLS.slice(0, n))];
  for (const [title, accounts, total] of layout) {
    const lines = accounts.map(a => row(a, vals(a), { accountId: ACCOUNTS[a]?.id || undefined }));
    if (total) lines.push(row(total, vals(total), { type: 'SummaryRow' }));
    if (title || lines.length) rows.push(section(title, lines));
  }
  return rows;
}
const answer = rows => ({ body: { reports: [{ rows }] } });

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
const NOW   = '2026-10-11T02:00:00Z';
const TODAY = { year: 2026, month: 10, day: 11 };
const at    = iso => jest.setSystemTime(new Date(iso));
const get   = (opts = {}) => getBalanceSheet(U, T, { timezone: 'UTC', ...opts });
const lastCall = () => api.getReportBalanceSheet.mock.calls.at(-1);

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
  // Two columns with no comparison, as the live endpoint answers.
  api.getReportBalanceSheet.mockImplementation(async (_t, _date, periods) => answer(treeOf(periods ? periods + 1 : 2)));
  api.getAccounts.mockResolvedValue({ body: { accounts: Object.entries(ACCOUNTS)
    .filter(([, a]) => a.id).map(([name, a]) => ({ accountID: a.id, code: a.code, name, type: 'OTHER' })) } });
});
afterEach(() => jest.useRealTimers());

describe('the as-at date each preset names', () => {
  const resolve = (preset, today = TODAY, fy = DEC, month) => _resolveAsAt({ preset, month }, today, fy);

  test('last-month-end is the last day of the previous month, February and year boundaries included', () => {
    expect(resolve('last-month-end')).toMatchObject({ iso: '2026-09-30', label: '30 September 2026', preset: 'last-month-end', inProgress: false });
    expect(resolve('last-month-end', { year: 2026, month: 3, day: 10 }).iso).toBe('2026-02-28');
    expect(resolve('last-month-end', { year: 2024, month: 3, day: 1 }).iso).toBe('2024-02-29');
    expect(resolve('last-month-end', { year: 2026, month: 1, day: 15 }).iso).toBe('2025-12-31');
  });

  test('last-quarter-end is the last day of the previous calendar quarter', () => {
    expect(resolve('last-quarter-end').iso).toBe('2026-09-30');                             // October: Q3 just ended
    expect(resolve('last-quarter-end', { year: 2026, month: 12, day: 31 }).iso).toBe('2026-09-30');
    expect(resolve('last-quarter-end', { year: 2026, month: 1, day: 15 }).iso).toBe('2025-12-31');
    expect(resolve('last-quarter-end', { year: 2026, month: 3, day: 10 }).iso).toBe('2025-12-31');
    expect(resolve('last-quarter-end', { year: 2026, month: 4, day: 1 }).iso).toBe('2026-03-31');
  });

  test("last-fy-end is the day before the organisation's current financial year began", () => {
    expect(resolve('last-fy-end', TODAY, DEC)).toMatchObject({ iso: '2025-12-31', label: '31 December 2025' });
    expect(resolve('last-fy-end', TODAY, MAR).iso).toBe('2026-03-31');
    expect(resolve('last-fy-end', { year: 2026, month: 2, day: 10 }, MAR).iso).toBe('2025-03-31');   // still inside the year to March 2026
    expect(resolve('last-fy-end', TODAY, FEB).iso).toBe('2026-02-28');
    expect(resolve('last-fy-end', { year: 2024, month: 10, day: 1 }, FEB).iso).toBe('2024-02-29');
  });

  test('this-month is the last day of the current month, and is in progress', () => {
    expect(resolve('this-month')).toMatchObject({ iso: '2026-10-31', label: '31 October 2026', inProgress: true });
    expect(resolve('this-month', { year: 2026, month: 10, day: 31 }).inProgress).toBe(true);   // the day itself has not ended
  });

  test("month is that month's last day; the month in progress is accepted, a later one refused", () => {
    expect(resolve('month', TODAY, DEC, '2026-02')).toMatchObject({ iso: '2026-02-28', label: '28 February 2026', inProgress: false });
    expect(resolve('month', TODAY, DEC, '2024-02').iso).toBe('2024-02-29');
    expect(resolve('month', TODAY, DEC, '2026-10')).toMatchObject({ iso: '2026-10-31', inProgress: true });
    expect(() => resolve('month', TODAY, DEC, '2026-11')).toThrow(PeriodError);
    expect(() => resolve('month', TODAY, DEC, '2026-11')).toThrow(/November 2026 has not started/);
    expect(() => resolve('month', TODAY, DEC)).toThrow(PeriodError);
  });

  test('every preset the query gate accepts resolves', () => {
    for (const p of BALANCE_PRESETS) expect(resolve(p, TODAY, DEC, '2026-09').iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(() => resolve('last-year')).toThrow(PeriodError);
  });

  test("today is read in the reader's timezone", async () => {
    at('2026-10-31T23:00:00Z');   // already 1 November in Auckland
    await get({ preset: 'last-month-end', timezone: 'Pacific/Auckland' });
    expect(lastCall()[1]).toBe('2026-10-31');
    await get({ preset: 'last-month-end', timezone: 'UTC' });
    expect(lastCall()[1]).toBe('2026-09-30');
  });
});

describe('the query gate', () => {
  test('defaults: last month end, no comparison, accrual', () => {
    expect(_balanceQueryFromParams({})).toEqual({ preset: 'last-month-end', month: undefined, compare: 'none', periods: undefined, basis: 'accrual' });
    expect(_balanceQueryFromParams({ preset: '', compare: '', basis: '' })).toMatchObject({ preset: 'last-month-end', compare: 'none', basis: 'accrual' });
  });

  test('reads a full query, and periods only with a comparison', () => {
    expect(_balanceQueryFromParams({ preset: 'month', month: '2026-08', compare: 'quarter', periods: '3', basis: 'cash' }))
      .toEqual({ preset: 'month', month: '2026-08', compare: 'quarter', periods: 3, basis: 'cash' });
    expect(_balanceQueryFromParams({ compare: 'year' }).periods).toBe(1);
    // A stray periods with no comparison is not the request, and not an error.
    expect(_balanceQueryFromParams({ periods: '5' })).toMatchObject({ compare: 'none', periods: undefined });
    expect(_balanceQueryFromParams({ preset: 'this-month', month: '2020-01' }).month).toBeUndefined();
  });

  test('refuses what the report cannot be asked for, each with a reason', () => {
    const INVALID = {
      'an unknown preset':             { preset: 'last-year' },
      'month without a month':         { preset: 'month' },
      'a month that does not exist':   { preset: 'month', month: '2026-13' },
      'a full date':                   { preset: 'month', month: '2026-09-30' },
      'a year before the bounds':      { preset: 'month', month: '1989-12' },
      'a year after the bounds':       { preset: 'month', month: '2101-01' },
      'an unknown comparison':         { compare: 'prior-year' },
      'zero periods':                  { compare: 'month', periods: '0' },
      'too many periods':              { compare: 'month', periods: String(MAX_BALANCE_PERIODS + 1) },
      'periods that is not a number':  { compare: 'month', periods: 'three' },
      'a fraction of a period':        { compare: 'month', periods: '1.5' },
      'an unknown basis':              { basis: 'modified' },
      'a preset given twice':          { preset: ['last-month-end', 'this-month'] },
      'a month given twice':           { preset: 'month', month: ['2026-01', '2026-02'] },
    };
    for (const [why, q] of Object.entries(INVALID)) {
      let err = null;
      try { _balanceQueryFromParams(q); } catch (e) { err = e; }
      expect({ why, thrown: err instanceof PeriodError, status: err?.status }).toEqual({ why, thrown: true, status: 400 });
      expect(typeof err.message).toBe('string');
    }
  });
});

describe('what is sent to Xero', () => {
  test('the as-at date, no periods and no timeframe without a comparison, the standard layout, and nothing for the basis on accrual', async () => {
    await get();
    expect(lastCall()).toEqual([T, '2026-09-30', undefined, undefined, undefined, undefined, true, undefined]);
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(1);
  });

  test('a comparison sends periods and its timeframe', async () => {
    await get({ compare: 'month', periods: 2 });
    expect(lastCall()).toEqual([T, '2026-09-30', 2, 'MONTH', undefined, undefined, true, undefined]);
    await get({ compare: 'quarter', periods: 3 });
    expect(lastCall().slice(2, 4)).toEqual([3, 'QUARTER']);
    await get({ compare: 'year' });
    expect(lastCall().slice(2, 4)).toEqual([1, 'YEAR']);
  });

  test('the cash basis is paymentsOnly, and only then', async () => {
    await get({ basis: 'cash' });
    expect(lastCall()).toEqual([T, '2026-09-30', undefined, undefined, undefined, undefined, true, true]);
  });

  test('the date is the preset resolved against the organisation year end', async () => {
    api.getOrganisations.mockResolvedValue({ body: { organisations: [{ ...ORG, financialYearEndMonth: 3 }] } });
    await get({ preset: 'last-fy-end' });
    expect(lastCall()[1]).toBe('2026-03-31');
    await get({ preset: 'month', month: '2026-02' });
    expect(lastCall()[1]).toBe('2026-02-28');
  });

  test('a month after this one is refused before any call', async () => {
    await expect(get({ preset: 'month', month: '2026-11' })).rejects.toMatchObject({ name: 'PeriodError', status: 400 });
    expect(api.getReportBalanceSheet).not.toHaveBeenCalled();
  });
});

describe('the payload', () => {
  test("the two-column answer to a request with no comparison is trimmed to the one column asked for", async () => {
    const out = await get();
    expect(out.columns).toEqual([{ iso: '2026-09-30', label: '30 Sep 2026' }]);
    expect(out.compare).toEqual({ type: 'none', periods: 0 });
    for (const g of out.groups) {
      for (const s of g.subgroups) for (const r of s.rows) expect(r.values).toHaveLength(1);
      if (g.total) expect(g.total.values).toHaveLength(1);
    }
    expect(out.netAssets).toEqual({ label: 'Net Assets', values: [TOTALS['Net Assets'][0]] });
  });

  test('the tree is read into assets, liabilities and equity, with every figure as Xero printed it', async () => {
    const out = await get();
    expect(out.organisation).toEqual({ name: 'Flovon Pte Ltd', currency: 'SGD' });
    expect(out.asAt).toEqual({ iso: '2026-09-30', label: '30 September 2026', preset: 'last-month-end', inProgress: false });
    expect(out.basis).toBe('accrual');
    expect(out.groups.map(g => [g.key, g.title])).toEqual([['assets', 'Assets'], ['liabilities', 'Liabilities'], ['equity', 'Equity']]);

    const [assets, liabilities, equity] = out.groups;
    expect(assets.subgroups.map(s => s.title)).toEqual(['Bank', 'Current Assets', 'Fixed Assets']);
    expect(assets.subgroups[0]).toEqual({
      title: 'Bank',
      rows: [
        { label: 'DBS Current Account', accountId: 'acc-dbs',   code: '090', values: [52000] },
        { label: 'Petty Cash',          accountId: 'acc-petty', code: '091', values: [500] },
      ],
      total: { label: 'Total Bank', values: [52500] },
    });
    expect(assets.subgroups[2].rows[1]).toMatchObject({ label: 'Less Accumulated Depreciation on Office Equipment', values: [-3000] });
    expect(assets.subgroups[2].total).toEqual({ label: 'Total Fixed Assets', values: [6000] });
    expect(assets.total).toEqual({ label: 'Total Assets', values: [77950] });

    expect(liabilities.subgroups.map(s => [s.title, s.total.label])).toEqual([
      ['Current Liabilities', 'Total Current Liabilities'], ['Non-current Liabilities', 'Total Non-current Liabilities'],
    ]);
    expect(liabilities.total).toEqual({ label: 'Total Liabilities', values: [29550] });
    expect(out.netAssets).toEqual({ label: 'Net Assets', values: [48400] });

    // Equity's rows and total sit in the one section Xero prints them in.
    expect(equity.subgroups).toHaveLength(1);
    expect(equity.subgroups[0].title).toBe('Equity');
    expect(equity.subgroups[0].rows.map(r => [r.label, r.accountId, r.code])).toEqual([
      ['Current Year Earnings', null, null], ['Retained Earnings', 'acc-re', '960'], ['Share Capital', 'acc-sc', '970'],
    ]);
    expect(equity.subgroups[0].total).toEqual({ label: 'Total Equity', values: [48400] });
    expect(equity.total).toBeNull();
    expect(out.notes).toEqual([]);
    expect(out.cached).toBe(false);
  });

  test('three columns, newest first, dated from the as-at date and labelled as Xero labels them', async () => {
    const out = await get({ compare: 'month', periods: 2 });
    expect(out.columns).toEqual([
      { iso: '2026-09-30', label: '30 Sep 2026' }, { iso: '2026-08-31', label: '31 Aug 2026' }, { iso: '2026-07-31', label: '31 Jul 2026' },
    ]);
    expect(out.compare).toEqual({ type: 'month', periods: 2 });
    const bank = out.groups[0].subgroups[0];
    expect(bank.rows[0].values).toEqual([52000, 48000, 45000]);
    expect(bank.total.values).toEqual([52500, 48500, 45400]);
    expect(out.groups[0].total.values).toEqual(TOTALS['Total Assets']);
    expect(out.netAssets.values).toEqual(TOTALS['Net Assets']);
  });

  test('column dates step by the timeframe and are clamped to each month end', () => {
    expect(_columnDates('2026-03-31', 2, 'MONTH')).toEqual(['2026-03-31', '2026-02-28', '2026-01-31']);
    expect(_columnDates('2024-05-31', 1, 'QUARTER')).toEqual(['2024-05-31', '2024-02-29']);
    expect(_columnDates('2026-02-28', 2, 'YEAR')).toEqual(['2026-02-28', '2025-02-28', '2024-02-29']);
    expect(_columnDates('2026-01-31', 1, 'MONTH')).toEqual(['2026-01-31', '2025-12-31']);
    expect(_columnDates('2026-09-30')).toEqual(['2026-09-30']);
  });

  test('a column Xero did not label falls back to a date of its own', () => {
    const rows = treeOf(1);
    rows[0] = header([]);
    const out = _buildBalanceSheet(rows, { columns: ['2026-09-30'] });
    expect(out.columns).toEqual([{ iso: '2026-09-30', label: '30 Sep 2026' }]);
  });

  test('account codes come from the chart of accounts, and are null when it cannot be read', async () => {
    api.getAccounts.mockRejectedValue(new Error('settings scope missing'));
    const out = await get();
    expect(out.groups[0].subgroups[0].rows[0]).toMatchObject({ accountId: 'acc-dbs', code: null });
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(1);
  });

  test('a section Xero titles its own way goes under the group it sits in by position', () => {
    const layout = [
      ['Bank',                    ['DBS Current Account'],  'Total Bank'],
      ['Inventory',               ['Prepayments'],          'Total Inventory'],        // before Total Assets: an asset
      ['',                        [],                       'Total Assets'],
      ['Current Liabilities',     ['Accounts Payable'],     'Total Current Liabilities'],
      ['Provisions',              ['Loan'],                 'Total Provisions'],       // before Total Liabilities: a liability
      ['',                        [],                       'Total Liabilities'],
      ['',                        ['Net Assets']],
      ['Reserves',                ['Retained Earnings'],    'Total Reserves'],         // after the liabilities closed: equity
      ['Equity',                  ['Share Capital'],        'Total Equity'],
    ];
    const override = {
      'Total Inventory': ACCOUNTS.Prepayments.values, 'Total Provisions': ACCOUNTS.Loan.values,
      'Total Reserves': ACCOUNTS['Retained Earnings'].values, 'Total Equity': ACCOUNTS['Share Capital'].values,
    };
    const out = _buildBalanceSheet(treeOf(1, { layout, override }), { columns: ['2026-09-30'] });
    expect(out.groups.map(g => [g.key, g.title, g.subgroups.map(s => s.title)])).toEqual([
      ['assets',      'Assets',      ['Bank', 'Inventory']],
      ['liabilities', 'Liabilities', ['Current Liabilities', 'Provisions']],
      ['equity',      'Equity',      ['Reserves', 'Equity']],
    ]);
    expect(out.groups[0].total).toEqual({ label: 'Total Assets', values: TOTALS['Total Assets'].slice(0, 1) });
    expect(out.groups[1].total.label).toBe('Total Liabilities');
    expect(out.netAssets.label).toBe('Net Assets');
    expect(out.groups[2].subgroups[1].total).toEqual({ label: 'Total Equity', values: [10000] });
    expect(out.notes).toEqual([]);
  });

  test('a group Xero leaves out is absent, and an unexpected line is kept with a note rather than dropped', () => {
    const layout = [
      ['Assets', []],
      ['Bank',   ['DBS Current Account'], 'Total Bank'],
      ['',       [],                      'Total Assets'],
      ['',       ['Rounding']],
    ];
    const out = _buildBalanceSheet(treeOf(1, { layout, override: { 'Total Assets': [52000, 0, 0], Rounding: [0.01, 0, 0] } }), { columns: ['2026-09-30'] });
    expect(out.groups.map(g => g.key)).toEqual(['assets']);
    expect(out.netAssets).toBeNull();
    expect(out.groups[0].subgroups.map(s => s.title)).toEqual(['Bank', '']);
    expect(out.groups[0].subgroups[1]).toEqual({ title: '', rows: [{ label: 'Rounding', accountId: null, code: null, values: [0.01] }], total: null });
    expect(out.notes).toEqual(['Xero\'s report has a line this app did not expect, "Rounding"; it is shown under Assets without a subtotal.']);
  });

  test('an empty report is an empty sheet, not a failure', () => {
    expect(_buildBalanceSheet([], { columns: ['2026-09-30'] })).toEqual({
      columns: [{ iso: '2026-09-30', label: '30 Sep 2026' }], groups: [], netAssets: null, notes: [],
    });
  });
});

describe('the cache', () => {
  test('a second request is served from the cache; force within the grace window still is, after it is not', async () => {
    const first = await get();
    expect(first.cached).toBe(false);
    const again = await get();
    expect(again.cached).toBe(true);
    expect(again.groups).toEqual(first.groups);
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(1);

    await get({ force: true });
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(1);
    at(new Date(new Date(NOW).getTime() + FORCE_GRACE_MS + 1000).toISOString());
    const fresh = await get({ force: true });
    expect(fresh.cached).toBe(false);
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(2);
  });

  test('the key is the date, the comparison and the basis, so each is its own entry', async () => {
    await get();
    await get({ preset: 'last-fy-end' });
    await get({ compare: 'month', periods: 2 });
    await get({ compare: 'quarter', periods: 2 });
    await get({ basis: 'cash' });
    expect([..._cache.keys()].filter(k => k.startsWith('balsheet:')).sort()).toEqual([
      `balsheet:${U}:${T}:2025-12-31:0:-:accrual`,
      `balsheet:${U}:${T}:2026-09-30:0:-:accrual`,
      `balsheet:${U}:${T}:2026-09-30:0:-:cash`,
      `balsheet:${U}:${T}:2026-09-30:2:MONTH:accrual`,
      `balsheet:${U}:${T}:2026-09-30:2:QUARTER:accrual`,
    ]);
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(5);
  });

  test('this-month and the same month named outright are one entry, each answered under its own name', async () => {
    const a = await get({ preset: 'this-month' });
    const b = await get({ preset: 'month', month: '2026-10' });
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(1);
    expect(a.asAt).toEqual({ iso: '2026-10-31', label: '31 October 2026', preset: 'this-month', inProgress: true });
    expect(b.asAt).toEqual({ iso: '2026-10-31', label: '31 October 2026', preset: 'month', inProgress: true });
    expect(b.cached).toBe(true);
  });

  test('a request spelled with its defaults and one without share a fetch in flight', async () => {
    const [a, b] = await Promise.all([get(), get({ preset: 'last-month-end', compare: 'none', basis: 'accrual', force: false })]);
    expect(api.getReportBalanceSheet).toHaveBeenCalledTimes(1);
    expect(a.fetchedAt).toBe(b.fetchedAt);
  });
});
