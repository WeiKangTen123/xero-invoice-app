const { PassThrough } = require('stream');
const cmd    = require('./cash-monthly-doc');
const doc    = require('./budget-doc');
const render = require('./budget-render');

// The document definition is a plain object and the workbook is read back
// cell by cell, so a month missing from the grid, a figure written as text or
// a closing balance coloured wrongly is assertable without rendering a PDF.
// One render at the end proves the definition goes all the way through
// pdfmake.

const TODAY = '2026-10-14';
const MONTHS = [
  { key: '2026-08', label: 'Aug 2026', kind: 'actual' },
  { key: '2026-09', label: 'Sep 2026', kind: 'actual' },
  { key: '2026-10', label: 'Oct 2026', kind: 'current' },
  { key: '2026-11', label: 'Nov 2026', kind: 'forecast' },
  { key: '2026-12', label: 'Dec 2026', kind: 'forecast' },
];
// [key, label, group, values, sources]. Closing goes below zero within the
// 1,000 overdraft in October and past it in November.
const ROWS = [
  ['opening',       'Opening balance',            'balance', [1000, 3000, 3500, -500, -1500]],
  ['in_customer',   'Customer receipts',          'in',      [4000, 0, 1000, 1000, 2000.5]],
  ['in_other',      'Other income & refunds',     'in',      [1000, 0, 0, 0, 0]],
  ['in_finance',    'Loans & capital',            'in',      [0, 2000, 0, 0, 0]],
  ['in_total',      'Total cash in',              'in',      [5000, 2000, 1000, 1000, 2000.5]],
  ['out_supplier',  'Supplier payments',          'out',     [0, 1000, 100, 400, 400]],
  ['out_wages',     'Wages & salaries',           'out',     [0, 0, 0, 1000, 0]],
  ['out_tax',       'GST & tax',                  'out',     [0, 0, 0, 900, 0]],
  ['out_overheads', 'Overheads',                  'out',     [1000, 0, 0, 0, 0]],
  ['out_finance',   'Loan repayments & capex',    'out',     [0, 0, 0, 0, 0]],
  ['out_other',     'Other / unexplained',        'out',     [2000, 500, 4900, 0, 0.5]],
  ['out_total',     'Total cash out',             'out',     [3000, 1500, 5000, 2300, 400.5]],
  ['net',           'Net movement',               'net',     [2000, 500, -4000, -1300, 1600]],
  ['closing',       'Closing balance',            'balance', [3000, 3500, -500, -1800, 100]],
  ['overdue',       'Overdue, not yet scheduled', 'info',    [null, null, 420, null, null]],
];
const SOURCES = { in_customer: ['payments', '', 'payments + open invoices', 'repeating', 'open invoices + budget'], out_other: ['unexplained', 'transfers with accounts left out', 'unexplained', '', 'unexplained'] };

function payload(over = {}) {
  return {
    organisation: { name: 'Nexsoss Pte Ltd', currency: 'SGD' },
    today: TODAY,
    currentMonth: '2026-10',
    past: 2, future: 2, fill: 'budget',
    months: MONTHS.map(m => ({ ...m })),
    rows: ROWS.map(([key, label, group, values]) => ({
      key, label, group, values: [...values], sources: SOURCES[key] || values.map(v => (v === null ? '' : 'bank')),
    })),
    overdue: { in: 500, out: 80, count: 2 },
    overdraft: 1000,
    ties: [],
    notes: ['Months ahead are the Cash Flow Manager\'s forecast.'],
    calls: 0, cached: true, fetchedAt: 1760000000000,
    ...over,
  };
}

const GENERATED = Date.UTC(2026, 9, 14, 9, 0);       // 14 Oct 2026, 17:00 in Singapore
const SGT = { generatedAt: GENERATED, timezone: 'Asia/Singapore' };
const cell = doc._cell;
const { BAND, NEGATIVE, AMBER, AMBER_TINT } = doc._colours;

describe('reports/cash-monthly-doc — the PDF definition', () => {
  const d = cmd.cashMonthlyDefinition(payload(), SGT);
  const grid = d.content[0];
  const body = grid.table.body;

  test('is a landscape page with the budget documents\' header and footer', () => {
    expect(d.pageOrientation).toBe('landscape');
    expect(d.pageSize).toBe('A4');
    const header = JSON.stringify(d.header);
    expect(header).toContain('Nexsoss Pte Ltd');
    expect(header).toContain('Monthly Cash Flow');
    expect(header).toContain('Aug 2026 – Dec 2026 · actual to 14 Oct 2026, forecast after · months ahead filled from the budget · SGD');
    expect(header).toContain('Generated 14 Oct 2026, 17:00');
    expect(header).toContain('Figures read from Xero at');
    expect(JSON.stringify(d.footer(1, 1))).toContain("Figures in SGD, the organisation's base currency.");
  });

  test('the months are banded actual, actual and forecast, forecast, and every month is a column, this one starred', () => {
    expect(grid.table.headerRows).toBe(2);
    expect(body[0].map(c => [c.text, c.colSpan])).toEqual([
      ['', undefined], ['ACTUAL', 2], [undefined, undefined], ['ACTUAL + FORECAST', undefined], ['FORECAST', 2], [undefined, undefined],
    ]);
    expect(body[1].map(c => c.text)).toEqual(['', 'Aug 2026', 'Sep 2026', 'Oct 2026*', 'Nov 2026', 'Dec 2026']);
    expect(grid.table.widths).toHaveLength(6);
  });

  test('every row, in order, under its group heading, with every figure in its column', () => {
    const lines = body.slice(2);
    expect(lines.map(r => r[0].text)).toEqual([
      'Opening balance', 'Cash in', 'Customer receipts', 'Other income & refunds', 'Loans & capital', 'Total cash in',
      'Cash out', 'Supplier payments', 'Wages & salaries', 'GST & tax', 'Overheads', 'Loan repayments & capex',
      'Other / unexplained', 'Total cash out', 'Net movement', 'Closing balance', 'Overdue, not yet scheduled',
    ]);
    for (const [, label, , values] of ROWS) {
      const r = lines.find(x => x[0].text === label);
      // A figure as the screen prints it; no figure is a blank, not a nil dash.
      expect(r.slice(1).map(c => c.text)).toEqual(values.map(v => (v === null ? '' : cell(v))));
      expect(r.slice(1).every(c => c.alignment === 'right')).toBe(true);
    }
    // The group headings span the whole row.
    expect(lines[1][0]).toMatchObject({ text: 'Cash in', style: 'group', colSpan: 6 });
    // The totals and the balances are bold; the overdue line muted.
    expect(lines.find(x => x[0].text === 'Total cash in')[1].style).toBe('strong');
    expect(lines.find(x => x[0].text === 'Customer receipts')[1].style).toBe('account');
    expect(lines.find(x => x[0].text === 'Overdue, not yet scheduled')[3]).toMatchObject({ text: '420.00', italics: true });
  });

  test('a closing balance below the overdraft limit is red, below zero within it amber, and nothing else is coloured', () => {
    const closing = body.find(r => r[0].text === 'Closing balance').slice(1);
    expect(closing.map(c => c.color)).toEqual([undefined, undefined, AMBER, NEGATIVE, undefined]);
    const opening = body.find(r => r[0].text === 'Opening balance').slice(1);
    expect(opening.every(c => c.color === undefined)).toBe(true);
    // With no limit set, any balance below zero is red.
    const none = cmd.cashMonthlyDefinition(payload({ overdraft: 0 }), SGT).content[0].table.body.find(r => r[0].text === 'Closing balance');
    expect(none[3].color).toBe(NEGATIVE);
    expect(cmd.balanceTone(-0.001, 0)).toBeNull();
  });

  test('the past months are shaded and this month tinted, as on screen', () => {
    const fill = grid.layout.fillColor;
    expect([1, 2, 3, 4, 5].map(col => fill(5, null, col))).toEqual([BAND, BAND, AMBER_TINT, null, null]);
    expect(fill(5, null, 0)).toBeNull();
  });

  test('the star is explained, then the overdraft colours, then the payload\'s notes', () => {
    const notes = d.content.slice(1).map(c => c.text);
    expect(notes).toEqual([
      '* Oct 2026 = actual to 14 Oct 2026 and forecast for the rest of the month.',
      'Closing balances below the overdraft limit of 1,000.00 are red; below zero within it, amber.',
      'Months ahead are the Cash Flow Manager\'s forecast.',
    ]);
  });

  test('twenty-five months widen the page rather than run off it', () => {
    const many = Array.from({ length: 25 }, (_, i) => {
      const y = 2025 + Math.floor((i + 9) / 12), m = ((i + 9) % 12) + 1;
      return { key: `${y}-${String(m).padStart(2, '0')}`, label: `M${i}`, kind: i < 12 ? 'actual' : i === 12 ? 'current' : 'forecast' };
    });
    const big = payload({ months: many, rows: ROWS.map(([key, label, group]) => ({ key, label, group, values: many.map(() => -1234567.89), sources: [] })) });
    const def = cmd.cashMonthlyDefinition(big, SGT);
    expect(def.pageSize).toEqual({ width: expect.any(Number), height: 595.28 });
    expect(def.pageSize.width).toBeGreaterThan(841.89);
    expect(def.content[0].table.body[1]).toHaveLength(26);
  });
});

describe('reports/cash-monthly-doc — the workbook', () => {
  const sheetRows = ws => {
    const out = [];
    ws.eachRow((r, n) => out.push([n, r.values.slice(1)]));
    return out;
  };
  const rowBy = (ws, label) => ws.getRow(sheetRows(ws).find(([, v]) => v[0] === label)[0]);
  const values = (row, n) => Array.from({ length: n }, (_, i) => row.getCell(i + 1).value);
  const wb = cmd.cashMonthlyWorkbook(payload(), SGT);

  test('has the grid and its sources, each opening with the title block', () => {
    expect(wb.worksheets.map(w => w.name)).toEqual(['Monthly cash flow', 'Sources']);
    for (const ws of wb.worksheets) {
      const text = sheetRows(ws).map(([, v]) => v.filter(x => typeof x === 'string').join(' ')).join('\n');
      expect(text).toContain('Nexsoss Pte Ltd — Monthly Cash Flow');
      expect(text).toContain('Aug 2026 – Dec 2026 · actual to 14 Oct 2026, forecast after');
      expect(text).toContain('Figures read from Xero at');
    }
  });

  test('the bands are merged over their months, and each month heads a column, this one starred', () => {
    const ws = wb.getWorksheet('Monthly cash flow');
    const head = sheetRows(ws).find(([, v]) => v[1] === 'Aug 2026');
    expect(head[1]).toEqual(['', 'Aug 2026', 'Sep 2026', 'Oct 2026*', 'Nov 2026', 'Dec 2026']);
    const band = ws.getRow(head[0] - 1);
    expect([2, 4, 5].map(c => band.getCell(c).value)).toEqual(['ACTUAL', 'ACTUAL + FORECAST', 'FORECAST']);
    expect(band.getCell(3).isMerged).toBe(true);
    expect(band.getCell(6).isMerged).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: head[0] });
  });

  test('every row is there, its figures as numbers in the money format, no figure as an empty cell', () => {
    const ws = wb.getWorksheet('Monthly cash flow');
    for (const [, label, , vals] of ROWS) {
      const row = rowBy(ws, label);
      expect(values(row, 6)).toEqual([label, ...vals]);
      vals.forEach((v, i) => {
        if (v !== null) expect(typeof row.getCell(i + 2).value).toBe('number');
        expect(row.getCell(i + 2).numFmt).toBe(render.MONEY_FMT);
      });
    }
    expect(rowBy(ws, 'Cash in').getCell(2).value).toBeNull();
    expect(rowBy(ws, 'Cash out')).toBeTruthy();
  });

  test('shades the past months and this one, and colours the closing balance as the PDF does', () => {
    const ws = wb.getWorksheet('Monthly cash flow');
    const opening = rowBy(ws, 'Opening balance');
    expect([2, 3, 4, 5].map(c => opening.getCell(c).fill?.fgColor?.argb)).toEqual(['FFF5F5FA', 'FFF5F5FA', 'FFFDF3DC', undefined]);
    const closing = rowBy(ws, 'Closing balance');
    expect([2, 4, 5].map(c => closing.getCell(c).font?.color?.argb)).toEqual([undefined, render.ARGB.amber, render.ARGB.negative]);
    expect(closing.getCell(2).font).toMatchObject({ bold: true });
  });

  test('carries the footnote and the notes under the grid', () => {
    const ws = wb.getWorksheet('Monthly cash flow');
    const text = sheetRows(ws).map(([, v]) => v[0]);
    expect(text).toContain('* Oct 2026 = actual to 14 Oct 2026 and forecast for the rest of the month.');
    expect(text).toContain('Months ahead are the Cash Flow Manager\'s forecast.');
    expect(text).toContain("Figures in SGD, the organisation's base currency.");
  });

  test('the sources sheet says what each figure was made of, cell for cell', () => {
    const ws = wb.getWorksheet('Sources');
    expect(values(rowBy(ws, 'Customer receipts'), 6)).toEqual(['Customer receipts', ...SOURCES.in_customer]);
    expect(values(rowBy(ws, 'Other / unexplained'), 6)).toEqual(['Other / unexplained', ...SOURCES.out_other]);
  });
});

describe('reports/cash-monthly-doc — filenames', () => {
  test('carry the organisation, the day and the months, with the extension asked for', () => {
    expect(cmd.cashMonthlyFilename(payload(), 'pdf')).toBe('Monthly-Cash-Flow_Nexsoss-Pte-Ltd_2026-10-14_2026-08-to-2026-12.pdf');
    expect(cmd.cashMonthlyFilename(payload(), 'xlsx')).toBe('Monthly-Cash-Flow_Nexsoss-Pte-Ltd_2026-10-14_2026-08-to-2026-12.xlsx');
    expect(cmd.cashMonthlyFilename(payload())).toBe('Monthly-Cash-Flow_Nexsoss-Pte-Ltd_2026-10-14_2026-08-to-2026-12');
  });

  test('sanitise the organisation as the budget exports do', () => {
    expect(cmd.cashMonthlyFilename(payload({ organisation: { name: 'A/B & "C" Ltd.' } }), 'pdf')).toBe('Monthly-Cash-Flow_A-B-C-Ltd_2026-10-14_2026-08-to-2026-12.pdf');
    expect(cmd.cashMonthlyFilename({}, 'pdf')).toBe('Monthly-Cash-Flow_organisation_undated.pdf');
  });
});

describe('reports/cash-monthly-doc — an empty payload', () => {
  test('is an empty report rather than a crash', () => {
    const d = cmd.cashMonthlyDefinition({}, SGT);
    expect(d.content[0].text).toBe('No months to show.');
    expect(cmd.cashMonthlyWorkbook({}, SGT).worksheets).toHaveLength(2);
  });
});

describe('reports/cash-monthly-doc — renders', () => {
  test('the PDF goes all the way through pdfmake', async () => {
    const d = cmd.cashMonthlyDefinition(payload({ organisation: { name: '株式会社テスト', currency: 'SGD' } }), SGT);
    const chunks = [];
    const pdf = render.streamPdf(d, new PassThrough());
    await new Promise((resolve, reject) => { pdf.on('data', c => chunks.push(c)); pdf.on('end', resolve); pdf.on('error', reject); });
    const out = Buffer.concat(chunks);
    expect(out.subarray(0, 5).toString()).toBe('%PDF-');
    expect(out.length).toBeGreaterThan(3000);
  });
});
