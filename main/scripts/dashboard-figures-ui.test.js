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

describe('budget attainment counts closed months only', () => {
  const closedAttainment = lift('components/performance/primitives.jsx', 'closedAttainment');
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
