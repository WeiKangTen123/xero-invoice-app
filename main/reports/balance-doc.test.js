const { PassThrough } = require('stream');
const balance = require('./balance-doc');
const doc     = require('./budget-doc');
const render  = require('./budget-render');

// The document definition is a plain object and the workbook is read back
// cell by cell, so what goes wrong in an export — a figure under the wrong
// column, a total that is not bold, a label that never made it onto the page —
// is assertable without rendering a PDF. One render at the end proves the
// definition goes all the way through pdfmake.

// The payload as the balance sheet route sends it: three month-end columns,
// newest first, over Xero's standard layout.
function payload(over = {}) {
  return {
    organisation: { name: 'Nexsoss Pte Ltd', currency: 'SGD' },
    asAt: { iso: '2026-09-30', label: '30 September 2026', preset: 'last-month-end', inProgress: false },
    basis: 'accrual',
    compare: { type: 'month', periods: 2 },
    columns: [{ iso: '2026-09-30', label: '30 Sep 2026' }, { iso: '2026-08-31', label: '31 Aug 2026' }, { iso: '2026-07-31', label: '31 Jul 2026' }],
    groups: [
      {
        key: 'assets', title: 'Assets',
        subgroups: [
          {
            title: 'Bank',
            rows: [{ label: 'Aspire SGD account', accountId: 'a1', code: '090', values: [135491, 120250, 118900] }],
            total: { label: 'Total Bank', values: [135491, 120250, 118900] },
          },
          {
            title: 'Current Assets',
            rows: [{ label: 'Accounts Receivable', code: '610', values: [0, 12000, 0] }],
            total: { label: 'Total Current Assets', values: [0, 12000, 0] },
          },
        ],
        total: { label: 'Total Assets', values: [135491, 132250, 118900] },
      },
      {
        key: 'liabilities', title: 'Liabilities',
        subgroups: [
          {
            title: 'Current Liabilities',
            rows: [{ label: 'Accounts Payable', code: '800', values: [0, 3469, 0] }],
            total: { label: 'Total Current Liabilities', values: [0, 3469, 0] },
          },
        ],
        total: { label: 'Total Liabilities', values: [0, 3469, 0] },
      },
      {
        key: 'equity', title: 'Equity',
        subgroups: [
          {
            title: '',
            rows: [
              { label: 'Current Year Earnings', code: null, values: [35491, 28781, 18900] },
              { label: 'Owner A Share Capital', code: '970', values: [100000, 100000, 100000] },
            ],
            total: null,
          },
        ],
        total: { label: 'Total Equity', values: [135491, 128781, 118900] },
      },
    ],
    netAssets: { label: 'Net Assets', values: [135491, 128781, 118900] },
    notes: ['Balances are as at each month end.'],
    cached: true,
    fetchedAt: 1760000000000,
    ...over,
  };
}

const GENERATED = Date.UTC(2026, 9, 10, 9, 0);       // 10 Oct 2026, 17:00 in Singapore
const SGT = { generatedAt: GENERATED, timezone: 'Asia/Singapore' };

// Every line of the report in print order, label and figures, as the payload
// has them — the thing both files must reproduce.
const EXPECTED = [
  ['ASSETS'],
  ['Bank'],
  ['Aspire SGD account', [135491, 120250, 118900]],
  ['Total Bank', [135491, 120250, 118900]],
  ['Current Assets'],
  ['Accounts Receivable', [0, 12000, 0]],
  ['Total Current Assets', [0, 12000, 0]],
  ['Total Assets', [135491, 132250, 118900]],
  ['LIABILITIES'],
  ['Current Liabilities'],
  ['Accounts Payable', [0, 3469, 0]],
  ['Total Current Liabilities', [0, 3469, 0]],
  ['Total Liabilities', [0, 3469, 0]],
  ['NET ASSETS', [135491, 128781, 118900]],
  ['EQUITY'],
  ['Current Year Earnings', [35491, 28781, 18900]],
  ['Owner A Share Capital', [100000, 100000, 100000]],
  ['Total Equity', [135491, 128781, 118900]],
];
const TOTALS = ['Total Bank', 'Total Current Assets', 'Total Assets', 'Total Current Liabilities', 'Total Liabilities', 'NET ASSETS', 'Total Equity'];

const tableOf = d => d.content.find(c => c.table).table;
const bodyOf  = d => tableOf(d).body;
const rowOf   = (d, label) => bodyOf(d).find(r => r[0] && r[0].text === label);
const textOf  = d => JSON.stringify(d.content) + JSON.stringify(d.header);

// Every line of the sheet as [row number, values], for finding things by text.
function sheetRows(wb) {
  const out = [];
  wb.getWorksheet('Balance Sheet').eachRow((r, n) => out.push([n, r.values.slice(1)]));
  return out;
}
const sheetRow = (wb, label) => {
  const hit = sheetRows(wb).find(([, v]) => v[0] === label);
  return hit ? wb.getWorksheet('Balance Sheet').getRow(hit[0]) : null;
};
const sheetText = wb => sheetRows(wb).map(([, v]) => v.filter(x => typeof x === 'string').join(' ')).join('\n');

describe('reports/balance-doc — the PDF definition', () => {
  const d = balance.balanceSheetDefinition(payload(), SGT);

  test('the column header row carries the column labels, newest first as in the payload', () => {
    expect(bodyOf(d)[0].map(c => c.text)).toEqual(['Account', '30 Sep 2026', '31 Aug 2026', '31 Jul 2026']);
    expect(tableOf(d).headerRows).toBe(1);
  });

  test('every label is on the page, in Xero\'s order, with every figure under the right column', () => {
    const lines = bodyOf(d).slice(1).map(r => [r[0].text, r.slice(1).map(c => c.text)]);
    expect(lines).toEqual(EXPECTED.map(([label, values]) => [
      label,
      values ? values.map(doc._cell) : ['', '', ''],
    ]));
    expect(rowOf(d, 'Aspire SGD account').slice(1).map(c => c.text)).toEqual(['135,491.00', '120,250.00', '118,900.00']);
  });

  test('group titles are in caps and Net Assets sits between liabilities and equity', () => {
    const labels = bodyOf(d).slice(1).map(r => r[0].text);
    expect(labels.filter(l => l === l.toUpperCase() && /[A-Z]/.test(l))).toEqual(['ASSETS', 'LIABILITIES', 'NET ASSETS', 'EQUITY']);
    expect(labels.indexOf('NET ASSETS')).toBe(labels.indexOf('Total Liabilities') + 1);
    expect(labels.indexOf('NET ASSETS')).toBe(labels.indexOf('EQUITY') - 1);
  });

  test('totals and Net Assets are bold; accounts are not, and are indented', () => {
    for (const t of TOTALS) {
      const r = rowOf(d, t);
      expect(r.map(c => c.style)).toEqual(new Array(4).fill('strong'));
    }
    const acct = rowOf(d, 'Aspire SGD account');
    expect(acct.map(c => c.style)).toEqual(new Array(4).fill('account'));
    expect(acct[0].margin[0]).toBeGreaterThan(0);
    expect(rowOf(d, 'Total Bank')[0].margin[0]).toBe(0);
  });

  test('zero is a dash and a negative is parenthesised, as on screen and in Xero', () => {
    expect(rowOf(d, 'Accounts Receivable').slice(1).map(c => c.text)).toEqual(['-', '12,000.00', '-']);
    const p = payload();
    p.groups[0].subgroups[0].rows[0].values = [-1234.5, 0, 0.004];
    const neg = rowOf(balance.balanceSheetDefinition(p, SGT), 'Aspire SGD account');
    expect(neg.slice(1).map(c => c.text)).toEqual(['(1,234.50)', '-', '-']);
  });

  test('the header names the organisation, the day, the comparison, the basis and the currency', () => {
    const header = JSON.stringify(d.header);
    expect(header).toContain('Nexsoss Pte Ltd');
    expect(header).toContain('Balance Sheet');
    expect(header).toContain('As at 30 September 2026 · Compared with 2 previous months · Accrual basis · SGD');
    expect(header).toContain('Figures read from Xero at');
    expect(header).toContain('Generated 10 Oct 2026, 17:00');
    expect(balance.balanceSubtitle(payload({ compare: null, basis: 'cash' }))).toBe('As at 30 September 2026 · Cash basis · SGD');
  });

  test('the footer says the figures are in the base currency, and the notes close the page', () => {
    expect(d.footer(1, 2).columns[0].text).toBe("Figures in SGD, the organisation's base currency.");
    expect(d.footer(1, 2).columns[1].text).toBe('Page 1 of 2');
    const notes = d.content.filter(c => c.style === 'note').map(c => c.text);
    expect(notes).toEqual(['Balances are as at each month end.']);
    expect(d.content[d.content.length - 1].text).toBe('Balances are as at each month end.');
  });

  test('a rule sits above every total and below Net Assets, and the body has the full width', () => {
    const body   = bodyOf(d);
    const layout = d.content.find(c => c.table).layout;
    for (const t of TOTALS) expect(layout.hLineWidth(body.findIndex(r => r[0].text === t))).toBe(0.7);
    expect(layout.hLineWidth(body.findIndex(r => r[0].text === 'NET ASSETS') + 1)).toBe(0.7);
    expect(layout.hLineWidth(body.findIndex(r => r[0].text === 'Aspire SGD account'))).toBe(0);
    expect(layout.hLineWidth(1)).toBe(0.7);
    for (const r of body) expect(r).toHaveLength(4);
  });

  test('is portrait for a few columns and landscape for a long comparison', () => {
    expect(d.pageOrientation).toBe('portrait');
    const cols = Array.from({ length: 6 }, (_, i) => ({ iso: `2026-0${9 - i}-30`, label: `M${i}` }));
    expect(balance.balanceSheetDefinition(payload({ columns: cols, compare: { type: 'month', periods: 5 } }), SGT).pageOrientation).toBe('landscape');
  });
});

describe('reports/balance-doc — equity named like its group', () => {
  test('prints one Equity heading, not a group title and a subgroup title', () => {
    const { balanceLines } = require('./balance-doc');
    const lines = balanceLines({
      organisation: { name: 'Org', currency: 'SGD' }, asAt: { iso: '2026-09-30', label: '30 September 2026' }, basis: 'accrual',
      compare: { type: 'none', periods: 0 }, columns: [{ iso: '2026-09-30', label: '30 Sep 2026' }],
      groups: [{ key: 'equity', title: 'Equity', subgroups: [
        { title: 'Equity', rows: [{ label: 'Owner A Share Capital', values: [100000] }], total: { label: 'Total Equity', values: [100000] } },
      ], total: null }],
      netAssets: { label: 'Net Assets', values: [100000] }, notes: [],
    });
    const labels = lines.map(l => `${l.kind}:${l.label}`);
    expect(labels.filter(l => /^(group|subgroup):equity$/i.test(l))).toEqual(['group:EQUITY']);
    expect(lines.some(l => l.label === 'Owner A Share Capital')).toBe(true);
    expect(lines.some(l => l.kind === 'subgroup')).toBe(false);
  });
});

describe('reports/balance-doc — the month in progress', () => {
  const live = payload({ asAt: { iso: '2026-10-30', label: '30 October 2026', preset: 'today', inProgress: true } });
  const NOTE = '30 Oct 2026 — month in progress: includes everything dated in October as Xero holds it';

  test('the note is worded from the as-at day, and only when the month is in progress', () => {
    expect(balance.inProgressNote(live.asAt)).toBe(NOTE);
    expect(balance.inProgressNote(payload().asAt)).toBe('');
    expect(balance.inProgressNote(undefined)).toBe('');
  });

  test('the PDF says so before the figures, and a closed month says nothing', () => {
    const d = balance.balanceSheetDefinition(live, SGT);
    expect(d.content[0].text).toBe(NOTE);
    expect(d.content[1].table).toBeDefined();
    expect(textOf(balance.balanceSheetDefinition(payload(), SGT))).not.toContain('month in progress');
  });

  test('the workbook says so above the table, and a closed month says nothing', () => {
    expect(sheetText(balance.balanceSheetWorkbook(live, SGT))).toContain(NOTE);
    expect(sheetText(balance.balanceSheetWorkbook(payload(), SGT))).not.toContain('month in progress');
    // The header row still lands above the figures, with the panes frozen under it.
    const ws = balance.balanceSheetWorkbook(live, SGT).getWorksheet('Balance Sheet');
    const headRow = sheetRows(balance.balanceSheetWorkbook(live, SGT)).find(([, v]) => v[0] === 'Account')[0];
    expect(ws.views[0].ySplit).toBe(headRow);
  });
});

describe('reports/balance-doc — account codes', () => {
  test('are off by default and follow the name when asked for, in both files', () => {
    expect(rowOf(balance.balanceSheetDefinition(payload(), SGT), 'Aspire SGD account')).toBeDefined();
    const d  = balance.balanceSheetDefinition(payload(), { ...SGT, codes: true });
    const wb = balance.balanceSheetWorkbook(payload(), { ...SGT, codes: true });
    expect(rowOf(d, 'Aspire SGD account · 090')).toBeDefined();
    expect(rowOf(d, 'Total Bank')).toBeDefined();              // totals carry no code
    expect(rowOf(d, 'Current Year Earnings')).toBeDefined();   // and nor does a line without one
    expect(sheetRow(wb, 'Aspire SGD account · 090')).not.toBeNull();
    expect(sheetRow(wb, 'Current Year Earnings')).not.toBeNull();
  });
});

describe('reports/balance-doc — zero-balance rows', () => {
  // Petty cash with nothing in any column, beside an account that is nil in
  // one column only.
  const withNil = () => {
    const p = payload();
    p.groups[0].subgroups[0].rows.push({ label: 'Petty Cash', code: '091', values: [0, 0, 0.004] });
    return p;
  };

  test('are left out unless asked for, as on screen; an account nil in one column only stays, and totals always print', () => {
    expect(balance.balanceLines(withNil()).map(l => l.label)).not.toContain('Petty Cash');
    expect(balance.balanceLines(withNil()).map(l => l.label)).toContain('Accounts Receivable');
    expect(balance.balanceLines(withNil(), { zeroRows: true }).map(l => l.label)).toContain('Petty Cash');
    const totals = { groups: [{ key: 'assets', title: 'Assets', subgroups: [
      { title: 'Bank', rows: [{ label: 'Petty Cash', values: [0] }], total: { label: 'Total Bank', values: [0] } },
    ], total: { label: 'Total Assets', values: [0] } }] };
    expect(balance.balanceLines(totals).map(l => `${l.kind}:${l.label}`)).toEqual(['group:ASSETS', 'subgroup:Bank', 'subtotal:Total Bank', 'total:Total Assets']);
  });

  test('in both files', () => {
    expect(rowOf(balance.balanceSheetDefinition(withNil(), SGT), 'Petty Cash')).toBeUndefined();
    expect(rowOf(balance.balanceSheetDefinition(withNil(), { ...SGT, zeroRows: true }), 'Petty Cash')).toBeDefined();
    expect(sheetRow(balance.balanceSheetWorkbook(withNil(), SGT), 'Petty Cash')).toBeNull();
    expect(sheetRow(balance.balanceSheetWorkbook(withNil(), { ...SGT, zeroRows: true }), 'Petty Cash')).not.toBeNull();
  });
});

describe('reports/balance-doc — whole numbers', () => {
  const p = () => {
    const x = payload();
    x.groups[0].subgroups[0].rows[0].values = [135490.5, -2.5, 0.4];
    return x;
  };

  test('the PDF prints whole units, rounding half away from zero, a nil as a dash, and says how totals were rounded', () => {
    const d = balance.balanceSheetDefinition(p(), { ...SGT, decimals: false });
    expect(rowOf(d, 'Aspire SGD account').slice(1).map(c => c.text)).toEqual(['135,491', '(3)', '-']);
    expect(rowOf(d, 'Total Assets').slice(1).map(c => c.text)).toEqual(['135,491', '132,250', '118,900']);
    expect(d.content.filter(c => c.style === 'note').map(c => c.text)).toContainEqual(expect.stringMatching(/^Figures are rounded to whole units/));
    // Decimals on is the default, and prints cents as before.
    expect(rowOf(balance.balanceSheetDefinition(p(), SGT), 'Aspire SGD account').slice(1).map(c => c.text)).toEqual(['135,490.50', '(2.50)', '0.40']);
  });

  test('the workbook writes whole numbers in a format without cents, so a cell holds what it shows', () => {
    const row = sheetRow(balance.balanceSheetWorkbook(p(), { ...SGT, decimals: false }), 'Aspire SGD account');
    expect([2, 3, 4].map(c => row.getCell(c).value)).toEqual([135491, -3, 0]);
    expect([2, 3, 4].map(c => row.getCell(c).numFmt)).toEqual(new Array(3).fill(balance.WHOLE_FMT));
    expect(balance.WHOLE_FMT).toBe('#,##0;(#,##0);"-"');
  });
});

describe('reports/balance-doc — Change and %', () => {
  const opts = { ...SGT, change: true };

  test('sit right after the first two columns, as on screen', () => {
    const d = balance.balanceSheetDefinition(payload(), opts);
    expect(bodyOf(d)[0].map(c => c.text)).toEqual(['Account', '30 Sep 2026', '31 Aug 2026', 'Change', '%', '31 Jul 2026']);
    expect(sheetRow(balance.balanceSheetWorkbook(payload(), opts), 'Account').values.slice(1))
      .toEqual(['Account', '30 Sep 2026', '31 Aug 2026', 'Change', '%', '31 Jul 2026']);
  });

  test('change is the first column less the second, % that over the second\'s size, on every line with totals and Net Assets', () => {
    const d = balance.balanceSheetDefinition(payload(), opts);
    // 135,491 against 120,250: up 15,241, or 12.7%.
    expect(rowOf(d, 'Aspire SGD account').slice(1).map(c => c.text)).toEqual(['135,491.00', '120,250.00', '15,241.00', '12.7%', '118,900.00']);
    // 0 against 12,000: down all of it.
    expect(rowOf(d, 'Accounts Receivable').slice(1).map(c => c.text)).toEqual(['-', '12,000.00', '(12,000.00)', '-100.0%', '-']);
    expect(rowOf(d, 'NET ASSETS').slice(1).map(c => c.text)).toEqual(['135,491.00', '128,781.00', '6,710.00', '5.2%', '118,900.00']);
    expect(rowOf(d, 'Total Liabilities').slice(1, 5).map(c => c.text)).toEqual(['-', '3,469.00', '(3,469.00)', '-100.0%']);
    expect(d.content.filter(c => c.style === 'note').map(c => c.text)).toContainEqual(expect.stringMatching(/^Change is the first column less the second/));
  });

  test('a nil second column has no percentage: a dash, not a division by nothing', () => {
    const p = payload();
    p.groups[0].subgroups[0].rows[0].values = [500, 0, 0];
    expect(balance.changeOf([500, 0])).toEqual({ change: 500, pct: null });
    expect(balance.changeOf([-50, -200])).toEqual({ change: 150, pct: 0.75 });
    expect(balance.changeOf([1])).toBeNull();
    expect(rowOf(balance.balanceSheetDefinition(p, opts), 'Aspire SGD account').slice(3, 5).map(c => c.text)).toEqual(['500.00', '—']);
    const row = sheetRow(balance.balanceSheetWorkbook(p, opts), 'Aspire SGD account');
    expect([4, 5].map(c => row.getCell(c).value)).toEqual([500, '—']);
  });

  test('the workbook writes the change in money and % as a fraction in a percentage format', () => {
    const row = sheetRow(balance.balanceSheetWorkbook(payload(), opts), 'Aspire SGD account');
    expect([2, 3, 4, 5, 6].map(c => row.getCell(c).value)).toEqual([135491, 120250, 15241, 0.1267, 118900]);
    expect(row.getCell(4).numFmt).toBe(render.MONEY_FMT);
    expect(row.getCell(5).numFmt).toBe(balance.PCT_FMT);
  });

  test('are not added to a sheet with one column, and a long comparison with them goes landscape', () => {
    const one = payload({ columns: payload().columns.slice(0, 1), compare: null });
    expect(bodyOf(balance.balanceSheetDefinition(one, opts))[0].map(c => c.text)).toEqual(['Account', '30 Sep 2026']);
    expect(balance.balanceSheetDefinition(payload(), opts).pageOrientation).toBe('landscape');
  });
});

describe('reports/balance-doc — a sheet built from the Trial Balance', () => {
  const exact = payload({
    asAt: { iso: '2026-10-14', label: '14 October 2026', preset: 'today', inProgress: true, source: 'trial-balance' },
    exactDates: { ok: true, at: '2026-09-30', atLabel: '30 Sep 2026' },
  });

  test('says how it was built, and that today can still move, not that a month is in progress', () => {
    expect(balance.inProgressNote(exact.asAt)).toBe('14 Oct 2026 — today: includes everything dated up to today as Xero holds it, and can still change before the day ends');
    const notes = balance.balanceSheetDefinition(exact, SGT).content.filter(c => c.style === 'note').map(c => c.text);
    expect(notes).toContainEqual("Built from Xero's Trial Balance as at each date, since Xero's Balance Sheet report can only be as at a month end. Built the same way at 30 Sep 2026, it agreed with Xero's Balance Sheet account by account.");
    expect(sheetText(balance.balanceSheetWorkbook(exact, SGT))).toContain("Built from Xero's Trial Balance as at each date");
    expect(textOf(balance.balanceSheetDefinition(payload(), SGT))).not.toContain('Trial Balance');
  });
});

describe('reports/balance-doc — the workbook', () => {
  const wb = balance.balanceSheetWorkbook(payload(), SGT);

  test('has one sheet, "Balance Sheet", with a header block naming the organisation, the day, the basis and the read time', () => {
    expect(wb.worksheets.map(w => w.name)).toEqual(['Balance Sheet']);
    const text = sheetText(wb);
    expect(text).toContain('Nexsoss Pte Ltd — Balance Sheet');
    expect(text).toContain('As at 30 September 2026 · Compared with 2 previous months · Accrual basis · SGD · Generated 10 Oct 2026, 17:00');
    expect(text).toContain('Figures read from Xero at');
  });

  test('the column labels are the payload\'s, newest first', () => {
    const head = sheetRow(wb, 'Account');
    expect(head.values.slice(1)).toEqual(['Account', '30 Sep 2026', '31 Aug 2026', '31 Jul 2026']);
    expect(head.font.bold).toBe(true);
  });

  test('every row carries the payload\'s values as numbers, under every column, in the money format', () => {
    const lines = sheetRows(wb).map(([, v]) => v[0]);
    const first = lines.indexOf('ASSETS');
    expect(lines.slice(first, first + EXPECTED.length)).toEqual(EXPECTED.map(([label]) => label));
    for (const [label, values] of EXPECTED) {
      const row = sheetRow(wb, label);
      if (!values) {
        expect(row.getCell(2).value).toBeNull();
        continue;
      }
      expect([2, 3, 4].map(c => row.getCell(c).value)).toEqual(values);
      expect([2, 3, 4].map(c => row.getCell(c).numFmt)).toEqual(new Array(3).fill(render.MONEY_FMT));
      expect(render.MONEY_FMT).toBe('#,##0.00;(#,##0.00);"-"');
    }
  });

  test('totals, Net Assets and headings are bold; accounts are not', () => {
    for (const t of TOTALS) expect({ t, bold: sheetRow(wb, t).font.bold }).toEqual({ t, bold: true });
    for (const h of ['ASSETS', 'Bank', 'EQUITY']) expect(sheetRow(wb, h).font.bold).toBe(true);
    expect(sheetRow(wb, 'Aspire SGD account').font?.bold).toBeFalsy();
    expect(sheetRow(wb, 'Aspire SGD account').getCell(1).alignment.indent).toBe(1);
  });

  test('cents of float noise are written as the cents the PDF prints', () => {
    const p = payload();
    p.groups[0].subgroups[0].rows[0].values = [9857.100000000002, -0.004, 0];
    const row = sheetRow(balance.balanceSheetWorkbook(p, SGT), 'Aspire SGD account');
    expect([2, 3, 4].map(c => row.getCell(c).value)).toEqual([9857.1, 0, 0]);
  });

  test('the notes and the currency line close the sheet', () => {
    const lines = sheetRows(wb).map(([, v]) => v[0]);
    expect(lines.slice(-2)).toEqual(['Balances are as at each month end.', "Figures in SGD, the organisation's base currency."]);
  });
});

describe('reports/balance-doc — filenames', () => {
  test('carry the organisation, the day and the comparison, with the extension asked for', () => {
    expect(balance.balanceFilename(payload(), 'pdf')).toBe('Balance-Sheet_Nexsoss-Pte-Ltd_as-at-2026-09-30_vs-2-prev-months.pdf');
    expect(balance.balanceFilename(payload(), 'xlsx')).toBe('Balance-Sheet_Nexsoss-Pte-Ltd_as-at-2026-09-30_vs-2-prev-months.xlsx');
  });

  test('leave the comparison out when there is none, and the extension out when none is asked for', () => {
    expect(balance.balanceFilename(payload({ compare: null }), 'pdf')).toBe('Balance-Sheet_Nexsoss-Pte-Ltd_as-at-2026-09-30.pdf');
    expect(balance.balanceFilename(payload({ compare: { type: 'month', periods: 0 } }), 'pdf')).toBe('Balance-Sheet_Nexsoss-Pte-Ltd_as-at-2026-09-30.pdf');
    expect(balance.balanceFilename(payload({ compare: null }))).toBe('Balance-Sheet_Nexsoss-Pte-Ltd_as-at-2026-09-30');
    expect(balance.balanceFilename(payload({ compare: { type: 'year', periods: 1 } }), 'pdf')).toBe('Balance-Sheet_Nexsoss-Pte-Ltd_as-at-2026-09-30_vs-1-prev-year.pdf');
  });

  test('sanitise the organisation as the budget exports do', () => {
    const odd = payload({ organisation: { name: 'Müller & Söhne (SG) Pte. Ltd.', currency: 'SGD' }, compare: null });
    expect(balance.balanceFilename(odd, 'pdf')).toBe('Balance-Sheet_Müller-Söhne-SG-Pte-Ltd_as-at-2026-09-30.pdf');
    expect(balance.balanceFilename({ organisation: {} }, 'pdf')).toBe('Balance-Sheet_organisation_as-at-undated.pdf');
  });
});

describe('reports/balance-doc — the lines both files walk', () => {
  test('Net Assets goes last when there is no equity group, and a titleless subgroup adds no heading', () => {
    const p = payload({ groups: payload().groups.slice(0, 2) });
    const labels = balance.balanceLines(p).map(l => l.label);
    expect(labels[labels.length - 1]).toBe('NET ASSETS');
    expect(balance.balanceLines(payload()).filter(l => l.kind === 'subgroup').map(l => l.label)).toEqual(['Bank', 'Current Assets', 'Current Liabilities']);
  });

  test('an empty payload is an empty report rather than a crash', () => {
    expect(balance.balanceLines({})).toEqual([]);
    const d = balance.balanceSheetDefinition({}, SGT);
    expect(bodyOf(d)).toEqual([[{ text: 'Account', style: 'colHead' }]]);
    expect(balance.balanceSheetWorkbook({}, SGT).worksheets).toHaveLength(1);
  });
});

describe('reports/balance-doc — renders', () => {
  test('the PDF goes all the way through pdfmake, with a name the font cannot draw', async () => {
    const p = payload({ asAt: { iso: '2026-10-30', label: '30 October 2026', preset: 'today', inProgress: true } });
    p.groups[0].subgroups[0].rows.push({ label: '販売収入', code: '091', values: [1, 2, 3] });
    const chunks = [];
    const pdf = render.streamPdf(balance.balanceSheetDefinition(p, { ...SGT, codes: true }), new PassThrough());
    await new Promise((resolve, reject) => { pdf.on('data', c => chunks.push(c)); pdf.on('end', resolve); pdf.on('error', reject); });
    const out = Buffer.concat(chunks);
    expect(out.subarray(0, 5).toString()).toBe('%PDF-');
    expect(out.length).toBeGreaterThan(2000);
    // The folded name is marked with its line, and the note explains the mark.
    const d = balance.balanceSheetDefinition(p, SGT);
    expect(rowOf(d, '???? [#4]')).toBeDefined();
    expect(d.content.some(c => c.style === 'aside' && /Excel export/.test(c.text))).toBe(true);
  });
});
