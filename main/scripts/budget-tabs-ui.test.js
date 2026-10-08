const fs   = require('fs');
const path = require('path');
const doc  = require('../reports/budget-doc');

// The budget tabs on the screen side. There is no React test setup in this
// project, so this follows dashboard-figures-ui.test.js: the decisions that
// matter — which months can be chosen, what the month in progress is called,
// how a running total is headed — are plain functions in bits.jsx, lifted out
// of the file and run here, and the wiring is checked in the source. The
// exports word the same things in budget-doc.js, so the two are compared.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');
const BITS = 'pages/xero-insights/bits.jsx';

// The source of one `function NAME(...) { ... }`, exported or not, by matching
// braces from the body's first one — found after the parameter list's closing
// bracket, since a destructured option with a default holds braces of its own;
// and of one single-line `const NAME = ...;`.
function functionSource(src, name) {
  const start = src.search(new RegExp(`^(export )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1).replace(/^export /, '');
}
function constSource(src, name) {
  const m = new RegExp(`^const ${name} = [^\\n]*;$`, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}
// The helpers as one module, so each can call the others as it does in the file.
function liftModule(rel, consts, fns) {
  const src  = read(rel);
  const body = [...consts.map(c => constSource(src, c)), ...fns.map(f => functionSource(src, f))].join('\n');
  return new Function(`${body}\nreturn { ${fns.join(', ')} };`)();
}

const bits = liftModule(BITS, ['MONTH_ABBR', 'MONTH_FULL'],
  ['dayLabel', 'monthName', 'soFarRead', 'soFarCaption', 'monthSelectable', 'varianceSelection', 'cumulativeLabel']);

// A financial year as the server sends it on 8 Oct 2026: Apr–Sep closed,
// October in progress, November onward budget only.
const LABELS = ['Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026',
  'Oct 2026', 'Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027', 'Mar 2027'];
const KEYS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
const cm = { key: '2026-10', label: 'Oct 2026', asOf: '2026-10-08', actualNet: 240, budgetNet: 0 };
const year = {
  period: { key: 'fy', toDateLabel: 'Year to date', closedFromLabel: 'Apr 2026', closedToLabel: 'Sep 2026' },
  months: LABELS.map((label, i) => ({ key: KEYS[i], label, source: i < 6 ? 'actual' : 'budget', current: i === 6 })),
  kpis: { monthsElapsed: 6, currentMonth: cm },
};
const quarter = {
  ...year,
  period: { key: 'last-quarter', toDateLabel: 'Period to date', closedFromLabel: 'Jul 2026', closedToLabel: 'Sep 2026' },
  months: year.months.slice(3, 7),
  kpis: { monthsElapsed: 3, currentMonth: cm },
};

describe('which months of the Budget Variance report can be chosen', () => {
  test('a closed month and the month in progress can; a budget month after it cannot', () => {
    expect(bits.monthSelectable(year.months[5])).toBe(true);     // Sep, closed
    expect(bits.monthSelectable(year.months[6])).toBe(true);     // Oct, in progress
    expect(bits.monthSelectable(year.months[7])).toBe(false);    // Nov
    expect(bits.monthSelectable(year.months[11])).toBe(false);   // Mar 2027
    expect(bits.monthSelectable(undefined)).toBe(false);
  });

  test('a payload from before months said which they were is not locked out', () => {
    expect(bits.monthSelectable({ key: '2026-11', label: 'Nov 2026' })).toBe(true);
  });

  test('the screen and the export apply one rule', () => {
    for (const m of year.months) expect(bits.monthSelectable(m)).toBe(doc.monthStarted(m));
  });
});

describe('what the tab shows for a selection', () => {
  test('a month that can be chosen is shown as chosen', () => {
    expect(bits.varianceSelection(year, '2026-09')).toBe('2026-09');
    expect(bits.varianceSelection(year, '2026-10')).toBe('2026-10');
    expect(bits.varianceSelection(year, 'ytd')).toBe('ytd');
  });

  test('a month that has not started falls back to the rollup, as the period changing under it leaves one', () => {
    expect(bits.varianceSelection(year, '2026-11')).toBe('ytd');
    expect(bits.varianceSelection(year, '2027-03')).toBe('ytd');
  });

  test('a key that is not in the report, or no report yet, is the rollup — as the export resolves it', () => {
    expect(bits.varianceSelection(year, '2025-01')).toBe('ytd');
    expect(bits.varianceSelection(null, '2026-09')).toBe('ytd');
    expect(bits.varianceSelection(year, undefined)).toBe('ytd');
    expect(doc.resolveMonth(year, '2025-01')).toBe('ytd');
  });
});

// The figure for the month in progress is the whole month's P&L as Xero held
// it on the day it was read — an invoice dated the 25th is in it on the 8th.
// "Booked in Xero as of 8 Oct" read as the 1st to the 8th, which it never was.
describe('the caption for the month in progress', () => {
  test('says what the figure is and when it was read', () => {
    expect(bits.soFarCaption(cm)).toBe('Oct 2026 so far — everything dated in October as Xero holds it, read on 8 Oct 2026');
  });

  test('the short form, for a button or a tile that already names the month', () => {
    expect(bits.soFarCaption(cm, { short: true })).toBe('Oct so far · dated in Oct, read 8 Oct');
    expect(bits.soFarRead(cm)).toBe('dated in Oct, read 8 Oct');
  });

  test('without a read date it still says what the figure is', () => {
    expect(bits.soFarCaption({ ...cm, asOf: null })).toBe('Oct 2026 so far — everything dated in October as Xero holds it');
    expect(bits.soFarRead({ ...cm, asOf: null })).toBe('dated in Oct');
    expect(bits.soFarCaption(null)).toBe('');
  });

  test('the month is written out from its key, or from its label on a payload without one', () => {
    expect(bits.monthName({ key: '2027-01', label: 'Jan 2027' })).toBe('January');
    expect(bits.monthName({ key: 'm5', label: 'Sep 2026' })).toBe('September');
    expect(bits.monthName({})).toBe('');
  });

  test('the exports word it the same way', () => {
    for (const c of [cm, { ...cm, asOf: null }, { key: '2027-02', label: 'Feb 2027', asOf: '2027-02-01' }]) {
      expect(bits.soFarCaption(c)).toBe(doc.soFarCaption(c));
    }
  });
});

// Whether a running total is a year to date is the server's call
// (period.toDateLabel); nothing on the tab assumes it.
describe('the running-total heading beside a month', () => {
  test('over a year, the year to date through the month', () => {
    expect(bits.cumulativeLabel(year, 5)).toBe('YTD to Sep 2026');
    expect(bits.cumulativeLabel(year, 6)).toBe('YTD to Oct 2026 so far');
  });

  test('over a quarter or a custom range, the months it covers', () => {
    expect(bits.cumulativeLabel(quarter, 0)).toBe('To date (Jul 2026)');
    expect(bits.cumulativeLabel(quarter, 2)).toBe('To date (Jul 2026 – Sep 2026)');
    expect(bits.cumulativeLabel(quarter, 3)).toBe('To date (Jul 2026 – Oct 2026 so far)');
  });

  test('without the server\'s word the wording stays neutral rather than guessing a year', () => {
    expect(bits.cumulativeLabel({ ...year, period: { ...year.period, toDateLabel: undefined } }, 5)).toBe('To date (Apr 2026 – Sep 2026)');
  });

  test('the exports head it the same way', () => {
    for (const [d, i] of [[year, 5], [year, 6], [quarter, 0], [quarter, 2], [quarter, 3]]) {
      expect(bits.cumulativeLabel(d, i)).toBe(doc.cumulativeLabel(d, i));
    }
  });
});

describe('the tabs are wired to these helpers', () => {
  const variance = read('pages/xero-insights/VarianceTab.jsx');
  const budget   = read('pages/xero-insights/BudgetTab.jsx');
  const grid     = read('pages/xero-insights/BudgetGrid.jsx');

  test('a month that has not started is a disabled button that says so, and the export gets the fallback', () => {
    expect(variance).toMatch(/import \{[^}]*\bmonthSelectable\b[^}]*\} from '\.\/bits'/s);
    expect(variance).toMatch(/import \{[^}]*\bvarianceSelection\b[^}]*\} from '\.\/bits'/s);
    expect(variance).toMatch(/disabled=\{!open\}/);
    expect(variance).toMatch(/'Not started yet'/);
    expect(variance).toMatch(/<BudgetExport kind="variance" month=\{selected\}/);
  });

  test('no caption says "as of" any more, on either tab or in the grid', () => {
    for (const src of [variance, budget, grid]) {
      expect(src).not.toMatch(/booked in Xero as of|as of \$\{|· as of/);
    }
    expect(variance).toMatch(/soFarCaption\(cm\)/);
    expect(budget).toMatch(/soFarRead\(cm\)/);
    expect(budget).toMatch(/soFarNote=\{soFarCaption\(cm\)\}/);
  });

  test('the tiles print as the tables do, with the currency named once', () => {
    for (const src of [variance, budget]) {
      expect(src).not.toMatch(/fmtMoney/);
      expect(src).toMatch(/fmtCell\(/);
      expect(src).toMatch(/Figures in \{cur\}/);
    }
  });

  test('"YTD" and "Year to date" appear only where the server\'s label is being read', () => {
    const bitsSrc = read(BITS);
    for (const src of [variance, budget, bitsSrc]) {
      for (const line of src.split('\n')) {
        if (!/'YTD|'Year to date'/.test(line) || /^\s*\/\//.test(line)) continue;
        expect(line).toMatch(/toDateLabel|yearly \?/);
      }
    }
  });
});
