const fs   = require('fs');
const path = require('path');

// The Dashboard's figures on the screen side. There is no React test setup in
// this project, so this follows invoice-tabs.test.js and reads the source — but
// the two pieces of arithmetic that matter, budget attainment and the
// "does not tie" wording, are written as self-contained functions so they can
// be lifted out of the file and actually run here.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

// The source of `export function NAME(...) { ... }`, by matching braces from
// its first one. Good for the plain functions it is used on, whose parameter
// lists hold no braces.
function functionSource(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1).replace(/^export /, '');
}
// Evaluates a lifted function, handing it whatever imports it uses by name.
function lift(rel, name, deps = {}) {
  const body = `${functionSource(read(rel), name)}\nreturn ${name};`;
  return new Function(...Object.keys(deps), body)(...Object.values(deps));
}

// The closed-month arithmetic in primitives.jsx, lifted with the helpers each
// one calls. useMemo is replaced by a call-through, so useRangeTotals can run
// without React.
const P = 'components/performance/primitives.jsx';
const closedSpan          = lift(P, 'closedSpan');
const closedSum           = lift(P, 'closedSum');
const closedCaption       = lift(P, 'closedCaption');
const closedAttainment    = lift(P, 'closedAttainment', { closedSpan, closedSum });
const closedVarianceItems = lift(P, 'closedVarianceItems', { closedSum });
const sum      = lift(P, 'sum');
const slice    = lift(P, 'slice');
const sliceSum = lift(P, 'sliceSum', { slice, sum });
const useRangeTotals = lift(P, 'useRangeTotals', { useMemo: f => f(), sliceSum, closedSpan, closedSum, closedAttainment });

describe('budget attainment counts closed months only', () => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .map(m => ({ label: `${m} 2026` }));
  // Four months closed on plan, May part-booked, nothing yet for June onwards.
  const actual = [10, 10, 10, 10, 6, 0, 0, 0, 0, 0, 0, 0];
  const budget = Array(12).fill(10);
  const d = { months, closedThroughIdx: 3, actualThroughIdx: 3 };

  test('a year on plan so far reads 100%, not the share of a full year of budget', () => {
    const a = closedAttainment(d, actual, budget, 0, 11);
    expect(a).toMatchObject({ months: 4, actual: 40, budget: 40, ratio: 1, throughLabel: 'Apr 2026' });
    // The old figure: everything booked over the whole year's budget.
    expect(actual.reduce((s, v) => s + v, 0) / budget.reduce((s, v) => s + v, 0)).toBeCloseTo(0.383, 3);
  });

  test('a range ending before the last closed month stops at the range', () => {
    expect(closedAttainment(d, actual, budget, 1, 2)).toMatchObject({ months: 2, ratio: 1, throughLabel: 'Mar 2026' });
  });

  test('no closed month in the range, or nothing budgeted for them, is null rather than 0% or 100%', () => {
    expect(closedAttainment(d, actual, budget, 4, 11)).toMatchObject({ months: 0, ratio: null, throughLabel: null });
    expect(closedAttainment(d, actual, Array(12).fill(0), 0, 11).ratio).toBeNull();
  });

  test('a payload without closedThroughIdx falls back to actualThroughIdx', () => {
    expect(closedAttainment({ months, actualThroughIdx: 1 }, actual, budget, 0, 11).months).toBe(2);
  });

  test('Overview and Revenue show this figure, not the whole range\'s', () => {
    const overview = read('components/performance/OverviewPanel.jsx');
    const revenue  = read('components/performance/RevenuePanel.jsx');
    expect(overview).toMatch(/T\.attainment/);
    expect(overview).not.toMatch(/T\.revenue \/ T\.revenueBudget/);
    expect(revenue).toMatch(/closedAttainment\(/);
    expect(revenue).not.toMatch(/total \/ totalB/);
  });
});

// ── Every "vs budget" figure on one basis: the closed months of the range ──
// The Budget tab compares closed months only. The dashboard summed its budget
// over the whole range, reached or not, and its actuals over the whole range,
// month in progress included — so in mid-August the two tabs gave different
// answers to "how are we doing against plan", and the Overview listed
// September's wages as a saving.
describe('useRangeTotals carries the closed-month basis beside the whole-range headline', () => {
  const months = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']
    .map((m, i) => ({ label: `${m} ${i < 9 ? 2026 : 2027}` }));
  // Apr–Jul closed, Aug part-booked, nothing from September on.
  const series = (closed, part) => Array.from({ length: 12 }, (_, i) => (i < 4 ? closed : i === 4 ? part : 0));
  const flat = v => Array(12).fill(v);
  const d = {
    months, closedThroughIdx: 3, actualThroughIdx: 3,
    totals: {
      revenue:     { actual: series(100, 40), budget: flat(100) },
      otherIncome: { actual: series(0, 0),    budget: flat(0) },
      cogs:        { actual: series(20, 5),   budget: flat(25) },
      // No gross line on this P&L: worked out from revenue and cost of sales.
      grossProfit: { actual: flat(0),         budget: flat(0) },
      opex:        { actual: series(50, 10),  budget: flat(50) },
      netProfit:   { actual: series(30, 25),  budget: flat(25) },
    },
    split: { recurring: { actual: series(60, 20) }, project: { actual: series(40, 20) } },
  };

  test('the whole financial year: headline includes August so far, the comparison stops at July', () => {
    const T = useRangeTotals(d, 0, 11);
    expect(T).toMatchObject({
      revenue: 440, netProfit: 145,
      closedMonths: 4, closedFromLabel: 'Apr 2026', closedThroughLabel: 'Jul 2026', openMonthLabel: 'Aug 2026', wholeMonths: 12,
      actualClosed: { revenue: 400, cogs: 80, opex: 200, netProfit: 120, grossProfit: 320 },
      budgetClosed: { revenue: 400, cogs: 100, opex: 200, netProfit: 100 },
      attainment: 1,
      // The whole period's plan, kept for the one line that shows it.
      revenueBudget: 1200, netProfitBudget: 300,
    });
    // The old comparison: part of a year's actuals against all of its budget.
    expect(T.netProfit - T.netProfitBudget).toBe(-155);
    expect(T.actualClosed.netProfit - T.budgetClosed.netProfit).toBe(20);
  });

  test('a range that is entirely closed: both bases agree and there is no open month', () => {
    const T = useRangeTotals(d, 1, 2);
    expect(T).toMatchObject({ revenue: 200, closedMonths: 2, closedFromLabel: 'May 2026', closedThroughLabel: 'Jun 2026', openMonthLabel: null, wholeMonths: 2 });
    expect(T.actualClosed.revenue).toBe(T.revenue);
    expect(T.budgetClosed.revenue).toBe(T.revenueBudget);
  });

  test('a range ending in the month in progress: closed months up to it, and it is named', () => {
    const T = useRangeTotals(d, 2, 4);
    expect(T).toMatchObject({ revenue: 240, closedMonths: 2, closedFromLabel: 'Jun 2026', closedThroughLabel: 'Jul 2026', openMonthLabel: 'Aug 2026' });
    expect(T.actualClosed.revenue).toBe(200);
    expect(T.budgetClosed.revenue).toBe(200);
  });

  test('no closed month in the range: nothing is compared, never -100%', () => {
    const T = useRangeTotals(d, 4, 11);
    expect(T).toMatchObject({ revenue: 40, closedMonths: 0, closedFromLabel: null, closedThroughLabel: null, openMonthLabel: 'Aug 2026', attainment: null });
    expect(Object.values(T.actualClosed).every(v => v === 0)).toBe(true);
    expect(Object.values(T.budgetClosed).every(v => v === 0)).toBe(true);
    // Months with nothing booked yet are not "in progress".
    expect(useRangeTotals(d, 5, 11).openMonthLabel).toBeNull();
  });

  test('closedSpan and its caption', () => {
    expect(closedSpan(d, 0, 11)).toEqual({ from: 0, to: 3, months: 4, fromLabel: 'Apr 2026', throughLabel: 'Jul 2026' });
    expect(closedSpan(d, 4, 11)).toEqual({ from: 4, to: 3, months: 0, fromLabel: null, throughLabel: null });
    expect(closedCaption(closedSpan(d, 0, 11))).toBe('Closed months: Apr 2026 – Jul 2026 (4)');
    expect(closedCaption(closedSpan(d, 3, 3))).toBe('Closed month: Jul 2026 (1)');
    expect(closedCaption(closedSpan(d, 4, 11))).toBe('No closed month yet in this period');
    // A loop over an empty span runs over nothing.
    expect(closedSum([1, 2, 3, 4, 5], closedSpan(d, 4, 11))).toBe(0);
    expect(closedSum([1, 2, 3, 4, 5], closedSpan(d, 1, 11))).toBe(9);
  });
});

describe('the variance lists are the closed months\' differences, biggest first', () => {
  const d = { months: Array.from({ length: 12 }, (_, i) => ({ label: `M${i}` })), closedThroughIdx: 3, actualThroughIdx: 3 };
  const at = (i, v) => Array.from({ length: 12 }, (_, k) => (k === i ? v : 0));
  const from = (i, v) => Array.from({ length: 12 }, (_, k) => (k >= i ? v : 0));
  const lines = [
    { label: 'Sales',  actual: at(3, 57330), budget: at(3, 50000) },
    { label: 'Wages',  actual: at(3, 24603), budget: from(3, 24603) },
    { label: 'Dust',   actual: [0.1, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], budget: [0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  ];

  test('next month\'s wages are no longer a saving, and float dust is not a difference', () => {
    // Financial year to date in mid-August: April to August selected.
    const items = closedVarianceItems(lines, closedSpan(d, 0, 4));
    expect(items).toEqual([{ label: 'Sales', a: 57330, b: 50000, v: 7330 }]);
    // What the whole range used to say about wages.
    expect(sliceSum(lines[1].actual, 0, 4) - sliceSum(lines[1].budget, 0, 4)).toBe(-24603);
  });

  test('nothing closed, nothing listed', () => {
    expect(closedVarianceItems(lines, closedSpan(d, 4, 11))).toEqual([]);
  });

  test('Overview, Analysis, Revenue and Profitability compare on this basis, with the months named', () => {
    const overview = read('components/performance/OverviewPanel.jsx');
    const analysis = read('components/performance/AnalysisPanel.jsx');
    const revenue  = read('components/performance/RevenuePanel.jsx');
    const profit   = read('components/performance/ProfitabilityPanel.jsx');
    for (const src of [overview, analysis]) {
      expect(src).toMatch(/closedVarianceItems\(\[\.\.\.data\.serviceLines, \.\.\.data\.expenseLines\], span\)/);
      expect(src).not.toMatch(/sliceSum\(l\.budget/);
    }
    expect(revenue).toMatch(/closedVarianceItems\(lines, span/);
    expect(revenue).toMatch(/closedSum\(l\.budget, span\)/);
    expect(revenue).not.toMatch(/sliceSum\(l\.budget/);
    expect(profit).toMatch(/varianceBridgeSteps\(T\.actualClosed, T\.budgetClosed\)/);
    expect(profit).not.toMatch(/sliceSum\(l\.budget/);
    // Overview's wording comes from closedCaption; the others also say it
    // where a figure would otherwise be.
    for (const src of [overview, analysis, revenue, profit]) expect(src).toMatch(/closedCaption\(/);
    for (const src of [analysis, revenue, profit]) expect(src).toMatch(/No closed month yet in this period/);
    expect(overview).toMatch(/Budget comparisons start when a month closes/);
  });

  test('the headline says it includes the month in progress wherever a budget figure sits beside it', () => {
    for (const f of ['OverviewPanel', 'RevenuePanel', 'ProfitabilityPanel']) {
      expect(read(`components/performance/${f}.jsx`)).toMatch(/incl\. \$\{(T\.openMonthLabel|open)\} so far/);
    }
  });

  test('the whole period\'s plan is shown once, on Profitability, labelled as the plan', () => {
    const profit = read('components/performance/ProfitabilityPanel.jsx');
    expect(profit).toMatch(/Plan for the whole period \(\{T\.wholeMonths\} month/);
    expect(profit).not.toMatch(/unearned/);
    for (const f of ['OverviewPanel', 'RevenuePanel', 'AnalysisPanel']) {
      const src = read(`components/performance/${f}.jsx`);
      expect(src).not.toMatch(/unearned/);
      expect(src).not.toMatch(/T\.(revenue|netProfit|cogs|opex|otherIncome|grossProfit)Budget\b/);
    }
  });
});

describe('debtor days on the Overview are the server\'s figure', () => {
  const overview = read('components/performance/OverviewPanel.jsx');

  test('it reads data.paymentDays and works out no ratio of its own', () => {
    expect(overview).toMatch(/data\.paymentDays/);
    expect(overview).not.toMatch(/30\.44/);
    expect(overview).not.toMatch(/receivables\s*\/\s*T\.revenue/);
  });

  test('its note uses overdue receivables, never the old combined overdue figure', () => {
    expect(overview).toMatch(/overdueReceivables/);
    expect(overview).not.toMatch(/overdueAmount/);
  });
});

describe('the Overdue card shows receivables and payables as two labelled figures', () => {
  const page = read('pages/XeroInsights.jsx');
  test('both figures are rendered, and the summed one is gone', () => {
    expect(page).toMatch(/kpis\.overdueReceivables/);
    expect(page).toMatch(/kpis\.overduePayables/);
    expect(page).not.toMatch(/overdueAmount/);
    expect(page).toMatch(/Customers owe you/);
    expect(page).toMatch(/You owe suppliers/);
  });
});

describe('the "does not tie" note says which way the gap runs', () => {
  const fmtMoney = v => `$${Number(v).toFixed(2)}`;
  const unreconciledText = lift('components/performance/CashFlowPanel.jsx', 'unreconciledText', { fmtMoney });

  test('records showing more than the bank: recorded in Xero but not in the bank', () => {
    const t = unreconciledText({ inGap: 450, outGap: 0 }, 'SGD');
    expect(t).toMatch(/\$450\.00 of receipts recorded in Xero but not in the bank/);
    expect(t).not.toMatch(/payments/);
  });

  test('the bank showing more than the records: no payment record behind it', () => {
    const t = unreconciledText({ inGap: 0, outGap: -240 }, 'SGD');
    expect(t).toMatch(/\$240\.00 of payments in the bank accounts' totals with no payment or bank transaction/);
    expect(t).not.toMatch(/recorded in Xero but not/);
  });

  test('both directions at once are each described their own way; rounding is not mentioned', () => {
    const t = unreconciledText({ inGap: 450, outGap: -240 }, 'SGD');
    expect(t).toMatch(/receipts recorded in Xero but not in the bank.*payments in the bank accounts' totals/s);
    expect(unreconciledText({ inGap: 0.5, outGap: -300 }, 'SGD')).not.toMatch(/receipts/);
  });
});
