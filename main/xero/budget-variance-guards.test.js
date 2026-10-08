// Guards on the Budget vs Actual builder for what lies outside the one layout
// the live fixtures in reports.test.js pin: the section titles Xero's other
// regional layouts use, a section both reports have but whose total they name
// differently, a label that sits on both sides of the P&L, a report with fewer
// columns than the months asked for, a "Net Profit Before Tax" above the
// bottom line, cells that are not strings, and a chunk that fails while
// another is in flight. Every report here is in Xero's shape — a Header row,
// Section/Row/SummaryRow, string cells, the P&L newest-first — and nothing
// leaves the process.
const logger = require('../utils/logger');
const {
  _buildBudgetVariance, _reportLines, _mapWithConcurrency, _netRow, _sectionKind,
} = require('./budget-variance');
const { _parseReportNumber } = require('./report-fetch');
const { _monthsBetween } = require('./periods');

const cell    = value => ({ value });
const money   = v => (v < 0 ? `(${Math.abs(v).toFixed(2)})` : v.toFixed(2));
const line    = (label, vals, rowType = 'Row') => ({ rowType, cells: [label, ...vals.map(money)].map(cell) });
// ProfitAndLoss answers newest-first. Fixtures are written oldest-first and
// flipped here, so both reports read the same way below.
const pLine   = (label, vals, rowType = 'Row') => line(label, [...vals].reverse(), rowType);
const section = (title, rows) => ({ rowType: 'Section', title, rows });
const bHeader = { rowType: 'Header', cells: ['Account', 'Jan-26', 'Feb-26', 'Mar-26'].map(cell) };
const pHeader = { rowType: 'Header', cells: ['', '31 Mar 26', '28 Feb 26', '31 Jan 26'].map(cell) };

const months  = _monthsBetween('2026-01', '2026-03');
const build   = (budget, pnl, actualThroughIdx = 1) =>
  _buildBudgetVariance({ budgetRows: [bHeader, ...budget], pnlRows: [pHeader, ...pnl], months, actualThroughIdx });
const at      = (rows, sec, label) => rows.filter(r => r.section === sec && r.label === label);
const one     = (rows, sec, label) => { const m = at(rows, sec, label); expect(m).toHaveLength(1); return m[0]; };
const actuals = r => r.monthly.map(m => m.actual);
const budgets = r => r.monthly.map(m => m.budget);

// ── 1. Section titles across Xero's regional layouts ─────────────────────────
describe('budget variance guards — section titles Xero uses elsewhere', () => {
  test.each([
    ['Income', 'revenue'], ['Trading Income', 'revenue'], ['Sales', 'revenue'], ['Revenue', 'revenue'], ['Turnover', 'revenue'],
    ['Less Cost of Sales', 'cogs'], ['Less Cost of Goods Sold', 'cogs'], ['Less Direct Costs', 'cogs'],
    ['Cost of Sales', 'cogs'], ['Cost of Goods Sold', 'cogs'], ['Direct Costs', 'cogs'],
    ['Less Operating Expenses', 'opex'], ['Expenses', 'opex'], ['Less Expenses', 'opex'], ['Operating Expenses', 'opex'],
    ['Overheads', 'opex'], ['Less Overheads', 'opex'], ['Administrative Expenses', 'opex'],
    ['Other Expenses', 'otherExpense'], ['Less Other Expenses', 'otherExpense'], ['Less Depreciation', 'otherExpense'],
    ['Depreciation', 'otherExpense'], ['Less Income Tax', 'otherExpense'], ['Income Tax', 'otherExpense'],
    ['Taxation', 'otherExpense'], ['Finance Costs', 'otherExpense'], ['Interest Expense', 'otherExpense'],
    ['Other Income', 'otherIncome'], ['Plus Other Income', 'otherIncome'],
    ['', 'other'], [undefined, 'other'], ['Equity', 'other'],
  ])('%s reads as %s', (title, kind) => {
    expect(_sectionKind(title)).toBe(kind);
  });

  test('"Less Income Tax" is a cost, not revenue, and every line of an other-expense section is coloured as one', () => {
    const { rows, kpis } = build([
      section('Turnover',          [line('Sales', [100, 100, 100]), line('Total Turnover', [100, 100, 100], 'SummaryRow')]),
      section('',                  [line('Net Profit Before Tax', [100, 100, 100], 'SummaryRow')]),
      section('Less Income Tax',   [line('Corporation Tax', [17, 17, 17]), line('Total Income Tax', [17, 17, 17], 'SummaryRow')]),
      section('',                  [line('Net Profit', [83, 83, 83], 'SummaryRow')]),
    ], [
      section('Turnover',          [pLine('Sales', [90, 110, 0]), pLine('Total Turnover', [90, 110, 0], 'SummaryRow')]),
      section('',                  [pLine('Net Profit Before Tax', [90, 110, 0], 'SummaryRow')]),
      section('Less Income Tax',   [pLine('Corporation Tax', [15, 19, 0]), pLine('Total Income Tax', [15, 19, 0], 'SummaryRow')]),
      section('',                  [pLine('Net Profit', [75, 91, 0], 'SummaryRow')]),
    ]);
    expect(one(rows, 'Less Income Tax', 'Corporation Tax')).toMatchObject({ expense: true, kind: 'account' });
    expect(one(rows, 'Less Income Tax', 'Total Income Tax')).toMatchObject({ expense: true, kind: 'subtotal' });
    expect(one(rows, 'Turnover', 'Sales').expense).toBe(false);
    expect(rows.find(r => r.kind === 'section' && r.label === 'Less Income Tax').expense).toBe(false);
    // The bottom line is the last one, not the pre-tax line above it.
    expect(kpis).toMatchObject({ ytdActualNet: 166, forecastNet: 249 });
  });
});

// ── 2. A shared section whose total the two reports name differently ─────────
describe('budget variance guards — one section, two names for its total', () => {
  test('the P&L\'s "Total Expenses" is the budget\'s "Total Operating Expenses", not a second subtotal', () => {
    const { rows } = build([
      section('Expenses', [line('Rent', [50, 50, 50]), line('Total Operating Expenses', [50, 50, 50], 'SummaryRow')]),
      section('',         [line('Net Profit', [-50, -50, -50], 'SummaryRow')]),
    ], [
      section('Expenses', [pLine('Rent', [55, 45, 0]), pLine('Total Expenses', [55, 45, 0], 'SummaryRow')]),
      section('',         [pLine('Net Profit', [-55, -45, 0], 'SummaryRow')]),
    ]);
    expect(rows.map(r => r.label)).toEqual(['Expenses', 'Rent', 'Total Operating Expenses', 'Net Profit']);
    const total = one(rows, 'Expenses', 'Total Operating Expenses');
    expect(actuals(total)).toEqual([55, 45, 0]);
    expect(budgets(total)).toEqual([50, 50, 50]);
    expect(total).toMatchObject({ kind: 'subtotal', expense: true, unbudgeted: false });
  });

  test('…only when the section has exactly one total left to claim', () => {
    // Two subtotals in the budget's section: which one "Total Expenses" is
    // cannot be known, so it is added rather than guessed.
    const { rows } = build([
      section('Expenses', [line('Rent', [50, 50, 50]), line('Total Fixed', [50, 50, 50], 'SummaryRow'), line('Total Operating Expenses', [50, 50, 50], 'SummaryRow')]),
    ], [
      section('Expenses', [pLine('Rent', [55, 45, 0]), pLine('Total Expenses', [55, 45, 0], 'SummaryRow')]),
    ]);
    expect(rows.map(r => r.label)).toEqual(['Expenses', 'Rent', 'Total Fixed', 'Total Operating Expenses', 'Total Expenses']);
    expect(one(rows, 'Expenses', 'Total Expenses')).toMatchObject({ unbudgeted: true });
    expect(actuals(one(rows, 'Expenses', 'Total Operating Expenses'))).toEqual([0, 0, 0]);
  });

  test('an account under the shared section is still never matched by label alone', () => {
    const { rows } = build([
      section('Income',   [line('Consulting', [100, 100, 100])]),
      section('Expenses', [line('Rent', [50, 50, 50])]),
    ], [
      section('Expenses', [pLine('Rent', [50, 50, 0]), pLine('Consulting', [7, 8, 0])]),
    ]);
    expect(actuals(one(rows, 'Income', 'Consulting'))).toEqual([0, 0, 0]);
    expect(one(rows, 'Expenses', 'Consulting')).toMatchObject({ unbudgeted: true, expense: true });
  });
});

// ── 3. The label-only fallback keeps to one side of the P&L ──────────────────
describe('budget variance guards — a label on both sides of the P&L', () => {
  test('an expense "Consulting" never lands on an income "Consulting", even with no expense section budgeted', () => {
    const { rows } = build([
      section('Income', [line('Consulting', [100, 100, 100]), line('Total Income', [100, 100, 100], 'SummaryRow')]),
      section('',       [line('Net Profit', [100, 100, 100], 'SummaryRow')]),
    ], [
      section('Income',                  [pLine('Consulting', [90, 110, 0]), pLine('Total Income', [90, 110, 0], 'SummaryRow')]),
      section('Less Operating Expenses', [pLine('Consulting', [25, 15, 0]), pLine('Total Operating Expenses', [25, 15, 0], 'SummaryRow')]),
      section('',                        [pLine('Net Profit', [65, 95, 0], 'SummaryRow')]),
    ]);
    expect(actuals(one(rows, 'Income', 'Consulting'))).toEqual([90, 110, 0]);
    expect(one(rows, 'Less Operating Expenses', 'Consulting')).toMatchObject({ unbudgeted: true, expense: true });
    expect(actuals(one(rows, 'Less Operating Expenses', 'Consulting'))).toEqual([25, 15, 0]);
  });

  test('…and when the P&L has the expense "Consulting" only, it is still not the income one', () => {
    const { rows } = build([
      section('Income', [line('Consulting', [100, 100, 100])]),
    ], [
      section('Less Operating Expenses', [pLine('Consulting', [25, 15, 0])]),
    ]);
    expect(actuals(one(rows, 'Income', 'Consulting'))).toEqual([0, 0, 0]);
    expect(one(rows, 'Less Operating Expenses', 'Consulting')).toMatchObject({ unbudgeted: true, expense: true, cells: [25, 15, 0] });
  });

  test('a retitled section on the same side still matches by label, and an unclassified title matches either side', () => {
    const { rows } = build([
      section('Less Operating Expenses', [line('Rent', [50, 50, 50])]),
      section('Sundries',                [line('Postage', [5, 5, 5])]),
    ], [
      section('Overheads',               [pLine('Rent', [55, 45, 0])]),
      section('Less Other Expenses',     [pLine('Postage', [4, 6, 0])]),
    ]);
    expect(actuals(one(rows, 'Less Operating Expenses', 'Rent'))).toEqual([55, 45, 0]);
    expect(actuals(one(rows, 'Sundries', 'Postage'))).toEqual([4, 6, 0]);
    expect(rows.filter(r => r.unbudgeted)).toHaveLength(0);
  });
});

// ── 4. A report with fewer columns than months ───────────────────────────────
describe('budget variance guards — a report shorter than the months asked for', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  test('the P&L\'s missing columns are its oldest; the budget\'s are its newest; one warning per report', () => {
    // Three months asked for. The P&L answers newest-first with Mar and Feb
    // only; the budget oldest-first with Jan and Feb only.
    const { rows } = build([
      section('Income', [line('Sales', [5, 6]), line('Total Income', [5, 6], 'SummaryRow')]),
      section('',       [line('Net Profit', [5, 6, 7], 'SummaryRow')]),
    ], [
      section('Income', [pLine('Sales', [10, 20]), pLine('Total Income', [10, 20, 30], 'SummaryRow')]),
      section('',       [pLine('Net Profit', [10, 20, 30], 'SummaryRow')]),
    ]);
    const sales = one(rows, 'Income', 'Sales');
    expect(actuals(sales)).toEqual([0, 10, 20]);      // Jan is the column the P&L left out
    expect(budgets(sales)).toEqual([5, 6, 0]);        // Mar is the column the budget left out
    expect(actuals(one(rows, 'Income', 'Total Income'))).toEqual([10, 20, 30]);
    expect(budgets(one(rows, '', 'Net Profit'))).toEqual([5, 6, 7]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(c => c[1])).toEqual([
      expect.objectContaining({ lines: 2, of: 3, columns: 3, newestFirst: false }),
      expect.objectContaining({ lines: 1, of: 3, columns: 3, newestFirst: true }),
    ]);
  });

  test('a line with no figures at all reads as nil throughout, and nothing throws', () => {
    expect(() => build([section('Income', [{ rowType: 'Row', cells: [cell('Sales')] }])], [
      section('Income', [{ rowType: 'Row', cells: [cell('Sales')] }]),
    ])).not.toThrow();
    const { rows } = build([section('Income', [{ rowType: 'Row', cells: [cell('Sales')] }])], []);
    expect(one(rows, 'Income', 'Sales')).toMatchObject({ cells: [0, 0, 0] });
  });

  test('without a column count _reportLines leaves the values as they came, and says nothing', () => {
    const lines = _reportLines([pHeader, section('Income', [pLine('Sales', [10, 20])])], { reverse: true });
    expect(lines[0].values).toEqual([10, 20]);
    expect(_reportLines([bHeader, section('Income', [line('Sales', [5, 6, 7])])], { n: 3 })[0].values).toEqual([5, 6, 7]);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ── 5. The bottom line by its whole name ─────────────────────────────────────
describe('budget variance guards — the bottom line', () => {
  const summary = label => ({ kind: 'summary', label, section: '' });

  test('"Net Profit Before Tax" is not the bottom line when a "Net Profit" follows it', () => {
    expect(_netRow([summary('Net Profit Before Tax'), summary('Net Profit')]).label).toBe('Net Profit');
    expect(_netRow([summary('Net Loss Before Tax'), summary('Net Loss')]).label).toBe('Net Loss');
  });

  test('…and when nothing is named "Net Profit", the last floating summary line is', () => {
    expect(_netRow([summary('Net Profit Before Tax'), summary('Profit after tax')]).label).toBe('Profit after tax');
    expect(_netRow([summary('Net Profit Before Tax')]).label).toBe('Net Profit Before Tax');
  });

  test('case and spacing do not matter', () => {
    expect(_netRow([summary('Gross Profit'), summary(' net  LOSS ')]).label).toBe(' net  LOSS ');
  });
});

// ── 6. Cells that are not strings ────────────────────────────────────────────
describe('budget variance guards — report cells that are not strings', () => {
  test('a number is read as itself, anything else unreadable as nil, and nothing throws', () => {
    expect(_parseReportNumber(1234.5)).toBe(1234.5);
    expect(_parseReportNumber(-3)).toBe(-3);
    expect(_parseReportNumber(0)).toBe(0);
    expect(_parseReportNumber(NaN)).toBe(0);
    expect(_parseReportNumber(Infinity)).toBe(0);
    expect(_parseReportNumber(null)).toBe(0);
    expect(_parseReportNumber(undefined)).toBe(0);
    expect(_parseReportNumber({})).toBe(0);
    expect(_parseReportNumber(['1', '2'])).toBe(0);
    expect(_parseReportNumber(new Date(0))).toBe(0);
    // Xero's own strings still read as before.
    expect(_parseReportNumber('1,234.50')).toBe(1234.5);
    expect(_parseReportNumber('(1,234.50)')).toBe(-1234.5);
    expect(_parseReportNumber('')).toBe(0);
    expect(_parseReportNumber('abc')).toBe(0);
  });

  test('a report whose cells are numbers builds', () => {
    const numeric = (label, vals) => ({ rowType: 'Row', cells: [cell(label), ...vals.map(cell)] });
    const { rows } = build([section('Income', [numeric('Sales', [1, 2, 3])])], [section('Income', [numeric('Sales', [30, 20, 10])])]);
    const sales = one(rows, 'Income', 'Sales');
    expect(budgets(sales)).toEqual([1, 2, 3]);
    expect(actuals(sales)).toEqual([10, 20, 30]);
  });
});

// ── 10. A chunk that fails while another is in flight ────────────────────────
describe('budget variance guards — bounded concurrency after a failure', () => {
  const tick = () => new Promise(r => setImmediate(r));

  test('no further item is started, the one in flight finishes, and the first error is what comes back', async () => {
    const started = [], finished = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const p = _mapWithConcurrency([1, 2, 3, 4, 5], 2, async x => {
      started.push(x);
      if (x === 1) throw new Error('chunk 1 failed');
      if (x === 2) await gate;
      finished.push(x);
      return x;
    });
    p.catch(() => {});   // judged below; this keeps the rejection from being unhandled meanwhile
    await tick();
    expect(started).toEqual([1, 2]);   // 3, 4 and 5 were never begun
    expect(finished).toEqual([]);
    release();
    await expect(p).rejects.toThrow('chunk 1 failed');
    expect(finished).toEqual([2]);     // the one in flight was left to finish
    expect(started).toEqual([1, 2]);
  });

  test('of two failures the first is reported, and a thrown non-error still counts', async () => {
    await expect(_mapWithConcurrency([1, 2], 2, async x => {
      if (x === 1) throw new Error('first');
      await tick();
      throw new Error('second');
    })).rejects.toThrow('first');
    await expect(_mapWithConcurrency([1, 2, 3], 1, async x => { if (x === 2) throw undefined; return x; })).rejects.toBeUndefined();
  });

  test('a failure in the last item still rejects, and a run with none still keeps order', async () => {
    await expect(_mapWithConcurrency([1, 2, 3], 2, async x => { if (x === 3) throw new Error('last'); return x; })).rejects.toThrow('last');
    expect(await _mapWithConcurrency([3, 2, 1], 2, async x => { await new Promise(r => setTimeout(r, x * 3)); return x; })).toEqual([3, 2, 1]);
  });
});
