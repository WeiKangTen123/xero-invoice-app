const fs   = require('fs');
const path = require('path');

// The comparison with the same months last year, on the screen side. There is
// no React test setup in this project, so this follows
// dashboard-figures-ui.test.js: the arithmetic and the wording are plain
// functions in primitives.jsx, lifted out of the file and run here — against
// a payload the server's own builder made, so the two cannot drift apart —
// and the wiring is checked in the source.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function functionSource(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1).replace(/^export /, '');
}
function lift(rel, name, deps = {}) {
  const body = `${functionSource(read(rel), name)}\nreturn ${name};`;
  return new Function(...Object.keys(deps), body)(...Object.values(deps));
}

const PRIMITIVES = 'components/performance/primitives.jsx';
const fmtMoney = (v, cur) => `${cur ? `${cur} ` : ''}${Number(v).toFixed(2)}`;
const fmtPct   = (f, dp = 1) => `${(Number(f) * 100).toFixed(dp)}%`;
const priorYearRange  = lift(PRIMITIVES, 'priorYearRange');
const changeText      = lift(PRIMITIVES, 'changeText', { fmtMoney, fmtPct });
const comparedText    = lift(PRIMITIVES, 'comparedText');
const priorYearReason = lift(PRIMITIVES, 'priorYearReason');

// A payload as the server builds it: Jan–Oct 2026 with Jan–Sep closed.
const { _buildPriorYear } = require('../xero/performance');
const { _monthsBetween }  = require('../xero/periods');
const months = _monthsBetween('2026-01', '2026-10');
const series = actual => ({ actual, budget: actual.map(() => 0) });
const totalsOf = (rev, cogs, opex) => ({
  revenue: series(rev), otherIncome: series(rev.map(() => 0)), cogs: series(cogs),
  grossProfit: series(rev.map((r, i) => r - cogs[i])), opex: series(opex),
  netProfit: series(rev.map((r, i) => r - cogs[i] - opex[i])),
});
const thisYear = totalsOf([...Array(9).fill(1100), 300], Array(10).fill(100), [...Array(9).fill(500), 50]);
function payload(prior) {
  return {
    months, closedThroughIdx: 8, totals: thisYear,
    priorYear: _buildPriorYear({ months, current: thisYear, prior, closed: 9, priorClosed: 10 }),
  };
}
const lastYear = totalsOf(Array(10).fill(1000), Array(10).fill(100), Array(10).fill(400));

describe('priorYearRange — the server\'s comparison, for the selected range', () => {
  test('over the whole period it gives exactly the server\'s figures', () => {
    const d = payload(lastYear);
    const c = priorYearRange(d, 0, 9);
    for (const k of ['revenue', 'grossProfit', 'opex', 'netProfit']) {
      const t = d.priorYear.totals[k];
      expect({ k, ...c[k] }).toEqual({ k, prior: t.total, current: t.thisYearTotal, change: t.change, pct: t.pct });
    }
    expect(c).toMatchObject({ available: true, count: 9, fromLabel: 'Jan 2026', toLabel: 'Sep 2026',
                              priorFromLabel: 'Jan 2025', priorToLabel: 'Sep 2025', recordsFromLabel: null });
  });

  test('a narrower range re-sums only its own compared months, and never the open one', () => {
    const c = priorYearRange(payload(lastYear), 6, 9);   // Jul–Oct: October has not closed
    expect(c).toMatchObject({ count: 3, fromLabel: 'Jul 2026', toLabel: 'Sep 2026' });
    expect(c.revenue).toEqual({ prior: 3000, current: 3300, change: 300, pct: 0.1 });
  });

  test('a range of open months only has nothing to compare, and says so', () => {
    expect(priorYearRange(payload(lastYear), 9, 9)).toEqual({ available: false, reason: 'none-in-range' });
  });

  test('no percentage from a zero or negative base: the amount is given instead', () => {
    const c = priorYearRange(payload(totalsOf(Array(10).fill(0), Array(10).fill(0), Array(10).fill(400))), 0, 9);
    expect(c.revenue).toMatchObject({ prior: 0, pct: null, change: 9900 });
    expect(c.netProfit).toMatchObject({ prior: -3600, pct: null, change: 8100 });
    expect(changeText(c.revenue, 'SGD')).toBe('+SGD 9900.00');
    expect(changeText(c.netProfit, 'SGD')).toBe('+SGD 8100.00');
    expect(changeText(c.opex, 'SGD')).toBe('+25.0%');
  });

  test('where last year\'s records begin is said when it cut the range short', () => {
    const late = totalsOf([0, 0, ...Array(8).fill(1000)], [0, 0, ...Array(8).fill(100)], [0, 0, ...Array(8).fill(400)]);
    const d = payload(late);
    expect(priorYearRange(d, 0, 9)).toMatchObject({ count: 7, fromLabel: 'Mar 2026', recordsFromLabel: 'Mar 2025' });
    expect(priorYearRange(d, 4, 9).recordsFromLabel).toBeNull();   // the range starts after it
  });

  test('no comparison in the report, and one the server could not give, are told apart', () => {
    expect(priorYearRange({ months }, 0, 9)).toBeNull();
    expect(priorYearRange({ months, priorYear: { available: false, reason: 'no-data' } }, 0, 9))
      .toEqual({ available: false, reason: 'no-data' });
  });
});

describe('the wording', () => {
  test('a change reads +12.3% or -4.0%, with the sign of the change', () => {
    expect(changeText({ change: 123, pct: 0.123 }, 'SGD')).toBe('+12.3%');
    expect(changeText({ change: -40, pct: -0.04 }, 'SGD')).toBe('-4.0%');
    expect(changeText({ change: 0, pct: 0 }, 'SGD')).toBe('0.0%');
    expect(changeText({ change: -250, pct: null }, 'SGD')).toBe('-SGD 250.00');
  });

  test('the months compared, a span or a single month', () => {
    expect(comparedText({ fromLabel: 'Jan 2026', toLabel: 'Sep 2026', priorFromLabel: 'Jan 2025', priorToLabel: 'Sep 2025' }))
      .toBe('Jan 2026 – Sep 2026 against Jan 2025 – Sep 2025');
    expect(comparedText({ fromLabel: 'Sep 2026', toLabel: 'Sep 2026', priorFromLabel: 'Sep 2025', priorToLabel: 'Sep 2025' }))
      .toBe('Sep 2026 against Sep 2025');
  });

  test('every reason the server gives has its own sentence', () => {
    const reasons = ['no-closed-month', 'none-in-range', 'no-data', 'out-of-range', 'unavailable'];
    const texts = reasons.map(priorYearReason);
    expect(new Set(texts).size).toBe(reasons.length);
    expect(priorYearReason('no-data')).toMatch(/nothing was recorded/);
  });
});

describe('the wiring', () => {
  const page = read('pages/XeroInsights.jsx');
  const overview = read('components/performance/OverviewPanel.jsx');
  const profit = read('components/performance/ProfitabilityPanel.jsx');

  test('only Overview and Profitability ask for last year, and nowhere else sets the flag', () => {
    expect(page).toMatch(/const COMPARE_TABS = \['overview', 'profit'\];/);
    expect(page).toMatch(/if \(COMPARE_TABS\.includes\(tab\)\) params\.set\('compare', 'prior-year'\);/);
    expect(page.match(/\.set\('compare'/g)).toHaveLength(1);
  });

  test('arriving on either with a report that has no comparison asks again, for the figures only, and never loops', () => {
    expect(page).toMatch(/if \(params\.has\('compare'\)\) compareReply\.current = d;/);
    expect(page).toMatch(/if \(d === compareReply\.current\) return;/);
    expect(page).toMatch(/fetchPerf\(\{ figuresOnly: true \}\)/);
    expect(page).toMatch(/if \(opts\.figuresOnly\) return;/);
  });

  test('the Overview tiles carry the comparison, and "needs a full prior year" is only the fallback', () => {
    expect(overview).toMatch(/priorYearRange\(data, from, to\)/);
    for (const k of ['revenue', 'grossProfit', 'netProfit']) expect(overview).toMatch(new RegExp(`pyLine\\('[^']*', '${k}'\\)`));
    expect(overview).toMatch(/g\.yoyLabel \|\| !py \?/);
  });

  test('Profitability draws last year\'s net profit as a dashed line, with a key', () => {
    expect(profit).toMatch(/<PriorYearBars/);
    expect(profit).toMatch(/py\.totals\.netProfit\.monthly/);
    expect(profit).toMatch(/dashed: true/);
    expect(read('components/performance/charts.jsx')).toMatch(/strokeDasharray="5 4"/);
  });
});
