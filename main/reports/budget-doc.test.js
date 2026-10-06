const doc = require('./budget-doc');

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
  months: months(12, 5),
  rows: [
    { kind: 'section', label: 'Revenue' },
    row('Sales', 'account', new Array(12).fill(100)),
    row('Net profit', 'summary', new Array(12).fill(40)),
  ],
};

// Finds the single table in a document definition.
const tableOf = d => d.content[0].table;

describe('reports/budget-doc — figures read as they do on screen', () => {
  test('zero is a dash, not 0.00 — matching Xero, where nil and no-activity look alike', () => {
    expect(doc._cell(0)).toBe('-');
    expect(doc._cell(null)).toBe('-');
  });

  test('a negative is parenthesised rather than signed', () => {
    expect(doc._cell(-1234.5)).toBe('(1,234.50)');
    expect(doc._cell(1234.5)).toBe('1,234.50');
  });

  test('a percentage carries its sign so a variance reads as direction, not size', () => {
    expect(doc._pct(0.064)).toBe('+6.4%');
    expect(doc._pct(-0.12)).toBe('-12.0%');
  });
});

describe('reports/budget-doc — Budget vs Actual grid', () => {
  test('is landscape, because twelve months and a total will not fit portrait', () => {
    expect(doc.budgetVsActualDoc(payload).pageOrientation).toBe('landscape');
  });

  test('every row has one cell per month plus the account and the total', () => {
    const body = tableOf(doc.budgetVsActualDoc(payload)).body;
    const dataRow = body.find(r => r[0] && r[0].text === 'Sales');
    expect(dataRow).toHaveLength(14); // account + 12 months + total
  });

  test('the seam rule falls between the last actual month and the first budget one', () => {
    const d = doc.budgetVsActualDoc(payload);
    const { vLineWidth } = d.content[0].layout;
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
    expect(d.content[0].layout.vLineWidth(3)).toBe(0);
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
    const body = tableOf(doc.budgetVarianceDoc(varPayload, { month: 'ytd' })).body;
    const sales = body.find(r => r[0] && r[0].text === 'Sales');
    expect(sales[1].text).toBe('100.00'); // actualToDate
    expect(sales[2].text).toBe('80.00');  // budgetToDate
  });

  test('a named month reports that month alone', () => {
    const body = tableOf(doc.budgetVarianceDoc(varPayload, { month: 'm3' })).body;
    const sales = body.find(r => r[0] && r[0].text === 'Sales');
    expect(sales[1].text).toBe('30.00'); // monthly[3].actual
    expect(sales[2].text).toBe('24.00'); // monthly[3].budget
  });

  test('an unknown month key reports the year to date — figures, title and filename alike', () => {
    // A tenant switched mid-render leaves a stale selection behind. It used to
    // show the first month's figures under a filename naming the month asked
    // for, so the file said one thing and held another.
    const stale = doc.budgetVarianceDoc(varPayload, { month: 'nope' });
    const ytd   = doc.budgetVarianceDoc(varPayload, { month: 'ytd' });
    const salesOf = d => tableOf(d).body.find(r => r[0] && r[0].text === 'Sales');
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
    const render = require('./budget-render');
    const cellsOf = wb => {
      const out = [];
      wb.getWorksheet('Budget Variance').eachRow(r => out.push(r.values.slice(1)));
      return out;
    };
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
  test('carries the organisation and period, so a download is identifiable', () => {
    expect(doc.exportFilename('grid', payload, {})).toBe('Budget-vs-Actual_Flovon-Pte-Ltd_FY-to-Mar-2027');
    expect(doc.exportFilename('variance', payload, { month: 'ytd' }))
      .toBe('Budget-Variance_Flovon-Pte-Ltd_year-to-date_FY-to-Mar-2027');
    expect(doc.exportFilename('variance', payload, { month: 'm3' }))
      .toBe('Budget-Variance_Flovon-Pte-Ltd_M3');
  });

  test('survives an organisation with no name', () => {
    expect(doc.exportFilename('grid', { organisation: {} }, {})).toContain('organisation');
  });

  // The standard PDF fonts are Latin-1. Folding beats throwing part-way through
  // a response whose headers have already gone out.
  test('folds characters the standard PDF fonts cannot draw', () => {
    expect(doc._latin1('Café Ltd')).toBe('Café Ltd');
    expect(doc._latin1('北京公司')).toBe('????');
    expect(doc._latin1('A–B')).toBe('A-B');
  });
});

// What the variance export is titled. It said "Oct 2026" for a month six days
// old, which reads as a closed month, and "Year to date" for any period.
describe('reports/budget-doc — what the variance figures cover', () => {
  const months = [{ key: '2026-09', label: 'Sep 2026' }, { key: '2026-10', label: 'Oct 2026' }];
  const payload = {
    months,
    period: { key: 'fy' },
    kpis: { currentMonth: { key: '2026-10', label: 'Oct 2026', asOf: '2026-10-06' } },
  };

  test('a month in progress says so, with the day it was read', () => {
    expect(doc.varianceLabel(payload, '2026-10')).toBe('Oct 2026 so far, as of 6 Oct 2026');
  });

  test('a closed month is just its name', () => {
    expect(doc.varianceLabel(payload, '2026-09')).toBe('Sep 2026');
  });

  test('the rollup is a year to date only when the period is a year', () => {
    expect(doc.varianceLabel(payload, 'ytd')).toBe('Year to date');
    expect(doc.varianceLabel({ ...payload, period: { key: 'last-6' } }, 'ytd')).toBe('Period to date');
    expect(doc.varianceLabel({ months }, 'ytd')).toBe('Year to date'); // no period: the old default
  });

  test('the PDF header carries the label', () => {
    const def = doc.budgetVarianceDoc({ ...payload, rows: [], organisation: { name: 'Org' } }, { month: '2026-10', generatedAt: 0 });
    expect(JSON.stringify(def.header)).toContain('Oct 2026 so far, as of 6 Oct 2026');
  });

  test('dayLabel reads the date as written, and refuses anything else', () => {
    expect(doc.dayLabel('2026-01-31')).toBe('31 Jan 2026');
    expect(doc.dayLabel('nope')).toBe('');
  });
});

// A rollup export said only "Year to date", under a filename ending
// _year-to-date, whatever the period: this year's and last year's were the
// same title and the same file name, and the second download overwrote the first.
describe('reports/budget-doc — a rollup export names its period', () => {
  const base = { organisation: { name: 'Org', currency: 'SGD' }, rows: [] };
  const thisYear = {
    ...base,
    period: { key: 'fy' },
    fiscalYear: { label: 'For the year ended 31 December 2026' },
    months: [{ key: '2026-01', label: 'Jan 2026' }, { key: '2026-12', label: 'Dec 2026' }],
  };
  const lastYear = {
    ...base,
    period: { key: 'prev-fy' },
    fiscalYear: { label: 'Previous financial year · Jan 2025 – Dec 2025' },
    months: [{ key: '2025-01', label: 'Jan 2025' }, { key: '2025-12', label: 'Dec 2025' }],
  };

  test('the subtitle carries the period after the year-to-date wording', () => {
    expect(doc.varianceSubtitle(thisYear, 'ytd')).toBe('Year to date · For the year ended 31 December 2026');
    expect(doc.varianceSubtitle(lastYear, 'ytd')).toBe('Year to date · Previous financial year · Jan 2025 – Dec 2025');
  });

  test('without a period title it names the first and last month', () => {
    const bare = { ...thisYear, fiscalYear: {} };
    expect(doc.varianceSubtitle(bare, 'ytd')).toBe('Year to date · Jan 2026 – Dec 2026');
    expect(doc.periodText({ months: [{ key: '2026-03', label: 'Mar 2026' }] })).toBe('Mar 2026');
  });

  test('a single month names itself and nothing more', () => {
    expect(doc.varianceSubtitle(thisYear, '2026-12')).toBe('Dec 2026');
  });

  test('this year and last year export under different titles and filenames', () => {
    const header = p => JSON.stringify(doc.budgetVarianceDoc(p, { month: 'ytd', generatedAt: 0 }).header);
    expect(header(thisYear)).toContain('For the year ended 31 December 2026');
    expect(header(lastYear)).toContain('Previous financial year');
    expect(header(thisYear)).not.toBe(header(lastYear));

    expect(doc.exportFilename('variance', thisYear, { month: 'ytd' }))
      .toBe('Budget-Variance_Org_year-to-date_For-the-year-ended-31-December-2026');
    expect(doc.exportFilename('variance', lastYear, { month: 'ytd' }))
      .toBe('Budget-Variance_Org_year-to-date_Previous-financial-year-Jan-2025-Dec-2025');
  });

  test('a period that is not a year says period to date, in the title and the filename', () => {
    const six = { ...thisYear, period: { key: 'last-6' }, fiscalYear: { label: 'Last 6 months · May 2026 – Oct 2026' } };
    expect(doc.varianceSubtitle(six, 'ytd')).toBe('Period to date · Last 6 months · May 2026 – Oct 2026');
    expect(doc.exportFilename('variance', six, {})).toBe('Budget-Variance_Org_period-to-date_Last-6-months-May-2026-Oct-2026');
  });

  test('the workbook subtitle carries the period too', () => {
    const render = require('./budget-render');
    const wb = render.budgetVarianceWorkbook(lastYear, { month: 'ytd', generatedAt: 0 });
    expect(String(wb.getWorksheet('Budget Variance').getCell(2, 1).value)).toContain('Previous financial year · Jan 2025 – Dec 2025');
  });
});

// The screen shows what has been booked so far in the month in progress,
// beside the grid; the grid itself shows that month as budget. The export had
// the grid and not the note, so it lacked a figure the reader had just seen.
describe('reports/budget-doc — the month in progress, in the grid export', () => {
  const render = require('./budget-render');
  const withCurrent = {
    ...payload,
    kpis: { currentMonth: { key: 'm5', label: 'Oct 2026', asOf: '2026-10-06', actualNet: 12345, budgetNet: 17615 } },
  };
  const NOTE = 'Oct 2026 so far, as of 6 Oct 2026: net profit 12,345.00 booked against 17,615.00 budgeted. Not included in the figures above.';
  const sheetText = wb => {
    const out = [];
    wb.getWorksheet('Budget vs Actual').eachRow(r => out.push(r.values.filter(v => typeof v === 'string').join(' ')));
    return out.join('\n');
  };

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
    expect(sheetText(render.budgetVsActualWorkbook(withCurrent, { generatedAt: 0 }))).toContain(NOTE);
    expect(sheetText(render.budgetVsActualWorkbook(payload, { generatedAt: 0 }))).not.toMatch(/so far/);
  });

  test('without a read date it still says so far, just not when', () => {
    const noDate = { ...withCurrent, kpis: { currentMonth: { ...withCurrent.kpis.currentMonth, asOf: null } } };
    expect(doc.soFarNote(noDate)).toMatch(/^Oct 2026 so far: net profit 12,345.00/);
  });
});
