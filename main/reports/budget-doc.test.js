const { PassThrough } = require('stream');
const doc    = require('./budget-doc');
const render = require('./budget-render');

// The document definitions are plain objects, so the things that actually go
// wrong in an export — a figure formatted differently from the screen, the
// actual/budget seam landing on the wrong column, a section row that stops
// spanning when a month is added — are all assertable without rendering a PDF.

function months(n, actualCount) {
  return Array.from({ length: n }, (_, i) => ({
    key: `m${i}`, label: `M${i}`, source: i < actualCount ? 'actual' : 'budget',
  }));
}

function row(label, kind, cells, monthly) {
  return {
    kind, label, cells,
    total: cells.reduce((s, v) => s + v, 0),
    monthly: monthly || cells.map(v => ({ actual: v, budget: v, variance: 0, variancePct: 0 })),
    actualToDate: 100, budgetToDate: 80, variance: 20, variancePct: 0.25,
  };
}

const payload = {
  organisation: { name: 'Flovon Pte Ltd', currency: 'SGD' },
  fiscalYear: { label: 'FY to Mar 2027' },
  period: { key: 'fy', toDateLabel: 'Year to date', closedFromLabel: 'M0', closedToLabel: 'M4' },
  kpis: { monthsElapsed: 5 },
  months: months(12, 5),
  rows: [
    { kind: 'section', label: 'Revenue' },
    row('Sales', 'account', new Array(12).fill(100)),
    row('Net profit', 'summary', new Array(12).fill(40)),
  ],
};

// Finds the single table in a document definition; a note can come before it.
const tableOf = d => d.content.find(c => c.table).table;
const rowOf   = (d, label) => tableOf(d).body.find(r => r[0] && r[0].text === label);

// ── A realistic payload, carrying every field of the current contract ────────
// Apr 2026 – Mar 2027, six months closed (Apr–Sep), October in progress. Sales
// and Rent are shaped so their year-to-date percentages are the two quoted from
// Xero's own report: 195.20% and -11.46%.
const r2 = n => Math.round(n * 100) / 100;
const pctOf = (v, b) => (b !== 0 ? v / Math.abs(b) : null);
const FY = ['Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026',
  'Oct 2026', 'Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027', 'Mar 2027'];
const FY_KEYS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
const CLOSED = 6;

function line(label, kind, a, b, extra = {}) {
  const monthly = a.map((av, i) => {
    const variance = r2(av - b[i]);
    return { actual: av, budget: b[i], variance, variancePct: pctOf(variance, b[i]) };
  });
  let ca = 0, cb = 0;
  const cumulative = a.map((av, i) => {
    ca = r2(ca + av); cb = r2(cb + b[i]);
    const variance = r2(ca - cb);
    return { actual: ca, budget: cb, variance, variancePct: pctOf(variance, cb) };
  });
  const cells = a.map((av, i) => (i < CLOSED ? av : b[i]));
  const actualToDate = r2(a.slice(0, CLOSED).reduce((s, v) => s + v, 0));
  const budgetToDate = r2(b.slice(0, CLOSED).reduce((s, v) => s + v, 0));
  const variance = r2(actualToDate - budgetToDate);
  return {
    kind, label, cells, total: r2(cells.reduce((s, v) => s + v, 0)), monthly, cumulative,
    actualToDate, budgetToDate, variance, variancePct: pctOf(variance, budgetToDate),
    expense: false, unbudgeted: false, ...extra,
  };
}
const minus = (x, y) => x.map((v, i) => r2(v - y[i]));

const SALES_A = [500, 500, 500, 500, 500, 452, 300, 0, 0, 0, 0, 0];
const SALES_B = [200, 200, 200, 200, 100, 100, 200, 200, 200, 200, 200, 200];
const RENT_A  = [150, 150, 150, 150, 150, 135.4, 50, 0, 0, 0, 0, 0];
const RENT_B  = SALES_B;
const REFUND_A = [0, 0, -250.75, 0, 0, 0, -10, 0, 0, 0, 0, 0];
const ZERO    = new Array(12).fill(0);

function fyPayload(over = {}) {
  return {
    organisation: { name: 'Flovon Pte Ltd', currency: 'SGD' },
    fiscalYear: { label: 'For the year ended 31 March 2027' },
    period: {
      key: 'fy', label: 'This financial year', months: 12, chunks: 1, fromKey: '2026-04', toKey: '2027-03',
      toDateLabel: 'Year to date', closedFromLabel: 'Apr 2026', closedToLabel: 'Sep 2026', closedThroughISO: '2026-09-30',
    },
    months: FY.map((label, i) => ({ key: FY_KEYS[i], label, source: i < CLOSED ? 'actual' : 'budget', current: i === CLOSED })),
    kpis: {
      monthsElapsed: CLOSED, monthsTotal: 12, ytdActualNet: 0, restOfYearNet: 0, forecastNet: 0,
      currentMonth: { key: '2026-10', label: 'Oct 2026', asOf: '2026-10-07', actualNet: 240, budgetNet: 0 },
    },
    rows: [
      { kind: 'section', label: 'Income' },
      line('Sales', 'account', SALES_A, SALES_B, { section: 'Income' }),
      line('Total Income', 'subtotal', SALES_A, SALES_B, { section: 'Income' }),
      { kind: 'section', label: 'Less Operating Expenses' },
      line('Rent', 'account', RENT_A, RENT_B, { section: 'Less Operating Expenses', expense: true }),
      line('Total Operating Expenses', 'subtotal', RENT_A, RENT_B, { section: 'Less Operating Expenses', expense: true }),
      line('Net Profit', 'summary', minus(SALES_A, RENT_A), minus(SALES_B, RENT_B), { section: '' }),
      { kind: 'section', label: 'Other (actuals only, not budgeted)' },
      line('Refunds', 'account', REFUND_A, ZERO, { unbudgeted: true }),
    ],
    budgetMissing: false,
    fetchedAt: Date.UTC(2026, 9, 6, 17, 25),          // 7 Oct 2026, 01:25 in Singapore
    ...over,
  };
}

const GENERATED = Date.UTC(2026, 9, 6, 17, 30);       // 7 Oct 2026, 01:30 in Singapore
const SGT = { generatedAt: GENERATED, timezone: 'Asia/Singapore' };

// Every line of a sheet as [row number, values], for finding things by text.
function sheetRows(wb, name) {
  const out = [];
  wb.getWorksheet(name).eachRow((r, n) => out.push([n, r.values.slice(1)]));
  return out;
}
const sheetRow = (wb, name, label) => {
  const ws = wb.getWorksheet(name);
  const hit = sheetRows(wb, name).find(([, v]) => v[0] === label);
  return hit ? ws.getRow(hit[0]) : null;
};
const sheetText = (wb, name) => sheetRows(wb, name).map(([, v]) => v.filter(x => typeof x === 'string').join(' ')).join('\n');

describe('reports/budget-doc — figures read as they do on screen', () => {
  test('zero is a dash, not 0.00 — matching Xero, where nil and no-activity look alike', () => {
    expect(doc._cell(0)).toBe('-');
    expect(doc._cell(null)).toBe('-');
    // A sum of floats a hair off zero is nil too, as on screen.
    expect(doc._cell(-0.004)).toBe('-');
  });

  test('a negative is parenthesised rather than signed', () => {
    expect(doc._cell(-1234.5)).toBe('(1,234.50)');
    expect(doc._cell(1234.5)).toBe('1,234.50');
  });

  // Was one decimal with a plus sign ("+6.4%"), which differed from the screen
  // and from Xero's report in most percentage cells of every export.
  test('a percentage has two decimals and no plus sign, as Xero and the screen print it', () => {
    expect(doc._pct(1.952)).toBe('195.20%');
    expect(doc._pct(-0.1146)).toBe('-11.46%');
    expect(doc._pct(0.064)).toBe('6.40%');
    expect(doc._pct(-0.00001)).toBe('0.00%');     // never "-0.00%"
    expect(doc._pct(null)).toBe('-');
  });

  test('the Variance % cell is a dash for a line on budget and for one with no budget', () => {
    expect(doc._pctCell({ variance: 0, variancePct: 0 })).toBe('-');
    expect(doc._pctCell({ variance: 250, variancePct: null })).toBe('-');
    expect(doc._pctCell({ variance: -114.6, variancePct: -0.1146 })).toBe('-11.46%');
  });
});

describe('reports/budget-doc — Budget vs Actual grid', () => {
  test('is landscape, because twelve months and a total will not fit portrait', () => {
    expect(doc.budgetVsActualDoc(payload).pageOrientation).toBe('landscape');
  });

  test('every row has one cell per month plus the account and the total', () => {
    const dataRow = rowOf(doc.budgetVsActualDoc(payload), 'Sales');
    expect(dataRow).toHaveLength(14); // account + 12 months + total
  });

  test('the seam rule falls between the last actual month and the first budget one', () => {
    const d = doc.budgetVsActualDoc(payload);
    const { vLineWidth } = d.content.find(c => c.table).layout;
    // 5 actual months, so the first budget month is table column 6.
    expect(vLineWidth(6)).toBeGreaterThan(0);
    expect(vLineWidth(5)).toBe(0);
    expect(vLineWidth(7)).toBe(0);
  });

  test('the ACTUAL and BUDGET bands span exactly their own months', () => {
    const band = tableOf(doc.budgetVsActualDoc(payload)).body[0];
    const actual = band.find(c => c && c.text === 'ACTUAL');
    const budget = band.find(c => c && c.text === 'OVERALL BUDGET');
    expect(actual.colSpan).toBe(5);
    expect(budget.colSpan).toBe(7);
  });

  test('an all-actual period draws no seam and no budget band', () => {
    const d = doc.budgetVsActualDoc({ ...payload, months: months(6, 6) });
    expect(d.content.find(c => c.table).layout.vLineWidth(3)).toBe(0);
    expect(tableOf(d).body[0].find(c => c && c.text === 'OVERALL BUDGET')).toBeUndefined();
  });

  test('a section heading occupies the full width as real cells, not a span', () => {
    const body = tableOf(doc.budgetVsActualDoc(payload)).body;
    const section = body.find(r => r[0] && r[0].text === 'Revenue');

    // Full width, so adding a month cannot strand the heading.
    expect(section).toHaveLength(14);

    // And specifically NOT via colSpan, which is what it used to do. A spanned
    // cell has no internal column boundaries, so the actual/budget seam and the
    // rule before Total broke at every heading and resumed underneath it —
    // visible in the rendered PDF as a dashed-looking line.
    expect(section[0].colSpan).toBeUndefined();
  });
});

describe('reports/budget-doc — Budget Variance', () => {
  const varPayload = {
    ...payload,
    rows: [
      { kind: 'section', label: 'Revenue' },
      row('Sales', 'account', new Array(12).fill(100),
        Array.from({ length: 12 }, (_, i) => ({ actual: i * 10, budget: i * 8, variance: i * 2, variancePct: 0.25 }))),
    ],
  };

  test('year to date uses the rolled-up figures, not a single month', () => {
    const sales = rowOf(doc.budgetVarianceDoc(varPayload, { month: 'ytd' }), 'Sales');
    expect(sales[1].text).toBe('100.00'); // actualToDate
    expect(sales[2].text).toBe('80.00');  // budgetToDate
  });

  test('a named month reports that month alone', () => {
    const sales = rowOf(doc.budgetVarianceDoc(varPayload, { month: 'm3' }), 'Sales');
    expect(sales[1].text).toBe('30.00'); // monthly[3].actual
    expect(sales[2].text).toBe('24.00'); // monthly[3].budget
  });

  test('an unknown month key reports the year to date — figures, title and filename alike', () => {
    // A tenant switched mid-render leaves a stale selection behind. It used to
    // show the first month's figures under a filename naming the month asked
    // for, so the file said one thing and held another.
    const stale = doc.budgetVarianceDoc(varPayload, { month: 'nope', generatedAt: 0 });
    const ytd   = doc.budgetVarianceDoc(varPayload, { month: 'ytd', generatedAt: 0 });
    const salesOf = d => rowOf(d, 'Sales');
    expect(salesOf(stale).map(c => c.text)).toEqual(salesOf(ytd).map(c => c.text));
    expect(salesOf(stale)[1].text).toBe('100.00');   // actualToDate, not monthly[0]
    for (const c of salesOf(stale).slice(1)) expect(c.text).not.toMatch(/undefined|NaN/);

    expect(JSON.stringify(stale.header)).toBe(JSON.stringify(ytd.header));
    expect(doc.varianceLabel(varPayload, 'nope')).toBe('Year to date');
    expect(doc.exportFilename('variance', varPayload, { month: 'nope' }))
      .toBe(doc.exportFilename('variance', varPayload, { month: 'ytd' }));
    expect(doc.exportFilename('variance', varPayload, { month: 'nope' })).not.toContain('nope');
  });

  test('the workbook resolves an unknown month the same way', () => {
    const cellsOf = wb => sheetRows(wb, 'Budget Variance').map(([, v]) => v);
    const stale = cellsOf(render.budgetVarianceWorkbook(varPayload, { month: 'nope', generatedAt: 0 }));
    const ytd   = cellsOf(render.budgetVarianceWorkbook(varPayload, { month: 'ytd', generatedAt: 0 }));
    expect(stale).toEqual(ytd);
    expect(stale.find(r => r[0] === 'Sales')[1]).toBe(100);
  });

  test('is portrait — five columns do not need a landscape page', () => {
    expect(doc.budgetVarianceDoc(varPayload, {}).pageOrientation).toBe('portrait');
  });
});

describe('reports/budget-doc — the currency line', () => {
  // An exported figure outlives the screen that explained it. Xero reports in
  // base currency while documents do not, so a PDF with no currency on it is
  // how a number gets misread months later.
  test('names the base currency on a single-currency organisation', () => {
    expect(doc._currencyNote('SGD', null)).toBe("Figures in SGD, the organisation's base currency.");
  });

  test('says what was converted when the organisation holds foreign documents', () => {
    const note = doc._currencyNote('SGD', { mixed: true, currencies: ['MYR', 'USD'], unconvertible: 0 });
    expect(note).toContain('MYR, USD');
    expect(note).toContain('rate Xero stamped');
  });

  test('admits documents it could not convert rather than implying it did', () => {
    const note = doc._currencyNote('SGD', { mixed: true, currencies: ['USD'], unconvertible: 3 });
    expect(note).toContain('3 document(s) carried no exchange rate');
  });

  test('the note reaches the page footer of both reports', () => {
    for (const d of [doc.budgetVsActualDoc(payload), doc.budgetVarianceDoc(payload, {})]) {
      expect(d.footer(1, 1).columns[0].text).toContain('SGD');
    }
  });
});

describe('reports/budget-doc — filenames and character coverage', () => {
  // The rollup now names the closed months its figures cover, where it used to
  // name the whole period ("FY to Mar 2027") over figures that stop earlier.
  test('carries the organisation and what the figures cover, so a download is identifiable', () => {
    expect(doc.exportFilename('grid', payload, {})).toBe('Budget-vs-Actual_Flovon-Pte-Ltd_FY-to-Mar-2027');
    expect(doc.exportFilename('variance', payload, { month: 'ytd' }))
      .toBe('Budget-Variance_Flovon-Pte-Ltd_year-to-date_M0-M4');
    expect(doc.exportFilename('variance', payload, { month: 'm3' }))
      .toBe('Budget-Variance_Flovon-Pte-Ltd_M3');
  });

  test('survives an organisation with no name', () => {
    expect(doc.exportFilename('grid', { organisation: {} }, {})).toContain('organisation');
  });

  // The standard PDF fonts draw WinAnsi (Windows-1252), not just Latin-1. The
  // curly quotes, dashes, ellipsis and euro sign in real account names used to
  // be folded to "?" or "-" for no reason; now only what the font truly cannot
  // draw is, which still beats throwing part-way through a response whose
  // headers have already gone out.
  test('folds only the characters the standard PDF fonts cannot draw', () => {
    expect(doc._latin1('Café Ltd')).toBe('Café Ltd');
    expect(doc._latin1('A–B')).toBe('A–B');
    expect(doc._latin1('Rent “Office” — HQ … € ‘x’ ™ Œ ƒ')).toBe('Rent “Office” — HQ … € ‘x’ ™ Œ ƒ');
    expect(doc._latin1('北京公司')).toBe('????');
    expect(doc._latin1('Аренда')).toBe('??????');
    expect(doc._latin1('a💰b')).toBe('a?b');               // one placeholder per character, not per UTF-16 unit
    expect(doc._latin1('x\u0085y')).toBe('x?y');           // a C1 control would print as WinAnsi's "…"
  });
});

// What the variance export is titled. It said "Oct 2026" for a month six days
// old, which reads as a closed month, and "Year to date" for any period.
describe('reports/budget-doc — what the variance figures cover', () => {
  const months = [{ key: '2026-09', label: 'Sep 2026' }, { key: '2026-10', label: 'Oct 2026' }];
  const payload = {
    months,
    period: { key: 'fy', toDateLabel: 'Year to date' },
    kpis: { currentMonth: { key: '2026-10', label: 'Oct 2026', asOf: '2026-10-06' } },
  };

  // The figure is the whole month's P&L as Xero held it on the day it was
  // read, entries dated later in the month included. "So far, as of 6 Oct"
  // read as the 1st to the 6th, which it never was.
  test('a month in progress says what its figure is, and the day it was read', () => {
    expect(doc.varianceLabel(payload, '2026-10')).toBe('Oct 2026 so far — everything dated in October as Xero holds it, read on 6 Oct 2026');
    expect(doc.soFarCaption(payload.kpis.currentMonth)).toBe('Oct 2026 so far — everything dated in October as Xero holds it, read on 6 Oct 2026');
  });

  test('a month in progress with no read date still says so far, and what it holds', () => {
    const noDate = { ...payload, kpis: { currentMonth: { ...payload.kpis.currentMonth, asOf: null } } };
    expect(doc.varianceLabel(noDate, '2026-10')).toBe('Oct 2026 so far — everything dated in October as Xero holds it');
  });

  test('the month is written out from its key, or from its label on a payload without one', () => {
    expect(doc.soFarCaption({ key: '2027-01', label: 'Jan 2027', asOf: '2027-01-03' }))
      .toBe('Jan 2027 so far — everything dated in January as Xero holds it, read on 3 Jan 2027');
    expect(doc.soFarCaption({ key: 'm5', label: 'Oct 2026' })).toBe('Oct 2026 so far — everything dated in October as Xero holds it');
    expect(doc.soFarCaption(null)).toBe('');
  });

  test('a closed month is just its name', () => {
    expect(doc.varianceLabel(payload, '2026-09')).toBe('Sep 2026');
  });

  // Whether a rollup is a year or a period to date is now the server's call
  // (period.toDateLabel), the same word the screen shows. Without it the label
  // stays neutral rather than guessing from the period key as it used to.
  test('the rollup takes its "year" or "period" to date from the server', () => {
    expect(doc.varianceLabel(payload, 'ytd')).toBe('Year to date');
    expect(doc.varianceLabel({ ...payload, period: { key: 'last-6', toDateLabel: 'Period to date' } }, 'ytd')).toBe('Period to date');
    expect(doc.varianceLabel({ months }, 'ytd')).toBe('To date');
  });

  test('the PDF header carries the label', () => {
    const def = doc.budgetVarianceDoc({ ...payload, rows: [], organisation: { name: 'Org' } }, { month: '2026-10', generatedAt: 0 });
    expect(JSON.stringify(def.header)).toContain('Oct 2026 so far — everything dated in October as Xero holds it, read on 6 Oct 2026');
  });

  test('dayLabel reads the date as written, and refuses anything else', () => {
    expect(doc.dayLabel('2026-01-31')).toBe('31 Jan 2026');
    expect(doc.dayLabel('nope')).toBe('');
  });
});

// A rollup export said "Year to date · Financial year to date · Apr 2026 –
// Oct 2026" over figures covering April to September: the month in progress is
// never in a to-date total. It now names the completed months it does cover.
describe('reports/budget-doc — a rollup export names the completed months it covers', () => {
  const fy = fyPayload();

  test('the subtitle names the completed months and how many there are', () => {
    expect(doc.varianceSubtitle(fy, 'ytd')).toBe('Year to date · Apr 2026 – Sep 2026 (6 completed months)');
    expect(doc.toDateText(fy)).toBe('Year to date · Apr 2026 – Sep 2026 (6 completed months)');
  });

  test('the PDF header and the workbook carry it, and the period it is not', () => {
    // October is in progress, so it is not in these figures and not in their title.
    const subtitle = doc.budgetVarianceDoc(fy, { month: 'ytd', ...SGT }).header.columns[0].stack[1].text;
    expect(subtitle).toBe('Year to date · Apr 2026 – Sep 2026 (6 completed months) · SGD');
    const wb = render.budgetVarianceWorkbook(fy, { month: 'ytd', ...SGT });
    expect(String(wb.getWorksheet('Budget Variance').getCell(2, 1).value))
      .toMatch(/^Year to date · Apr 2026 – Sep 2026 \(6 completed months\) · SGD · Generated /);
  });

  test('one completed month is named alone, in the singular', () => {
    const one = fyPayload({ kpis: { ...fy.kpis, monthsElapsed: 1 }, period: { ...fy.period, closedFromLabel: 'Apr 2026', closedToLabel: 'Apr 2026' } });
    expect(doc.varianceSubtitle(one, 'ytd')).toBe('Year to date · Apr 2026 (1 completed month)');
  });

  test('with nothing closed yet it says so, and names the period so the year is still known', () => {
    const next = fyPayload({
      fiscalYear: { label: 'For the year ended 31 March 2028' },
      months: fy.months.map(m => ({ ...m, label: m.label.replace(/\d{4}$/, y => Number(y) + 1), source: 'budget', current: false })),
      kpis: { ...fy.kpis, monthsElapsed: 0, currentMonth: null },
      period: { ...fy.period, key: 'next-fy', closedFromLabel: null, closedToLabel: null, closedThroughISO: null },
    });
    expect(doc.varianceSubtitle(next, 'ytd')).toBe('Year to date · no completed months yet · For the year ended 31 March 2028');
    expect(doc.exportFilename('variance', next, { month: 'ytd' }))
      .toBe('Budget-Variance_Flovon-Pte-Ltd_year-to-date_none-closed_Apr-2027-Mar-2028');
  });

  test('a period that is not a year says period to date, in the title and the filename', () => {
    const q = fyPayload({ period: { ...fy.period, key: 'last-quarter', toDateLabel: 'Period to date', closedFromLabel: 'Jul 2026', closedToLabel: 'Sep 2026' },
      kpis: { ...fy.kpis, monthsElapsed: 3 } });
    expect(doc.varianceSubtitle(q, 'ytd')).toBe('Period to date · Jul 2026 – Sep 2026 (3 completed months)');
    expect(doc.exportFilename('variance', q, { month: 'ytd' })).toBe('Budget-Variance_Flovon-Pte-Ltd_period-to-date_Jul-2026-Sep-2026');
  });

  test('a payload without the closed-month names falls back to the elapsed months', () => {
    const { closedFromLabel, closedToLabel, ...older } = fy.period;
    expect(doc.closedRange({ ...fy, period: older })).toBe('Apr 2026 – Sep 2026');
  });

  test('this year and last year export under different titles and short, safe filenames', () => {
    const last = fyPayload({ period: { ...fy.period, key: 'prev-fy', closedFromLabel: 'Apr 2025', closedToLabel: 'Mar 2026' },
      kpis: { ...fy.kpis, monthsElapsed: 12, currentMonth: null } });
    const a = doc.exportFilename('variance', fy, { month: 'ytd' });
    const b = doc.exportFilename('variance', last, { month: 'ytd' });
    expect(a).toBe('Budget-Variance_Flovon-Pte-Ltd_year-to-date_Apr-2026-Sep-2026');
    expect(b).toBe('Budget-Variance_Flovon-Pte-Ltd_year-to-date_Apr-2025-Mar-2026');
    for (const name of [a, b]) {
      expect(name).toMatch(/^[\p{L}\p{N}_-]+$/u);
      expect(name.length).toBeLessThan(80);
    }
    const header = p => JSON.stringify(doc.budgetVarianceDoc(p, { month: 'ytd', generatedAt: 0 }).header);
    expect(header(fy)).not.toBe(header(last));
  });

  test('a single month names itself and nothing more', () => {
    expect(doc.varianceSubtitle(fy, '2026-09')).toBe('Sep 2026');
  });
});

// Xero's Budget Variance report shows the chosen month beside the year to date
// up to it. The export showed the month alone.
describe('reports/budget-doc — a month beside its running total', () => {
  const fy = fyPayload();

  test('the PDF shows the month and "YTD to" that month side by side, from rows[].cumulative', () => {
    const d = doc.budgetVarianceDoc(fy, { month: '2026-09', ...SGT });
    const band = tableOf(d).body[0].filter(c => c.colSpan === 4).map(c => c.text);
    expect(band).toEqual(['Sep 2026', 'YTD to Sep 2026']);
    expect(tableOf(d).body[1].map(c => c.text)).toEqual(['Account',
      'Actual', 'Budget', 'Variance', 'Variance %', 'Actual', 'Budget', 'Variance', 'Variance %']);
    expect(rowOf(d, 'Sales').slice(1).map(c => c.text)).toEqual([
      '452.00', '100.00', '352.00', '352.00%',          // September alone
      '2,952.00', '1,000.00', '1,952.00', '195.20%',    // April to September
    ]);
    // Nine columns need the landscape page; the rollup alone stays portrait.
    expect(d.pageOrientation).toBe('landscape');
    expect(doc.budgetVarianceDoc(fy, { month: 'ytd' }).pageOrientation).toBe('portrait');
  });

  test('the month in progress is headed "so far", its running total too, and the subtitle says what that is', () => {
    const d = doc.budgetVarianceDoc(fy, { month: '2026-10', ...SGT });
    // The heading spans four narrow columns, so it stays short; the caption
    // is in the page header, on every page.
    expect(tableOf(d).body[0].filter(c => c.colSpan === 4).map(c => c.text))
      .toEqual(['Oct 2026 so far', 'YTD to Oct 2026 so far']);
    expect(rowOf(d, 'Sales').slice(5).map(c => c.text)).toEqual(['3,252.00', '1,200.00', '2,052.00', '171.00%']);
    expect(d.header.columns[0].stack[1].text).toBe('Oct 2026 so far — everything dated in October as Xero holds it, read on 7 Oct 2026 · SGD');
    const wb = render.budgetVarianceWorkbook(fy, { month: '2026-10', ...SGT });
    expect(String(wb.getWorksheet('Budget Variance').getCell(2, 1).value)).toMatch(/^Oct 2026 so far — everything dated in October as Xero holds it, read on 7 Oct 2026 · SGD · Generated /);
  });

  test('over a period that is not a year the running total names its months, not "YTD"', () => {
    const q = fyPayload({ period: { ...fy.period, toDateLabel: 'Period to date' } });
    expect(doc.cumulativeLabel(q, 5)).toBe('To date (Apr 2026 – Sep 2026)');
    expect(doc.cumulativeLabel(q, 6)).toBe('To date (Apr 2026 – Oct 2026 so far)');
    // Nothing in the file assumes a year: not the headings, not the subtitle, not the name.
    const d = doc.budgetVarianceDoc(q, { month: '2026-09', ...SGT });
    expect(JSON.stringify([d.header, tableOf(d).body[0]])).not.toMatch(/YTD|[Yy]ear/);
    expect(doc.exportFilename('variance', q, { month: '2026-09' })).toBe('Budget-Variance_Flovon-Pte-Ltd_Sep-2026_to-date-from-Apr-2026');
    // And without the server's word at all, the wording stays neutral.
    expect(doc.cumulativeLabel(fyPayload({ period: { ...fy.period, toDateLabel: undefined } }), 5)).toBe('To date (Apr 2026 – Sep 2026)');
  });

  test('the workbook has the same two groups, as numbers', () => {
    const wb = render.budgetVarianceWorkbook(fy, { month: '2026-09', ...SGT });
    const ws = wb.getWorksheet('Budget Variance');
    const head = sheetRows(wb, 'Budget Variance').find(([, v]) => v[0] === 'Account');
    expect(head[1]).toEqual(['Account', 'Actual', 'Budget', 'Variance', 'Variance %', 'Actual', 'Budget', 'Variance', 'Variance %']);
    const band = ws.getRow(head[0] - 1);
    expect([band.getCell(2).value, band.getCell(6).value]).toEqual(['Sep 2026', 'YTD to Sep 2026']);
    expect(sheetRow(wb, 'Budget Variance', 'Sales').values.slice(2)).toEqual([452, 100, 352, 3.52, 2952, 1000, 1952, 1.952]);
  });

  test('a payload with no running totals shows the month alone rather than a group of blanks', () => {
    const older = fyPayload({ rows: fy.rows.map(({ cumulative, ...r }) => r) });
    expect(doc.variancePeriods(older, '2026-09')).toHaveLength(1);
    expect(rowOf(doc.budgetVarianceDoc(older, { month: '2026-09' }), 'Sales')).toHaveLength(5);
  });

  test('the filename names where its running total starts, so another period cannot overwrite it', () => {
    expect(doc.exportFilename('variance', fy, { month: '2026-09' })).toBe('Budget-Variance_Flovon-Pte-Ltd_Sep-2026_ytd-from-Apr-2026');
    const custom = fyPayload({ months: [{ key: '2025-10', label: 'Oct 2025', source: 'actual' }, ...fy.months] });
    expect(doc.exportFilename('variance', custom, { month: '2026-09' })).toBe('Budget-Variance_Flovon-Pte-Ltd_Sep-2026_ytd-from-Oct-2025');
  });
});

// A month after the one in progress has nothing in it, so its export was a
// page of "-100.00%" lines headed as if the month had ended. The screen no
// longer offers such a month, and an export asked for one is refused.
describe('reports/budget-doc — a month that has not started is refused', () => {
  const fy = fyPayload();

  test('a closed month, the month in progress and a budget month after it are told apart', () => {
    expect(doc.monthStarted(fy.months[5])).toBe(true);     // Sep, closed
    expect(doc.monthStarted(fy.months[6])).toBe(true);     // Oct, in progress
    expect(doc.monthStarted(fy.months[7])).toBe(false);    // Nov
    expect(doc.monthStarted(undefined)).toBe(false);
    // A payload from before months said which they were is not refused.
    expect(doc.monthStarted({ key: '2026-11', label: 'Nov 2026' })).toBe(true);
  });

  test('the PDF, the workbook and the filename all refuse it, with an error the routes can tell apart', () => {
    for (const build of [
      () => doc.budgetVarianceDoc(fy, { month: '2026-11', ...SGT }),
      () => render.budgetVarianceWorkbook(fy, { month: '2026-11', ...SGT }),
      () => doc.exportFilename('variance', fy, { month: '2026-11' }),
    ]) {
      expect(build).toThrow(doc.MonthNotStartedError);
      expect(build).toThrow('Nov 2026 has not started yet');
    }
    expect(() => doc.resolveMonth(fy, '2027-03')).toThrow('Mar 2027 has not started yet');
    let caught;
    try { doc.resolveMonth(fy, '2026-11'); } catch (err) { caught = err; }
    expect(doc.isMonthNotStarted(caught)).toBe(true);
    expect(caught.month).toBe('Nov 2026');
    expect(doc.isMonthNotStarted(new Error('Nov 2026 has not started yet'))).toBe(false);
  });

  test('the month in progress still exports, as "so far"', () => {
    const d = doc.budgetVarianceDoc(fy, { month: '2026-10', ...SGT });
    expect(tableOf(d).body[0].filter(c => c.colSpan === 4).map(c => c.text)[0]).toBe('Oct 2026 so far');
    expect(rowOf(d, 'Sales').slice(1, 5).map(c => c.text)).toEqual(['300.00', '200.00', '100.00', '50.00%']);
    expect(render.budgetVarianceWorkbook(fy, { month: '2026-10', ...SGT }).getWorksheet('Budget Variance')).toBeTruthy();
    expect(doc.exportFilename('variance', fy, { month: '2026-10' })).toBe('Budget-Variance_Flovon-Pte-Ltd_Oct-2026_ytd-from-Apr-2026');
  });

  test('a closed month, the rollup and a key that is not in the report are untouched', () => {
    expect(doc.resolveMonth(fy, '2026-09')).toBe('2026-09');
    expect(doc.resolveMonth(fy, 'ytd')).toBe('ytd');
    expect(doc.resolveMonth(fy, '2031-01')).toBe('ytd');
    expect(doc.resolveMonth(fy, undefined)).toBe('ytd');
  });

  test('a period entirely ahead refuses every month, and its rollup still says nothing has closed', () => {
    const next = fyPayload({
      months: fy.months.map(m => ({ ...m, source: 'budget', current: false })),
      kpis: { ...fy.kpis, monthsElapsed: 0, currentMonth: null },
      period: { ...fy.period, key: 'next-fy', closedFromLabel: null, closedToLabel: null, closedThroughISO: null },
    });
    for (const m of next.months) expect(() => doc.resolveMonth(next, m.key)).toThrow(doc.MonthNotStartedError);
    expect(doc.varianceSubtitle(next, 'ytd')).toMatch(/^Year to date · no completed months yet/);
  });
});

// Over budget is good on income and bad on a cost. The export coloured by sign
// alone, so every overspend on a cost was green.
describe('reports/budget-doc — favourable is green, as in Xero', () => {
  const fy = fyPayload();
  const GREEN = '#0f9d76', RED = '#b42318';
  const tones = (d, label) => rowOf(d, label).slice(3, 5).map(c => c.color);

  test('a cost under budget is green, and keeps its negative sign', () => {
    const d = doc.budgetVarianceDoc(fy, { month: 'ytd' });
    expect(rowOf(d, 'Rent').slice(3).map(c => c.text)).toEqual(['(114.60)', '-11.46%']);
    expect(tones(d, 'Rent')).toEqual([GREEN, GREEN]);
    expect(tones(d, 'Total Operating Expenses')).toEqual([GREEN, GREEN]);
    expect(tones(d, 'Sales')).toEqual([GREEN, GREEN]);           // income above budget
  });

  test('a cost over budget and income under budget are red', () => {
    const over = fyPayload({ rows: [line('Rent', 'account', SALES_A, RENT_B, { expense: true })] });
    expect(tones(doc.budgetVarianceDoc(over, { month: 'ytd' }), 'Rent')).toEqual([RED, RED]);
    const under = fyPayload({ rows: [line('Sales', 'account', RENT_A, SALES_B, { section: 'Income' })] });
    expect(tones(doc.budgetVarianceDoc(under, { month: 'ytd' }), 'Sales')).toEqual([RED, RED]);
    // A cost with nothing booked against it yet is under budget, and green.
    const d = doc.budgetVarianceDoc(fyPayload({ rows: [line('Rent', 'account', ZERO, RENT_B, { expense: true })] }), { month: '2026-10' });
    expect(tones(d, 'Rent')).toEqual([GREEN, GREEN]);
  });

  test('a payload that does not mark costs is read from the section title, as the screen does', () => {
    const { expense, ...rent } = fy.rows.find(r => r.label === 'Rent');
    expect(doc.favourable(rent, -114.6)).toBe(true);
    expect(doc.favourable({ section: 'Income' }, -1)).toBe(false);
    expect(doc.favourable(rent, 0)).toBeNull();
  });

  test('the workbook colours the same cells the same way', () => {
    const wb = render.budgetVarianceWorkbook(fy, { month: 'ytd', ...SGT });
    const colour = label => [4, 5].map(c => sheetRow(wb, 'Budget Variance', label).getCell(c).font?.color?.argb);
    expect(colour('Rent')).toEqual(['FF0F9D76', 'FF0F9D76']);
    expect(colour('Sales')).toEqual(['FF0F9D76', 'FF0F9D76']);
    expect(sheetRow(wb, 'Budget Variance', 'Rent').getCell(4).value).toBe(-114.6);   // the sign is unchanged
  });
});

// The workbook printed nil as an en dash in some columns, left the percentage
// blank in others, and the PDF used a hyphen. One rule now: "-".
describe('reports/budget-doc — one dash rule in the PDF and the workbook', () => {
  const fy = fyPayload();

  test('the workbook formats print "-" for nil, brackets for negatives, two-decimal percentages', () => {
    expect(render.MONEY_FMT).toBe('#,##0.00;(#,##0.00);"-"');
    expect(render.PCT_FMT).toBe('0.00%');
    const wb = render.budgetVarianceWorkbook(fy, { month: 'ytd', ...SGT });
    const sales = sheetRow(wb, 'Budget Variance', 'Sales');
    expect([2, 3, 4].map(c => sales.getCell(c).numFmt)).toEqual(new Array(3).fill(render.MONEY_FMT));
    expect(sales.getCell(5).numFmt).toBe(render.PCT_FMT);
    expect(sales.getCell(5).value).toBe(1.952);
  });

  test('a percentage with no budget to divide by is "-" in both, never a blank cell', () => {
    const pdf = rowOf(doc.budgetVarianceDoc(fy, { month: 'ytd' }), 'Refunds (not budgeted)');
    expect(pdf.slice(1).map(c => c.text)).toEqual(['(250.75)', '-', '(250.75)', '-']);
    const wb = render.budgetVarianceWorkbook(fy, { month: 'ytd', ...SGT });
    expect(sheetRow(wb, 'Budget Variance', 'Refunds').values.slice(2)).toEqual([-250.75, 0, -250.75, '-']);
  });

  test('no numeric cell in either workbook is left empty or uses an en dash', () => {
    for (const [wb, name] of [
      [render.budgetVarianceWorkbook(fy, { month: '2026-09', ...SGT }), 'Budget Variance'],
      [render.budgetVsActualWorkbook(fy, SGT), 'Budget vs Actual'],
    ]) {
      const ws = wb.getWorksheet(name);
      const width = ws.getRow(sheetRows(wb, name).find(([, v]) => v[0] === 'Account')[0]).cellCount;
      for (const r of fy.rows.filter(x => x.kind !== 'section')) {
        const x = sheetRow(wb, name, r.label);
        for (let c = 2; c <= width; c++) {
          expect({ r: r.label, c, v: x.getCell(c).value === null }).toEqual({ r: r.label, c, v: false });
          expect(String(x.getCell(c).numFmt || '')).not.toContain('–');
        }
      }
    }
  });

  test('a percentage a hair below zero is 0.00% in both, never "-0.00%" in the workbook', () => {
    const tiny = fyPayload({ rows: [{ ...line('Sales', 'account', SALES_A, SALES_B), variance: -0.01, variancePct: -0.0000001 }] });
    expect(rowOf(doc.budgetVarianceDoc(tiny, { month: 'ytd' }), 'Sales')[4].text).toBe('0.00%');
    expect(sheetRow(render.budgetVarianceWorkbook(tiny, { month: 'ytd', ...SGT }), 'Budget Variance', 'Sales').getCell(5).value).toBe(0);
  });

  test('cents of float noise are written as the cents the PDF prints', () => {
    const noisy = fyPayload({ rows: [{ ...line('Sales', 'account', SALES_A, SALES_B), actualToDate: 9857.100000000002 }] });
    const wb = render.budgetVarianceWorkbook(noisy, { month: 'ytd', ...SGT });
    expect(sheetRow(wb, 'Budget Variance', 'Sales').getCell(2).value).toBe(9857.1);
  });
});

// Account names in a non-Latin script cannot be drawn by the PDF's built-in
// font. They fold to "?", and two of them used to fold to the same "????".
describe('reports/budget-doc — names the PDF font cannot draw', () => {
  const jp = fyPayload({
    rows: [
      { kind: 'section', label: 'Income' },
      line('販売収入', 'account', SALES_A, SALES_B),
      line('売上原価', 'account', SALES_A, SALES_B),
      line('Rent “Office” — HQ', 'account', RENT_A, RENT_B, { expense: true }),
    ],
  });

  test('two folded names stay distinguishable by their line in the report', () => {
    const body = tableOf(doc.budgetVarianceDoc(jp, { month: 'ytd' })).body;
    const labels = body.slice(2).map(r => r[0].text);
    expect(labels).toEqual(['Income', '???? [#2]', '???? [#3]', 'Rent “Office” — HQ']);
    expect(doc._pdfLabel({ label: 'Sales 販売' }, 7)).toBe('Sales ?? [#7]');   // the readable part is kept
  });

  test('a note says what the marks mean and that the workbook has the real names', () => {
    const asides = d => d.content.filter(c => c.style === 'aside').map(c => c.text).join(' ');
    expect(asides(doc.budgetVarianceDoc(jp, { month: 'ytd' }))).toMatch(/\[#n\].*Excel export carries every name/);
    expect(asides(doc.budgetVsActualDoc(jp))).toMatch(/Excel export/);
    expect(asides(doc.budgetVarianceDoc(fyPayload(), { month: 'ytd' }))).toBe('');
    const wb = render.budgetVarianceWorkbook(jp, { month: 'ytd', ...SGT });
    expect(sheetRow(wb, 'Budget Variance', '販売収入')).not.toBeNull();
  });

  test('both PDFs render all the way through with these names', async () => {
    const bytes = async def => {
      const chunks = [];
      const pdf = render.streamPdf(def, new PassThrough());
      await new Promise((resolve, reject) => { pdf.on('data', c => chunks.push(c)); pdf.on('end', resolve); pdf.on('error', reject); });
      return Buffer.concat(chunks);
    };
    for (const def of [doc.budgetVsActualDoc(jp, SGT), doc.budgetVarianceDoc(jp, { month: '2026-10', ...SGT })]) {
      const out = await bytes(def);
      expect(out.subarray(0, 5).toString()).toBe('%PDF-');
      expect(out.length).toBeGreaterThan(2000);
    }
  });
});

// The screen shows what has been booked so far in the month in progress,
// beside the grid; the grid itself shows that month as budget. The export had
// the grid and not the note, so it lacked a figure the reader had just seen.
describe('reports/budget-doc — the month in progress, in the grid export', () => {
  const withCurrent = {
    ...payload,
    kpis: { currentMonth: { key: 'm5', label: 'Oct 2026', asOf: '2026-10-06', actualNet: 12345, budgetNet: 17615 } },
  };
  const NOTE = 'Oct 2026 so far — everything dated in October as Xero holds it, read on 6 Oct 2026: net profit 12,345.00 against 17,615.00 budgeted. Not included in the figures above.';

  test('the note is written from the payload, with the figures formatted as money', () => {
    expect(doc.soFarNote(withCurrent)).toBe(NOTE);
    expect(doc.soFarNote(payload)).toBe('');
  });

  test('the PDF carries it below the grid when a month is in progress, and not otherwise', () => {
    const notes = d => d.content.filter(c => c.style === 'note').map(c => c.text);
    expect(notes(doc.budgetVsActualDoc(withCurrent))).toEqual([NOTE]);
    expect(notes(doc.budgetVsActualDoc(payload))).toEqual([]);
    expect(notes(doc.budgetVsActualDoc({ ...payload, kpis: { currentMonth: null } }))).toEqual([]);
  });

  test('the workbook carries the same line when a month is in progress, and not otherwise', () => {
    expect(sheetText(render.budgetVsActualWorkbook(withCurrent, { generatedAt: 0 }), 'Budget vs Actual')).toContain(NOTE);
    expect(sheetText(render.budgetVsActualWorkbook(payload, { generatedAt: 0 }), 'Budget vs Actual')).not.toMatch(/so far/i);
  });

  test('without a read date it still says so far, just not when', () => {
    const noDate = { ...withCurrent, kpis: { currentMonth: { ...withCurrent.kpis.currentMonth, asOf: null } } };
    expect(doc.soFarNote(noDate)).toMatch(/^Oct 2026 so far — everything dated in October as Xero holds it: net profit 12,345.00/);
  });
});

// The screen's grid has an amber "<Mon> so far" column before the month in
// progress, outside Total. The exports had only the sentence below the grid.
describe('reports/budget-doc — the "so far" column in the grid export', () => {
  const fy = fyPayload();

  test('the PDF puts it before the month in progress, in amber, and leaves Total alone', () => {
    const d = doc.budgetVsActualDoc(fy, SGT);
    const head = tableOf(d).body[1];
    expect(head.map(c => c.text).slice(5, 9)).toEqual(['Aug 2026', 'Sep 2026', 'Oct so far', 'Oct 2026']);
    const sales = rowOf(d, 'Sales');
    expect(sales).toHaveLength(15);                    // account + so far + 12 months + total
    expect(sales[7].text).toBe('300.00');              // monthly[Oct].actual
    expect(sales[7].fillColor).toBeTruthy();
    expect(sales[8].text).toBe('200.00');              // Oct stays budget
    expect(sales[14].text).toBe(doc._cell(fy.rows[1].total));   // Total unchanged by the booked figure
    expect(rowOf(d, 'Refunds (not budgeted)')[7].text).toBe('(10.00)');
    // A section heading still spans every column, the new one included.
    expect(tableOf(d).body.find(r => r[0].text === 'Income')).toHaveLength(15);
  });

  test('the bands read Actual | So far | Overall Budget and the seam sits before "so far"', () => {
    const d = doc.budgetVsActualDoc(fy, SGT);
    const band = tableOf(d).body[0].filter(c => c.text);
    expect(band.map(c => [c.text, c.colSpan || 1])).toEqual([['Figures in SGD', 1], ['ACTUAL', 6], ['SO FAR', 1], ['OVERALL BUDGET', 6]]);
    const { vLineWidth } = d.content.find(c => c.table).layout;
    expect(vLineWidth(7)).toBeGreaterThan(0);
    expect(vLineWidth(8)).toBe(0);
    expect(vLineWidth(14)).toBeGreaterThan(0);         // before Total
    // The sentence below the grid stays.
    expect(d.content.filter(c => c.style === 'note').map(c => c.text)[0]).toMatch(/^Oct 2026 so far — everything dated in October as Xero holds it, read on 7 Oct 2026/);
  });

  test('the workbook has the same column, band and seam, and the band says Overall Budget', () => {
    const wb = render.budgetVsActualWorkbook(fy, SGT);
    const ws = wb.getWorksheet('Budget vs Actual');
    const headNo = sheetRows(wb, 'Budget vs Actual').find(([, v]) => v[0] === 'Account')[0];
    const head = ws.getRow(headNo);
    expect(head.getCell(8).value).toBe('Oct so far');
    expect(head.getCell(9).value).toBe('Oct 2026');
    expect(head.getCell(15).value).toBe('Total');
    const band = ws.getRow(headNo - 1);
    expect([band.getCell(2).value, band.getCell(8).value, band.getCell(9).value]).toEqual(['Actual', 'So far', 'Overall Budget']);
    expect(band.values.filter(v => v === 'Budget')).toEqual([]);
    const sales = sheetRow(wb, 'Budget vs Actual', 'Sales');
    expect(sales.getCell(8).value).toBe(300);
    expect(sales.getCell(8).fill).toBeTruthy();
    expect(sales.getCell(15).value).toBe(fy.rows[1].total);
    expect(ws.getCell(headNo, 8).border?.left?.style).toBe('medium');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: headNo });
    expect(sheetText(wb, 'Budget vs Actual')).toMatch(/Oct 2026 so far — everything dated in October as Xero holds it, read on 7 Oct 2026: net profit/);
  });

  // pdfmake cuts a table wider than its page off at the right-hand edge, Total
  // first. Eighteen months did not fit A4 before, and the new column would have
  // pushed thirteen over too.
  test('a grid wider than A4 widens the page instead of losing its right-hand columns', () => {
    const long = Array.from({ length: 18 }, (_, i) => ({ key: `k${i}`, label: `M${i} 2026`, source: i < 12 ? 'actual' : 'budget', current: i === 12 }));
    const wide = { ...payload, months: long, rows: [row('Big Account', 'account', new Array(18).fill(1234567.89))] };
    const d = doc.budgetVsActualDoc(wide);
    expect(d.pageSize.width).toBeGreaterThan(841.89 * 1.3);
    expect(d.pageSize.height).toBeCloseTo(595.28);
    expect(doc.budgetVsActualDoc(fy, SGT).pageSize).toBe('A4');
  });

  test('a period with no month in progress gets no such column', () => {
    const past = fyPayload({ months: fy.months.map(m => ({ ...m, current: false })) });
    expect(rowOf(doc.budgetVsActualDoc(past), 'Sales')).toHaveLength(14);
    expect(sheetText(render.budgetVsActualWorkbook(past, SGT), 'Budget vs Actual')).not.toMatch(/Oct so far/);
  });
});

// "Generated" was formatted in the server's timezone — UTC on the VM — beside
// "as of" dates in Singapore time, so an export made at 01:30 on 7 Oct said
// it was generated on 6 Oct.
describe('reports/budget-doc — times are in the reader\'s timezone', () => {
  const fy = fyPayload();

  test('a stamp is in the zone asked for, and names it', () => {
    expect(doc.stamp(GENERATED, 'Asia/Singapore')).toBe('7 Oct 2026, 01:30 GMT+8');
    expect(doc.stamp(GENERATED, 'UTC')).toBe('6 Oct 2026, 17:30 UTC');
    expect(doc.stamp(GENERATED, 'Not/AZone')).toBe('6 Oct 2026, 17:30 UTC');   // a bad zone still says which it used
  });

  test('both PDFs and both workbooks say "Generated" in that zone', () => {
    for (const d of [doc.budgetVsActualDoc(fy, SGT), doc.budgetVarianceDoc(fy, { month: 'ytd', ...SGT })]) {
      expect(JSON.stringify(d.header)).toContain('Generated 7 Oct 2026, 01:30 GMT+8');
    }
    for (const [wb, name] of [[render.budgetVsActualWorkbook(fy, SGT), 'Budget vs Actual'],
      [render.budgetVarianceWorkbook(fy, { month: 'ytd', ...SGT }), 'Budget Variance']]) {
      expect(String(wb.getWorksheet(name).getCell(2, 1).value)).toMatch(/· Generated 7 Oct 2026, 01:30 GMT\+8$/);
    }
  });
});

// An export re-reads the figures, and the cache it reads lasts minutes, so the
// file can differ from the screen it came from. It now says when its figures
// were read.
describe('reports/budget-doc — when the figures were read from Xero', () => {
  const fy = fyPayload();
  const LINE = 'Figures read from Xero at 7 Oct 2026, 01:25 GMT+8';

  test('the line is written from payload.fetchedAt in the reader\'s zone', () => {
    expect(doc.fetchedNote(fy, 'Asia/Singapore')).toBe(LINE);
    expect(doc.fetchedNote({ ...fy, fetchedAt: undefined }, 'Asia/Singapore')).toBe('');
    expect(doc.fetchedNote({ ...fy, fetchedAt: 'not a date' }, 'Asia/Singapore')).toBe('');
  });

  test('both PDFs carry it in the page header', () => {
    for (const d of [doc.budgetVsActualDoc(fy, SGT), doc.budgetVarianceDoc(fy, { month: '2026-09', ...SGT })]) {
      expect(d.header.columns[1].stack.map(s => s.text)).toContain(LINE);
    }
    expect(JSON.stringify(doc.budgetVsActualDoc({ ...fy, fetchedAt: undefined }, SGT).header)).not.toContain('read from Xero');
  });

  test('both workbooks carry it on the line under the subtitle', () => {
    expect(render.budgetVsActualWorkbook(fy, SGT).getWorksheet('Budget vs Actual').getCell(3, 1).value).toBe(LINE);
    expect(render.budgetVarianceWorkbook(fy, { month: 'ytd', ...SGT }).getWorksheet('Budget Variance').getCell(3, 1).value).toBe(LINE);
  });
});

// A line Xero has actuals for but no budget for printed exactly like one
// budgeted at nil; and a period with no budget at all said nothing about it.
describe('reports/budget-doc — unbudgeted lines and a missing budget', () => {
  const fy = fyPayload();

  test('an unbudgeted line is marked in every export, and its budget is a dash whatever arrives', () => {
    const odd = fyPayload({ rows: fy.rows.map(r => (r.unbudgeted ? { ...r, budgetToDate: 99 } : r)) });
    const pdf = rowOf(doc.budgetVarianceDoc(odd, { month: 'ytd' }), 'Refunds (not budgeted)');
    expect(pdf[2].text).toBe('-');
    expect(rowOf(doc.budgetVsActualDoc(fy), 'Refunds (not budgeted)')).toBeTruthy();
    expect(sheetRow(render.budgetVarianceWorkbook(odd, { month: 'ytd', ...SGT }), 'Budget Variance', 'Refunds').getCell(3).value).toBe(0);
    expect(sheetRow(render.budgetVsActualWorkbook(fy, SGT), 'Budget vs Actual', 'Refunds').getCell(1).note).toMatch(/Not budgeted/);
    // The workbook keeps the account name exactly as Xero has it, so it can be
    // matched by name; the mark is a cell note there, not a suffix.
    expect(sheetRow(render.budgetVarianceWorkbook(fy, { month: 'ytd', ...SGT }), 'Budget Variance', 'Refunds').getCell(1).value).toBe('Refunds');
    // A budgeted line is not marked.
    expect(rowOf(doc.budgetVsActualDoc(fy), 'Sales')).toBeTruthy();
  });

  test('a missing budget is said before the figures, in both PDFs and both workbooks', () => {
    const none = fyPayload({ budgetMissing: true });
    for (const d of [doc.budgetVsActualDoc(none, SGT), doc.budgetVarianceDoc(none, { month: 'ytd', ...SGT })]) {
      expect(d.content[0].text).toBe('Xero returned no Overall Budget for this period, so budget figures are blank.');
      expect(d.content.findIndex(c => c.table)).toBe(1);
    }
    for (const [wb, name] of [[render.budgetVsActualWorkbook(none, SGT), 'Budget vs Actual'],
      [render.budgetVarianceWorkbook(none, { month: 'ytd', ...SGT }), 'Budget Variance']]) {
      expect(wb.getWorksheet(name).getCell(4, 1).value).toBe(doc.BUDGET_MISSING);
    }
    expect(JSON.stringify(doc.budgetVsActualDoc(fy).content)).not.toContain('no Overall Budget');
    expect(sheetText(render.budgetVsActualWorkbook(fy, SGT), 'Budget vs Actual')).not.toContain('no Overall Budget');
  });
});

// A quarter or custom range is not a year, so the running total names its
// months — and its first month alone used to read "Jul 2026 – Jul 2026".
describe('reports/budget-doc — the running-total heading', () => {
  const quarter = {
    period: { key: 'last-quarter', toDateLabel: 'Period to date' },
    months: [{ key: '2026-07', label: 'Jul 2026' }, { key: '2026-08', label: 'Aug 2026' }],
  };
  test('the first month of a non-year period is just that month', () => {
    expect(doc.cumulativeLabel(quarter, 0)).toBe('To date (Jul 2026)');
  });
  test('a later month names the range from the first', () => {
    expect(doc.cumulativeLabel(quarter, 1)).toBe('To date (Jul 2026 – Aug 2026)');
  });
  test('over a year it is the year to date', () => {
    expect(doc.cumulativeLabel({ ...quarter, period: { key: 'fy', toDateLabel: 'Year to date' } }, 0)).toBe('YTD to Jul 2026');
  });
});
