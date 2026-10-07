const ExcelJS = require('exceljs');
const { parseClaimForm, excelSerialToISO, cellDate, cellNumber, normaliseHeader } = require('./claim-form');

// Builds a spreadsheet shaped like the real BLACKSTAR claim form: a title block,
// a header row several rows down, filled lines, blank template lines, then a
// footer with totals and a declaration.
async function makeForm({ rows = [], includeFooter = true, headerRow = 7 } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Claim');
  ws.getCell('A1').value = 'BLACKSTAR';
  ws.getCell('A2').value = 'EXPENSES CLAIM FORM';
  ws.getCell('A5').value = 'Claim Period From: ';

  const h = ws.getRow(headerRow);
  h.getCell(1).value = 'No';
  h.getCell(2).value = 'DATE';
  h.getCell(3).value = 'DESCRIPTION OF EXPENSES';
  h.getCell(8).value = 'Currency';
  h.getCell(9).value = 'Amount';
  h.getCell(10).value = 'Exchange Rate';
  h.getCell(12).value = 'HOTEL ACCOMODATION \n(SGD)';
  h.getCell(13).value = 'LOCAL TRAVEL COST\n(SGD)';
  h.getCell(14).value = 'SGD AMOUNT';

  let r = headerRow + 2;
  for (const row of rows) {
    const x = ws.getRow(r++);
    x.getCell(1).value = row.no;
    x.getCell(2).value = row.date;
    x.getCell(3).value = row.description;
    x.getCell(8).value = row.currency || 'SGD';
    x.getCell(9).value = row.amount;
    x.getCell(10).value = row.fx ?? 1;
    if (row.travel) x.getCell(13).value = row.travel;
  }
  // Pre-formatted empty lines, exactly as the real form carries them.
  for (let i = 0; i < 5; i++) {
    const x = ws.getRow(r++);
    x.getCell(1).value = rows.length + i + 1;
    x.getCell(8).value = 'SGD';
    x.getCell(9).value = 0;
    x.getCell(10).value = 1;
  }
  if (includeFooter) {
    ws.getRow(r++).getCell(3).value = 'Total';
    ws.getRow(r++).getCell(1).value = 'All supporting receipts must be attached.';
    ws.getRow(r++).getCell(1).value = 'I declared the expense claimed above were actually incurred.';
    ws.getRow(r++).getCell(1).value = 'Claimant:';
    ws.getRow(r++).getCell(1).value = 'FOR FINANCE PURPOSE ONLY:';
    ws.getRow(r++).getCell(1).value = 'ACCOUNTS CODE';
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const SAMPLE = [
  { no: 1, date: new Date(Date.UTC(2026, 1, 23)), description: 'Grab to meeting with Solve', amount: 15.8 },
  { no: 2, date: new Date(Date.UTC(2026, 1, 26)), description: 'transport Apple to Spotify', amount: 56.7 },
  { no: 3, date: new Date(Date.UTC(2026, 3, 17)), description: 'transport to vinyl event', amount: 21.8, travel: 21.8 },
];

describe('claims/claim-form', () => {
  test('reads only the filled claim lines', async () => {
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    expect(r.rows).toHaveLength(3);
    expect(r.rows.map(x => x.amount)).toEqual([15.8, 56.7, 21.8]);
    expect(r.error).toBeNull();
  });

  test('blank template lines are not claims, even though they carry a number and a currency', async () => {
    // The real form had nine filled rows and dozens of formatted empties which
    // arrive as amount 0 rather than null. Reading those produced 56 phantom rows.
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    expect(r.rows.every(x => x.amount > 0 || x.description)).toBe(true);
  });

  test('stops at the footer instead of reading declarations as claim lines', async () => {
    // "I declared the expense claimed above..." was becoming a claim row.
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    const text = r.rows.map(x => x.description).join(' ');
    expect(text).not.toMatch(/declared|Total|Claimant|ACCOUNTS CODE/i);
  });

  test('finds the header wherever it sits, not at a fixed row', async () => {
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE, headerRow: 11 }));
    expect(r.rows).toHaveLength(3);
  });

  test('maps by header NAME, so an inserted column does not shift everything', async () => {
    // Hard-coding "date is column B" breaks the first time somebody adds a column.
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    expect(r.rows[0].description).toBe('Grab to meeting with Solve');
    expect(r.rows[0].date).toBe('2026-02-23');
  });

  test('collects the category columns and reads a ticked one', async () => {
    const r = await parseClaimForm(await makeForm({ rows: SAMPLE }));
    expect(r.categories.some(c => /LOCAL TRAVEL/i.test(c))).toBe(true);
    expect(r.rows[2].category).toMatch(/LOCAL TRAVEL/i);
    // The gap the AI fills: most rows have no category at all.
    expect(r.rows[0].category).toBeNull();
  });

  test('a file that is not a spreadsheet degrades to no rows with a reason', async () => {
    const r = await parseClaimForm(Buffer.from('this is not xlsx'));
    expect(r.rows).toEqual([]);
    expect(r.error).toMatch(/not a readable spreadsheet/);
  });

  test('an empty buffer is handled', async () => {
    expect((await parseClaimForm(Buffer.alloc(0))).error).toBe('empty file');
    expect((await parseClaimForm(null)).error).toBe('empty file');
  });

  describe('cell coercion', () => {
    test('Excel date serials convert on the 1899-12-30 epoch', () => {
      // Excel's epoch is shifted by the 1900 leap-year bug it deliberately keeps.
      expect(excelSerialToISO(46076)).toBe('2026-02-23');
      expect(excelSerialToISO(0)).toBeNull();
      expect(excelSerialToISO('nonsense')).toBeNull();
    });

    test('dates arrive as Date objects, serials or strings', () => {
      expect(cellDate(new Date(Date.UTC(2026, 1, 23)))).toBe('2026-02-23');
      expect(cellDate(46076)).toBe('2026-02-23');
      expect(cellDate('2026-02-23')).toBe('2026-02-23');
      expect(cellDate('')).toBeNull();
    });

    test('amounts survive currency symbols and thousands separators', () => {
      expect(cellNumber(15.8)).toBe(15.8);
      expect(cellNumber('S$1,234.50')).toBe(1234.5);
      expect(cellNumber('')).toBeNull();
    });

    test('headers match despite wrapping, case and brackets', () => {
      expect(normaliseHeader('LOCAL TRAVEL COST\n(SGD)')).toBe('LOCAL TRAVEL COST SGD');
      expect(normaliseHeader('  Amount  ')).toBe('AMOUNT');
    });
  });
});

// The currency column was stored as typed ("S$"), which Xero refuses; and the
// form's exchange rate was read but never reached Xero.
describe('claims/claim-form — currency and exchange rate', () => {
  const { normaliseCurrency, xeroCurrencyRate } = require('./claim-form');

  test('symbols and codes become three-letter codes; text that names none is null', () => {
    expect(normaliseCurrency('S$')).toBe('SGD');
    expect(normaliseCurrency(' s$ ')).toBe('SGD');
    expect(normaliseCurrency('usd')).toBe('USD');
    expect(normaliseCurrency('US$')).toBe('USD');
    expect(normaliseCurrency('RM')).toBe('MYR');
    expect(normaliseCurrency('€')).toBe('EUR');
    expect(normaliseCurrency('SGD (S$)')).toBe('SGD');
    expect(normaliseCurrency('$')).toBeNull();          // SGD on one form, USD on the next
    expect(normaliseCurrency('Baht')).toBeNull();
    expect(normaliseCurrency('')).toBeNull();
    expect(normaliseCurrency(null)).toBeNull();
  });

  // Xero's CurrencyRate is foreign units per one base unit; the form's rate is
  // base per foreign (AMOUNT x RATE = SGD AMOUNT).
  test('the form\'s rate is turned round into Xero\'s terms', () => {
    expect(xeroCurrencyRate({ amount: 100, exchangeRate: 1.35 })).toBe(0.740741);
    expect(xeroCurrencyRate({ amount: 100, exchangeRate: 1.35, baseAmount: 135 })).toBe(0.740741);
    // Written the other way round, which the base amount shows.
    expect(xeroCurrencyRate({ amount: 100, exchangeRate: 0.74, baseAmount: 135.14 })).toBe(0.74);
    // No rate, but both amounts.
    expect(xeroCurrencyRate({ amount: 100, baseAmount: 135 })).toBe(0.740741);
    expect(xeroCurrencyRate({ amount: 100 })).toBeNull();
  });

  test('rows carry the cleaned currency, what could not be read, and the rate for Xero', async () => {
    const r = await parseClaimForm(await makeForm({ rows: [
      { no: 1, date: new Date(Date.UTC(2026, 1, 23)), description: 'Taxi', currency: 'S$', amount: 15.8, fx: 1 },
      { no: 2, date: new Date(Date.UTC(2026, 1, 24)), description: 'Hotel', currency: 'USD', amount: 100, fx: 1.35 },
      { no: 3, date: new Date(Date.UTC(2026, 1, 25)), description: 'Food', currency: 'Baht', amount: 50, fx: 0.04 },
    ] }));
    expect(r.rows.map(x => x.currency)).toEqual(['SGD', 'USD', null]);
    expect(r.rows.map(x => x.currencyUnread)).toEqual([null, null, 'Baht']);   // as typed
    expect(r.rows.map(x => x.currencyRate)).toEqual([1, 0.740741, 25]);
  });
});
