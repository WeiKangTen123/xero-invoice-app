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

  test('a section heading spans the full width, so adding a month cannot strand it', () => {
    const body = tableOf(doc.budgetVsActualDoc(payload)).body;
    const section = body.find(r => r[0] && r[0].text === 'Revenue');
    expect(section[0].colSpan).toBe(14);
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

  test('an unknown month key falls back to the first month, never to undefined', () => {
    // A tenant switched mid-render leaves a stale selection behind. Clamping is
    // the safe direction: showing the first month is wrong but readable, where
    // indexing past the array would put "undefined" or NaN on a financial page.
    const stale = tableOf(doc.budgetVarianceDoc(varPayload, { month: 'nope' })).body;
    const first = tableOf(doc.budgetVarianceDoc(varPayload, { month: 'm0' })).body;
    const salesOf = b => b.find(r => r[0] && r[0].text === 'Sales');
    expect(salesOf(stale)[1].text).toBe(salesOf(first)[1].text);
    for (const c of salesOf(stale).slice(1)) {
      expect(c.text).not.toMatch(/undefined|NaN/);
    }
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
      .toBe('Budget-Variance_Flovon-Pte-Ltd_year-to-date');
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
