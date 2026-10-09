// Check against Xero: the three calls it makes, what it says when Xero
// agrees, and what it says when the grid's columns have slid.
//
// Everything is mocked. No test in this file reaches Xero, and the first thing
// it checks is that the SDK in use is the mock. The mock is one consistent
// "Xero": a single table of monthly figures answers the grid's periods-based
// calls AND the check's no-periods calls, so agreement is the expected case,
// and a disagreement can be made by bending only the periods-based answer.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getBudgets:             jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));

const { AccountingApi, __api: api } = require('xero-node');
const { getBudgetCheck, _compareLines, _lineName, _rangeLabel } = require('./budget-check');
const { _cache, FORCE_GRACE_MS } = require('./report-cache');

const U = 'u1', T = 't-check';
const ORG = { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 };

// Xero's report cell shape, and the standard layout both endpoints answer in.
const cell    = value => ({ value });
const row     = (label, values, rowType = 'Row') => ({ rowType, cells: [cell(label), ...values.map(cell)] });
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const money   = v => (v === 0 ? '0.00' : v.toFixed(2));
const sum     = vs => vs.reduce((s, v) => s + v, 0);
const LAYOUT  = [
  ['Income',                  ['Sales - Implementation', 'Sales - Maintenance (Recurring)'], 'Total Income'],
  ['Less Cost of Sales',      ['Cost of Goods Sold'],                                        'Total Cost of Sales'],
  ['',                        [],                                                            'Gross Profit'],
  ['Other Income',            ['Other Income - Grant'],                                      'Total Other Income'],
  ['Less Operating Expenses', ['Bank Fees', 'Wages and Salaries'],                           'Total Operating Expenses'],
  ['',                        [],                                                            'Net Profit'],
];
// A report over `values` (label -> column values). A line not in `values` is
// left out, as Xero leaves out an account with nothing in it, and a section
// with nothing left is left out whole.
function reportOf(values, { header = '', extra = [] } = {}) {
  const rows = [{ rowType: 'Header', cells: [cell(header)] }];
  for (const [title, accounts, total] of LAYOUT) {
    const acc = accounts.filter(a => values[a]).map(a => row(a, values[a].map(money)));
    const tot = values[total] ? [row(total, values[total].map(money), 'SummaryRow')] : [];
    const more = extra.filter(e => e.section === title).map(e => row(e.label, e.values.map(money)));
    if (acc.length || tot.length || more.length) rows.push(section(title, [...acc, ...more, ...tot]));
  }
  return { body: { reports: [{ rows }] } };
}
const mapValues = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v, k)]));

// Jan..Dec 2026, oldest-first. Actuals stop after October's "so far" figure;
// the P&L never has the budget-only accounts (cost of sales, grant, fees).
const ACTUAL = {
  'Sales - Implementation':          [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 190, 0, 0],
  'Sales - Maintenance (Recurring)': [500, 500, 500, 500, 500, 500, 500, 500, 500, 50, 0, 0],
  'Wages and Salaries':              [800, 800, 800, 800, 800, 800, 800, 800, 800, 80, 0, 0],
};
ACTUAL['Total Income']             = ACTUAL['Sales - Implementation'].map((v, i) => v + ACTUAL['Sales - Maintenance (Recurring)'][i]);
ACTUAL['Gross Profit']             = ACTUAL['Total Income'];
ACTUAL['Total Operating Expenses'] = ACTUAL['Wages and Salaries'];
ACTUAL['Net Profit']               = ACTUAL['Total Income'].map((v, i) => v - ACTUAL['Wages and Salaries'][i]);

const BUDGET = {
  'Sales - Implementation':          [900, 900, 900, 1200, 1200, 1200, 1500, 1500, 1500, 1800, 1800, 1800],
  'Sales - Maintenance (Recurring)': Array(12).fill(500),
  'Cost of Goods Sold':              Array(12).fill(100),
  'Other Income - Grant':            [0, 0, 0, 0, 0, 0, 2000, 0, 0, 0, 0, 0],
  'Bank Fees':                       Array(12).fill(10),
  'Wages and Salaries':              Array(12).fill(800),
};
BUDGET['Total Income']             = BUDGET['Sales - Implementation'].map((v, i) => v + BUDGET['Sales - Maintenance (Recurring)'][i]);
BUDGET['Total Cost of Sales']      = BUDGET['Cost of Goods Sold'];
BUDGET['Gross Profit']             = BUDGET['Total Income'].map((v, i) => v - BUDGET['Cost of Goods Sold'][i]);
BUDGET['Total Other Income']       = BUDGET['Other Income - Grant'];
BUDGET['Total Operating Expenses'] = BUDGET['Bank Fees'].map((v, i) => v + BUDGET['Wages and Salaries'][i]);
BUDGET['Net Profit']               = BUDGET['Gross Profit'].map((v, i) => v + BUDGET['Other Income - Grant'][i] - BUDGET['Total Operating Expenses'][i]);

// One Xero, answering every shape of call from the tables above. Every date
// in these tests is in 2026, so a month's index is its number less one.
const idx = iso => Number(String(iso).slice(5, 7)) - 1;
function answerFrom(actual, budget) {
  // A comparison call is anchored on `to` and answers NEWEST-first; a call
  // with no periods is one column, the sum over its dates.
  api.getReportProfitAndLoss.mockImplementation(async (_t, from, to, periods) => {
    if (periods !== undefined) return reportOf(mapValues(actual, v => v.slice(idx(to) - periods, idx(to) + 1).reverse()));
    return reportOf(mapValues(actual, v => [sum(v.slice(idx(from), idx(to) + 1))]));
  });
  // Anchored on `date`, OLDEST-first: one column a month, or one a quarter.
  api.getReportBudgetSummary.mockImplementation(async (_t, date, periods, timeframe) => {
    const at = idx(date);
    if (timeframe === 3) return reportOf(mapValues(budget, v => Array.from({ length: periods }, (_, q) => sum(v.slice(at + 3 * q, at + 3 * q + 3)))), { header: 'Account' });
    return reportOf(mapValues(budget, v => v.slice(at, at + periods)), { header: 'Account' });
  });
}

const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
const NOW  = '2026-10-09T02:00:00Z';   // Jan–Sep closed, October in progress
const at   = iso => jest.setSystemTime(new Date(iso));
const YEAR = { from: '2026-01', to: '2026-12' };
const check = (period = YEAR, opts = {}) => getBudgetCheck(U, T, { timezone: 'UTC', period, ...opts });
const noPeriodCalls = () => api.getReportProfitAndLoss.mock.calls.filter(c => c[3] === undefined);
const findCheck = (out, key) => out.checks.find(c => c.key === key);

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
  api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
  answerFrom(ACTUAL, BUDGET);
});
afterEach(() => jest.useRealTimers());

describe('the three independent calls', () => {
  test('two P&L calls by their own dates with no periods and the standard layout, and the budget by quarter from the first month', async () => {
    const out = await check();

    // The grid's own calls came first; the check's are the ones without periods.
    expect(api.getReportProfitAndLoss.mock.calls[0].slice(1, 5)).toEqual(['2026-12-01', '2026-12-31', 11, 'MONTH']);
    expect(noPeriodCalls()).toEqual([
      [T, '2026-01-01', '2026-09-30', undefined, undefined, undefined, undefined, undefined, undefined, true],
      [T, '2026-09-01', '2026-09-30', undefined, undefined, undefined, undefined, undefined, undefined, true],
    ]);
    expect(api.getReportBudgetSummary.mock.calls).toEqual([
      [T, '2026-01-31', 12, 1],   // the grid: twelve months
      [T, '2026-01-31', 4, 3],    // the check: four quarters
    ]);
    expect(out.calls).toBe(3);
    expect(out.checks.map(c => c.calls)).toEqual([1, 1, 1]);
  });
});

describe('when Xero agrees', () => {
  test('every check matches every line, and the payload says what was checked', async () => {
    const out = await check();

    expect(out.ok).toBe(true);
    expect(out.cached).toBe(false);
    expect(out.checkedAt).toBe(new Date(NOW).toISOString());
    expect(out.checks.map(c => [c.key, c.label, c.skipped])).toEqual([
      ['span',     'closed span Jan – Sep 2026', false],
      ['month',    'September alone',            false],
      ['quarters', 'budget by quarter',          false],
    ]);
    // Twelve grid lines: seven the P&L carries, five budget-only ones the P&L
    // leaves out, whose nil actuals are what the omission means.
    for (const c of out.checks) {
      expect(c).toMatchObject({ lines: 12, matched: 12, differences: [], onlyInXero: [], onlyInApp: [], ok: true });
    }
    expect(findCheck(out, 'quarters').quarters).toBe(4);
    expect(out.period).toMatchObject({
      fromKey: '2026-01', toKey: '2026-12', months: 12, closedMonths: 9,
      closedFromLabel: 'Jan 2026', closedToLabel: 'Sep 2026', closedThroughISO: '2026-09-30',
      current: { key: '2026-10', label: 'Oct 2026', endISO: '2026-10-31' },
    });
    expect(out.currency).toBe('SGD');
    // The notes say what each check proves, in words.
    expect(out.notes[0]).toMatch(/^Jan – Sep 2026 asked for in one call, with no comparison periods, against the sum of the grid's monthly actuals/);
    expect(out.notes[0]).toMatch(/no month was cut short or shifted/);
    expect(out.notes[1]).toMatch(/^Sep 2026 asked for by its own dates/);
    expect(out.notes[2]).toMatch(/^Xero's Overall Budget by quarter, counted forward from Jan 2026/);
    expect(out.notes[3]).toMatch(/do not check a custom report layout/);
  });
});

describe('when the grid has slid', () => {
  test('a month\'s figure shifted in the periods-based answer is reported on that line, with the app\'s figure, Xero\'s and the difference', async () => {
    // The grid's P&L hands September's sales to October; the check's own calls
    // answer from the true table.
    const slid = mapValues(ACTUAL, v => [...v]);
    slid['Sales - Implementation'][9] = slid['Sales - Implementation'][8];
    slid['Sales - Implementation'][8] = 0;
    const base = api.getReportProfitAndLoss.getMockImplementation();
    api.getReportProfitAndLoss.mockImplementation(async (t, from, to, periods, ...rest) => (
      periods !== undefined
        ? reportOf(mapValues(slid, v => v.slice(idx(to) - periods, idx(to) + 1).reverse()))
        : base(t, from, to, periods, ...rest)));

    const out = await check();

    expect(out.ok).toBe(false);
    const span = findCheck(out, 'span'), month = findCheck(out, 'month');
    // Jan–Sep sales: the app lost September's 1,800.
    expect(span.differences).toEqual([{ section: 'Income', label: 'Sales - Implementation', app: 10800, xero: 12600, diff: -1800 }]);
    expect(span).toMatchObject({ lines: 12, matched: 11, ok: false, onlyInXero: [], onlyInApp: [] });
    expect(month.differences).toEqual([{ section: 'Income', label: 'Sales - Implementation', app: 0, xero: 1800, diff: -1800 }]);
    // The budget was not touched, so its check still agrees.
    expect(findCheck(out, 'quarters')).toMatchObject({ ok: true, differences: [] });
  });

  test('a quarter that disagrees names the quarter', async () => {
    const bent = mapValues(BUDGET, v => [...v]);
    bent['Bank Fees'][4] = 10.5;    // May, in the grid's monthly answer only
    const base = api.getReportBudgetSummary.getMockImplementation();
    api.getReportBudgetSummary.mockImplementation(async (t, date, periods, timeframe) => (
      timeframe === 1 ? reportOf(mapValues(bent, v => v.slice(idx(date), idx(date) + periods)), { header: 'Account' })
                      : base(t, date, periods, timeframe)));

    const out = await check();

    expect(findCheck(out, 'quarters').differences).toEqual([
      { section: 'Less Operating Expenses', label: 'Bank Fees', column: 'Apr – Jun 2026', app: 30.5, xero: 30, diff: 0.5 },
    ]);
    expect(out.ok).toBe(false);
  });

  test('a line on one side only is reported when it carries a figure, and not when it is nil', async () => {
    const base = api.getReportProfitAndLoss.getMockImplementation();
    api.getReportProfitAndLoss.mockImplementation(async (t, from, to, periods, ...rest) => {
      if (periods !== undefined || from !== '2026-01-01') return base(t, from, to, periods, ...rest);
      // The span answer has an income line the grid never saw, a nil line the
      // grid never saw, and no wages line at all.
      const values = mapValues(ACTUAL, v => [sum(v.slice(0, 9))]);
      delete values['Wages and Salaries'];
      return reportOf(values, { extra: [
        { section: 'Other Income', label: 'Interest Income',        values: [250] },
        { section: 'Other Income', label: 'Foreign Exchange Gain',  values: [0] },
      ] });
    });

    const out = await check();

    const span = findCheck(out, 'span');
    expect(span.onlyInXero).toEqual(['Interest Income']);
    expect(span.onlyInApp).toEqual(['Wages and Salaries']);
    // The budget-only accounts the P&L always leaves out are not findings.
    expect(span.onlyInApp).not.toContain('Cost of Goods Sold');
    expect(span.differences).toEqual([]);
    expect(span.ok).toBe(false);
    expect(out.ok).toBe(false);
    expect(findCheck(out, 'month').ok).toBe(true);
  });
});

describe('what cannot be checked is said, not assumed', () => {
  test('no closed month: the span and month checks are skipped with a reason, the budget is still checked, one call', async () => {
    at('2026-01-15T02:00:00Z');
    const out = await check();

    expect(noPeriodCalls()).toEqual([]);
    expect(out.calls).toBe(1);
    expect(findCheck(out, 'span')).toMatchObject({ skipped: true, calls: 0, reason: expect.stringMatching(/^No month of Jan 2026 – Dec 2026 has closed yet/) });
    expect(findCheck(out, 'month')).toMatchObject({ skipped: true, calls: 0 });
    expect(findCheck(out, 'quarters')).toMatchObject({ skipped: false, ok: true, lines: 12 });
    expect(out.ok).toBe(true);
    expect(out.notes[0]).toMatch(/has closed yet/);
    expect(out.period).toMatchObject({ closedMonths: 0, closedThroughISO: null, closedFromLabel: null });
  });

  test('one closed month: the span is that month alone and the second call is not made', async () => {
    at('2026-02-10T02:00:00Z');
    const out = await check();

    expect(noPeriodCalls()).toEqual([[T, '2026-01-01', '2026-01-31', undefined, undefined, undefined, undefined, undefined, undefined, true]]);
    expect(findCheck(out, 'span')).toMatchObject({ label: 'January alone', skipped: false, ok: true });
    expect(findCheck(out, 'month')).toMatchObject({ skipped: true, reason: expect.stringMatching(/^Only Jan 2026 has closed/) });
    expect(out.calls).toBe(2);
    expect(out.ok).toBe(true);
  });

  test('a trailing partial quarter is left out and said; whole quarters are asked for', async () => {
    const out = await check({ from: '2026-01', to: '2026-07' });

    expect(api.getReportBudgetSummary.mock.calls.at(-1)).toEqual([T, '2026-01-31', 2, 3]);
    const q = findCheck(out, 'quarters');
    expect(q).toMatchObject({ quarters: 2, ok: true, lines: 12 });
    expect(q.proves).toMatch(/Jul 2026 does not make a full quarter and is not in this check\.$/);
    expect(out.ok).toBe(true);
  });

  test('a period shorter than a quarter skips the budget check without a call', async () => {
    const out = await check({ from: '2026-08', to: '2026-09' });

    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);   // the grid's monthly call only
    expect(findCheck(out, 'quarters')).toMatchObject({ skipped: true, calls: 0, reason: expect.stringMatching(/shorter than a quarter/) });
    expect(findCheck(out, 'span')).toMatchObject({ label: 'closed span Aug – Sep 2026', ok: true });
    expect(out.calls).toBe(2);
  });
});

describe('a Xero failure', () => {
  test('rejects — there is no verdict, and nothing is cached', async () => {
    const base = api.getReportProfitAndLoss.getMockImplementation();
    api.getReportProfitAndLoss.mockImplementation(async (t, from, to, periods, ...rest) => {
      if (periods === undefined && from === '2026-09-01') throw new Error('Xero is down');
      return base(t, from, to, periods, ...rest);
    });

    await expect(check()).rejects.toThrow('Xero is down');
    expect([..._cache.keys()].some(k => k.startsWith('budgetcheck:'))).toBe(false);
    // The grid itself was fine and stays cached; only the check has no entry.
    expect([..._cache.keys()].some(k => k.startsWith('budgetvar:'))).toBe(true);
  });
});

describe('the cache', () => {
  test('a repeat inside ten minutes is the same verdict, with no new call', async () => {
    const first = await check();
    const again = await check();
    expect(again.cached).toBe(true);
    expect(again.checkedAt).toBe(first.checkedAt);
    expect(again.ok).toBe(true);
    expect(noPeriodCalls()).toHaveLength(2);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(2);
  });

  test('force refetches once the entry is past the grace window', async () => {
    await check();
    const key = [..._cache.keys()].find(k => k.startsWith('budgetcheck:'));
    expect(key).toBe(`budgetcheck:${U}:${T}:2026-01:2026-12:8`);
    _cache.get(key).fetchedAt -= FORCE_GRACE_MS + 1;

    const out = await check(YEAR, { force: true });
    expect(out.cached).toBe(false);
    expect(noPeriodCalls()).toHaveLength(4);
    expect(api.getReportBudgetSummary.mock.calls.filter(c => c[3] === 3)).toHaveLength(2);
  });

  test('a month closing is a new entry, not a stale hit', async () => {
    at('2026-09-30T23:58:00Z');
    await check();
    at('2026-10-01T00:01:00Z');
    const out = await check();
    expect(out.cached).toBe(false);
    expect(out.period.closedToLabel).toBe('Sep 2026');
    expect([..._cache.keys()].filter(k => k.startsWith('budgetcheck:'))).toHaveLength(2);
  });
});

describe('line identity (pure)', () => {
  test('the bottom lines are one line whichever sign Xero named them by', () => {
    expect(_lineName('Net Loss')).toBe('net profit');
    expect(_lineName('  Gross  Loss ')).toBe('gross profit');
    expect(_lineName('Net Profit Before Tax')).toBe('net profit before tax');
  });

  test('ranges are named as the screen names months', () => {
    const m = (key, label) => ({ key, label });
    expect(_rangeLabel(m('2026-01', 'Jan 2026'), m('2026-09', 'Sep 2026'))).toBe('Jan – Sep 2026');
    expect(_rangeLabel(m('2025-10', 'Oct 2025'), m('2026-09', 'Sep 2026'))).toBe('Oct 2025 – Sep 2026');
    expect(_rangeLabel(m('2026-09', 'Sep 2026'), m('2026-09', 'Sep 2026'))).toBe('Sep 2026');
  });

  test('a section total worded differently by the P&L is its section\'s one subtotal', () => {
    const rows = [
      { row: { kind: 'account',  section: 'Less Operating Expenses', label: 'Wages',          monthly: [] }, key: 'less operating expenses\u0000wages' },
      { row: { kind: 'subtotal', section: 'Less Operating Expenses', label: 'Total Operating Expenses', monthly: [] }, key: 'less operating expenses\u0000total operating expenses' },
    ];
    const lines = [
      { section: 'Less Operating Expenses', label: 'Wages',          kind: 'account',  values: [800] },
      { section: 'Less Operating Expenses', label: 'Total Expenses', kind: 'subtotal', values: [800] },
    ];
    const out = _compareLines(rows, lines, [{ app: () => 800 }]);
    expect(out).toEqual({ lines: 2, matched: 2, differences: [], onlyInXero: [], onlyInApp: [] });
  });

  test('a difference is a cent or more, after rounding', () => {
    const rows = [{ row: { kind: 'account', section: 'Income', label: 'Sales', monthly: [] }, key: 'income\u0000sales' }];
    const line = v => [{ section: 'Income', label: 'Sales', kind: 'account', values: [v] }];
    expect(_compareLines(rows, line(100.004), [{ app: () => 100 }]).differences).toEqual([]);
    expect(_compareLines(rows, line(100.01), [{ app: () => 100 }]).differences)
      .toEqual([{ section: 'Income', label: 'Sales', app: 100, xero: 100.01, diff: -0.01 }]);
  });
});
