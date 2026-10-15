const { PassThrough } = require('stream');
const cm     = require('./cash-manager-doc');
const doc    = require('./budget-doc');
const render = require('./budget-render');

// The document definition is a plain object and the workbook is read back
// cell by cell, so what goes wrong in an export — a day missing from the table,
// an excluded item counted as live, an overdue invoice filed under next week —
// is assertable without rendering a PDF. One render at the end proves the
// definition goes all the way through pdfmake.

const TODAY = '2026-10-12';
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function item(over) {
  return {
    key: '', direction: 'in', source: 'invoice', date: TODAY, dueDate: TODAY, dateBasis: 'due',
    amount: 0, originalAmount: over.amount, currency: 'SGD', contactName: '', number: '', reference: '',
    overdue: false, excluded: false, overridden: false, entryId: null,
    ...over,
  };
}

// Out of date order on purpose, with the excluded and overdue items in among
// the rest, so the grouping and the ordering are the code's and not the
// fixture's.
const ITEMS = [
  item({ key: 'invoice:inv-1', date: '2026-10-15', dueDate: '2026-10-15', dateBasis: 'due', amount: 12000, contactName: 'Acme', number: 'INV-0042' }),
  item({ key: 'invoice:inv-5', date: '2026-10-20', dueDate: '2026-10-20', dateBasis: 'expected', amount: 5000, contactName: 'Epsilon', number: 'INV-0044', excluded: true }),
  item({ key: 'invoice:inv-2', date: TODAY, dueDate: '2026-09-28', dateBasis: 'due', amount: 12000, contactName: 'Gamma', number: 'INV-0035', overdue: true }),
  item({ key: 'bill:bill-1', direction: 'out', source: 'bill', date: '2026-10-16', dueDate: '2026-10-20', dateBasis: 'planned', amount: 3469, contactName: 'Landlord Pte Ltd', number: 'RENT-OCT', reference: 'October rent' }),
  item({ key: 'repeating:rep-1', direction: 'out', source: 'repeating', date: '2026-10-30', dueDate: '2026-10-30', dateBasis: 'repeating', amount: 24603, contactName: 'Payroll Services', reference: 'Monthly payroll' }),
  item({ key: 'invoice:inv-4', date: '2026-12-01', dueDate: '2026-11-15', dateBasis: 'predicted', amount: 95000.25, contactName: 'Delta Ltd', number: 'INV-0050' }),
  item({ key: 'payment:pay-1', source: 'payment', date: '2026-11-18', dueDate: '2026-11-18', dateBasis: 'payment', amount: 1500, contactName: 'Zeta', number: 'INV-0039' }),
  item({ key: 'manual:e1', direction: 'out', source: 'manual', date: '2026-11-20', dueDate: '2026-11-20', dateBasis: 'manual', amount: 200000, reference: 'Equipment purchase', entryId: 'e1' }),
  item({ key: 'invoice:inv-3', date: TODAY, dueDate: '2026-09-20', dateBasis: 'due', amount: 45330, contactName: 'Beta Corp', number: 'INV-0031', overdue: true }),
  item({ key: 'bill:bill-2', direction: 'out', source: 'bill', date: '2026-12-05', dueDate: '2026-11-28', dateBasis: 'due', amount: 750, contactName: 'Cloud Hosting', number: 'BILL-9', overridden: true, entryId: 'o1' }),
  item({ key: 'invoice:inv-6', date: '2026-12-28', dueDate: '2026-12-28', dateBasis: 'expected', amount: 3000, contactName: 'Theta', number: 'INV-0060' }),
];

// Today and the ninety days after it, made of the live items above, as the
// service builds it: excluded and overdue items move no day. The balance goes
// below zero on 20 Nov and recovers on 1 Dec, inside the 60-day span and past
// the 30-day one.
const SERIES = (() => {
  let balance = 135491;
  return Array.from({ length: 91 }, (_, i) => {
    const date = addDays(TODAY, i);
    const live = ITEMS.filter(it => it.date === date && !it.excluded && !it.overdue);
    const sum  = dir => live.filter(it => it.direction === dir).reduce((s, it) => s + it.amount, 0);
    const cin = sum('in'), out = sum('out');
    balance += cin - out;
    return { date, in: cin, out, net: cin - out, balance };
  });
})();

// The thirty days before today as they happened, oldest first: 57,330 received
// on 6 Oct and 1,200 paid on 9 Oct, the balance worked back from today's.
const ACTUALS = (() => {
  const moves = { '2026-10-06': [57330, 0], '2026-10-09': [0, 1200] };
  const days = Array.from({ length: 30 }, (_, i) => addDays(TODAY, i - 30));
  let balance = 135491;
  return days.reverse().map(date => {
    const [cin, out] = moves[date] || [0, 0];
    const row = { date, in: cin, out, net: cin - out, balance };
    balance -= cin - out;
    return row;
  }).reverse();
})();

// The payload as the cash manager route sends it.
function payload(over = {}) {
  return {
    organisation: { name: 'Nexsoss Pte Ltd', currency: 'SGD' },
    today: TODAY,
    horizonDays: 91,
    bank: {
      accounts: [{ accountId: 'a1', name: 'Aspire SGD account', currency: 'SGD', balance: 135491, included: true, openingAdjustment: 0, overdraft: 0, foreign: false }],
      balance: 135491,
      overdraft: 0,
    },
    tiles: {
      bankBalance: 135491,
      today:     { in: 0, out: 0, net: 0 },
      next7:     { in: 12000, out: 3469, net: 8531 },
      next8to30: { in: 0, out: 24603, net: -24603 },
      overdue:   { in: 57330, out: 0, net: 57330 },
    },
    runwayDays: null,
    series: SERIES.map(r => ({ ...r })),
    actualDays: 30,
    actualsAvailable: true,
    actuals: ACTUALS.map(r => ({ ...r })),
    items: ITEMS.map(it => ({ ...it })),
    notes: ['Overpayments and prepayments are already in the bank and are not projected.'],
    cached: true,
    fetchedAt: 1760000000000,
    ...over,
  };
}

const GENERATED = Date.UTC(2026, 9, 12, 9, 0);       // 12 Oct 2026, 17:00 in Singapore
const SGT = { generatedAt: GENERATED, timezone: 'Asia/Singapore' };
const cell = doc._cell;
const { BAND, NEGATIVE, MUTED } = doc._colours;

// The five figures, in the screen's order, as the payload has them.
const TILES = [
  ["Today's bank balance", 135491],
  ["Today's movement", 0, 0, 0],
  ['Next 1–7 days', 8531, 12000, 3469],
  ['Next 8–30 days', -24603, 0, 24603],
  ['Overdue', 57330, 57330, 0],
];

// What each list holds over 60 days, in print order: [date, contact,
// number / description, date basis, amount, excluded].
const CASH_IN_60 = [
  ['15 Oct 2026', 'Acme', 'INV-0042', 'Due date', 12000],
  ['18 Nov 2026', 'Zeta', 'INV-0039', 'Payment dated ahead', 1500],
  ['1 Dec 2026', 'Delta Ltd', 'INV-0050', 'Predicted from payment history', 95000.25],
  ['20 Oct 2026', 'Epsilon', 'INV-0044', 'Expected date', 5000, true],
];
const CASH_OUT_60 = [
  ['16 Oct 2026', 'Landlord Pte Ltd', 'RENT-OCT · October rent', 'Planned date', 3469],
  ['30 Oct 2026', 'Payroll Services', 'Monthly payroll', 'Repeating invoice', 24603],
  ['20 Nov 2026', '', 'Equipment purchase', 'Your entry', 200000],
  ['5 Dec 2026', 'Cloud Hosting', 'BILL-9', 'Changed here', 750],
];
const OVERDUE = [
  ['20 Sep 2026', 'Beta Corp', 'INV-0031', 45330],
  ['28 Sep 2026', 'Gamma', 'INV-0035', 12000],
];

const weekday = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const weekend = iso => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());

// A cell's text, whether plain or rich (an excluded item's description is a
// struck-through run followed by the word "excluded").
const plain = c => (Array.isArray(c.text) ? c.text.map(t => t.text).join('') : c.text);
const at = (d, heading) => d.content.findIndex(c => c.style === 'section' && c.text === heading);
const after = (d, heading) => d.content[at(d, heading) + 1];
const bodyAfter = (d, heading) => after(d, heading).table.body;
const tileCells = d => d.content[0].table.body[0];

describe('reports/cash-manager-doc — the PDF definition', () => {
  const d60 = cm.cashManagerDefinition(payload(), { ...SGT, days: 60 });

  test('is an A4 landscape page with the budget documents\' header and footer', () => {
    expect(d60.pageSize).toBe('A4');
    expect(d60.pageOrientation).toBe('landscape');
    expect(d60.styles).toBe(doc.STYLES);
    const header = JSON.stringify(d60.header);
    expect(header).toContain('Nexsoss Pte Ltd');
    expect(header).toContain('Cash Flow Manager');
    // Xero's "60 days" ends sixty days on: 12 Oct to 11 Dec.
    expect(header).toContain('Projected for 60 days ending on 11 Dec 2026 · SGD');
    expect(header).toContain('Generated 12 Oct 2026, 17:00');
    expect(header).toContain('Figures read from Xero at');
    expect(d60.footer(1, 3).columns[0].text).toBe("Figures in SGD, the organisation's base currency.");
    expect(d60.footer(1, 3).columns[1].text).toBe('Page 1 of 3');
    expect(JSON.stringify(cm.cashManagerDefinition(payload(), { ...SGT, days: 30 }).header))
      .toContain('Projected for 30 days ending on 11 Nov 2026 · SGD');
  });

  test('the five figures lead the page, in order, each net with its cash in and out beneath', () => {
    const tiles = tileCells(d60);
    expect(tiles.map(t => t.stack[0].text)).toEqual(TILES.map(t => t[0]));
    expect(tiles.map(t => t.stack[1].text)).toEqual(TILES.map(t => cell(t[1])));
    expect(tiles.map(t => t.stack[1].text)).toEqual(['135,491.00', '-', '8,531.00', '(24,603.00)', '57,330.00']);
    expect(tiles.slice(1).map(t => t.stack[2].text)).toEqual(TILES.slice(1).map(t => `In ${cell(t[2])} · Out ${cell(t[3])}`));
    expect(tiles[4].stack[2].text).toBe('In 57,330.00 · Out -');
    expect(tiles[0].stack[2].text).toBe('1 account');
    // A net outflow is not red; only a balance below zero is.
    expect(tiles[3].stack[1].color).toBeUndefined();
    const overdrawn = payload();
    overdrawn.tiles.bankBalance = -50;
    expect(tileCells(cm.cashManagerDefinition(overdrawn, SGT))[0].stack[1]).toMatchObject({ text: '(50.00)', color: NEGATIVE });
  });

  test('the bank accounts behind the balance are named under the figures', () => {
    expect(d60.content[1].text).toBe('Bank balance from Aspire SGD account.');
    const p = payload();
    p.bank.accounts.push({ accountId: 'a2', name: 'DBS USD', currency: 'USD', balance: 10, included: false });
    expect(cm.cashManagerDefinition(p, SGT).content[1].text).toBe('Bank balance from Aspire SGD account. Left out: DBS USD.');
  });

  for (const days of [30, 60]) {
    test(`the daily table has today and every one of the ${days} days after it, in order, with every figure in its column`, () => {
      const d    = cm.cashManagerDefinition(payload(), { ...SGT, days });
      const body = bodyAfter(d, 'Day by day');
      expect(body[0].map(c => c.text)).toEqual(['Date', 'Cash in', 'Cash out', 'Net movement', 'Bank balance']);
      expect(body).toHaveLength(days + 2);
      expect(body.slice(1).map(r => r.map(c => c.text))).toEqual(SERIES.slice(0, days + 1).map(r => [
        `${weekday(r.date)} ${doc.dayLabel(r.date)}`, cell(r.in), cell(r.out), cell(r.net), cell(r.balance),
      ]));
      expect(body[1][0].text).toBe('Mon 12 Oct 2026');
      expect(body[days + 1][0].text).toBe(days === 30 ? 'Wed 11 Nov 2026' : 'Fri 11 Dec 2026');
      expect(after(d, 'Day by day').table.headerRows).toBe(1);
    });
  }

  test('the last thirty days as they happened come first, oldest first, before the projection', () => {
    const body = bodyAfter(d60, 'Actual (last 30 days)');
    expect(at(d60, 'Actual (last 30 days)')).toBeLessThan(at(d60, 'Day by day'));
    expect(at(d60, 'Actual (last 30 days)')).toBeGreaterThan(0);
    expect(body[0].map(c => c.text)).toEqual(['Date', 'Cash in', 'Cash out', 'Net movement', 'Bank balance']);
    expect(body.slice(1).map(r => r.map(c => c.text))).toEqual(ACTUALS.map(r => [
      `${weekday(r.date)} ${doc.dayLabel(r.date)}`, cell(r.in), cell(r.out), cell(r.net), cell(r.balance),
    ]));
    expect(body[1][0].text).toBe('Sat 12 Sep 2026');
    expect(body.find(r => r[0].text === 'Tue 6 Oct 2026').map(c => c.text))
      .toEqual(['Tue 6 Oct 2026', '57,330.00', '-', '57,330.00', '136,691.00']);
    // A balance with nothing to work back from is blank, not nil.
    const p = payload({ actuals: ACTUALS.map(r => ({ ...r, balance: null })) });
    expect(bodyAfter(cm.cashManagerDefinition(p, SGT), 'Actual (last 30 days)')[1][4].text).toBe('');
  });

  test('past cash that could not be read is said, and a payload without any prints no section', () => {
    const p = payload({ actualsAvailable: false, actuals: [] });
    expect(after(cm.cashManagerDefinition(p, SGT), 'Actual (last 30 days)'))
      .toEqual({ text: 'Past cash could not be read from Xero, so the days before today are not shown.', style: 'note' });
    const none = payload();
    delete none.actuals;
    delete none.actualsAvailable;
    expect(at(cm.cashManagerDefinition(none, SGT), 'Actual (last 30 days)')).toBe(-1);
  });

  test('weekends are shaded lightly and nothing else is', () => {
    const t    = after(d60, 'Day by day');
    const fill = t.layout.fillColor;
    SERIES.slice(0, 61).forEach((r, i) => expect({ date: r.date, fill: fill(i + 1) }).toEqual({ date: r.date, fill: weekend(r.date) ? BAND : null }));
    expect(t.table.body[6][0].text).toBe('Sat 17 Oct 2026');
    expect(fill(6)).toBe(BAND);
    expect(fill(0)).toBeNull();
  });

  test('a balance below zero is red and parenthesised, and only the balance', () => {
    const body = bodyAfter(d60, 'Day by day');
    SERIES.slice(0, 61).forEach((r, i) => {
      expect({ date: r.date, color: body[i + 1][4].color }).toEqual({ date: r.date, color: r.balance < 0 ? NEGATIVE : undefined });
      expect(body[i + 1][3].color).toBeUndefined();
    });
    const nov20 = body.find(r => r[0].text === 'Fri 20 Nov 2026');
    expect(nov20.map(c => c.text)).toEqual(['Fri 20 Nov 2026', '-', '200,000.00', '(200,000.00)', '(79,081.00)']);
    expect(SERIES.slice(0, 60).some(r => r.balance < 0)).toBe(true);
    expect(SERIES.slice(0, 30).some(r => r.balance < 0)).toBe(false);
  });

  test('the sections come in order: figures, past days, days, cash in, cash out, overdue, then the notes', () => {
    const order = ['Actual (last 30 days)', 'Day by day', 'Cash in', 'Cash out', 'Overdue'].map(h => at(d60, h));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const notes = d60.content.slice(at(d60, 'Overdue') + 2);
    expect(notes.map(n => n.text)).toEqual([
      'Overpayments and prepayments are already in the bank and are not projected.',
      'Items struck through and marked "excluded" are left out of every figure above.',
    ]);
    expect(notes.every(n => n.style === 'note')).toBe(true);
  });
});

describe('reports/cash-manager-doc — the item lists in the PDF', () => {
  const d60 = cm.cashManagerDefinition(payload(), { ...SGT, days: 60 });
  const rows = (d, heading) => bodyAfter(d, heading).slice(1).map(r => r.map(plain));
  const expected = list => list.map(([date, contact, desc, basis, amount, excluded]) => [
    date, contact, excluded ? `${desc}  excluded` : desc, basis, cell(amount),
  ]);

  test('cash in and cash out are listed apart, by date, with the excluded ones last', () => {
    expect(bodyAfter(d60, 'Cash in')[0].map(c => c.text)).toEqual(['Date', 'Contact', 'Number / description', 'Date basis', 'Amount']);
    expect(rows(d60, 'Cash in')).toEqual(expected(CASH_IN_60));
    expect(rows(d60, 'Cash out')).toEqual(expected(CASH_OUT_60));
  });

  test('an excluded item is struck through and marked "excluded", and a live one is not', () => {
    const body = bodyAfter(d60, 'Cash in');
    const off  = body[body.length - 1];
    expect(plain(off[2])).toBe('INV-0044  excluded');
    for (const c of [off[0], off[1], off[3], off[4]]) expect(c).toMatchObject({ decoration: 'lineThrough', color: MUTED });
    expect(off[2].text[0]).toMatchObject({ text: 'INV-0044', decoration: 'lineThrough' });
    // The word itself stays legible.
    expect(off[2].text[1]).toMatchObject({ text: '  excluded', italics: true });
    expect(off[2].text[1].decoration).toBeUndefined();
    for (const r of body.slice(1, -1)) for (const c of r) expect(c.decoration).toBeUndefined();
  });

  test('overdue items have their own list, by due date, and appear in no other', () => {
    const body = bodyAfter(d60, 'Overdue');
    expect(body[0].map(c => c.text)).toEqual(['Due date', 'Contact', 'Number / description', 'Cash in', 'Cash out']);
    expect(body.slice(1).map(r => r.map(plain))).toEqual(OVERDUE.map(([date, contact, desc, amount]) => [date, contact, desc, cell(amount), '']));
    const elsewhere = [...rows(d60, 'Cash in'), ...rows(d60, 'Cash out')].map(r => r[2]);
    expect(elsewhere).not.toContain('INV-0031');
    expect(elsewhere).not.toContain('INV-0035');
  });

  test('a list holds only the days printed: 30 days drops what 60 keeps, and 90 adds the rest', () => {
    const d30 = cm.cashManagerDefinition(payload(), { ...SGT, days: 30 });
    expect(rows(d30, 'Cash in').map(r => r[2])).toEqual(['INV-0042', 'INV-0044  excluded']);
    expect(rows(d30, 'Cash out').map(r => r[2])).toEqual(['RENT-OCT · October rent', 'Monthly payroll']);
    expect(rows(d30, 'Overdue').map(r => r[2])).toEqual(['INV-0031', 'INV-0035']);
    const d90 = cm.cashManagerDefinition(payload(), { ...SGT, days: 90 });
    expect(rows(d90, 'Cash in').map(r => r[2])).toEqual(['INV-0042', 'INV-0039', 'INV-0050', 'INV-0060', 'INV-0044  excluded']);
  });

  test('an empty list says so rather than printing a bare header', () => {
    const p = payload({ items: ITEMS.filter(it => it.direction === 'in').map(it => ({ ...it, overdue: false })) });
    expect(after(cm.cashManagerDefinition(p, { ...SGT, days: 30 }), 'Cash out')).toEqual({ text: 'No cash going out in the 30 days projected.', style: 'note' });
    expect(after(cm.cashManagerDefinition(p, { ...SGT, days: 30 }), 'Overdue')).toEqual({ text: 'Nothing overdue.', style: 'note' });
  });
});

describe('reports/cash-manager-doc — date basis in words', () => {
  test('each basis has the screen\'s wording', () => {
    const say = over => cm.basisText(item(over));
    expect(say({ dateBasis: 'expected' })).toBe('Expected date');
    expect(say({ dateBasis: 'planned' })).toBe('Planned date');
    expect(say({ dateBasis: 'predicted' })).toBe('Predicted from payment history');
    expect(say({ dateBasis: 'due' })).toBe('Due date');
    expect(say({ dateBasis: 'repeating' })).toBe('Repeating invoice');
    // The server's own word for a repeating template's occurrence.
    expect(say({ dateBasis: 'scheduled', source: 'repeating' })).toBe('Repeating invoice');
    expect(say({ dateBasis: 'payment' })).toBe('Payment dated ahead');
    expect(say({ dateBasis: 'manual', source: 'manual' })).toBe('Your entry');
    expect(say({ dateBasis: 'override' })).toBe('Changed here');
    expect(say({ dateBasis: 'banktx', source: 'banktx' })).toBe('Spend/Receive Money dated ahead');
    expect(say({ dateBasis: 'none' })).toBe('No date in Xero');
  });

  test('a change made here wins over Xero\'s basis, but not over the user\'s own entry', () => {
    expect(cm.basisText(item({ dateBasis: 'expected', overridden: true }))).toBe('Changed here');
    expect(cm.basisText(item({ source: 'manual', dateBasis: 'manual', overridden: true }))).toBe('Your entry');
  });

  test('the source stands in for a missing basis, and an unknown one says nothing', () => {
    expect(cm.basisText(item({ dateBasis: null, source: 'repeating' }))).toBe('Repeating invoice');
    expect(cm.basisText(item({ dateBasis: null, source: 'banktx' }))).toBe('Spend/Receive Money dated ahead');
    expect(cm.basisText(item({ dateBasis: undefined, source: 'manual' }))).toBe('Your entry');
    expect(cm.basisText(item({ dateBasis: 'constructor' }))).toBe('');
    expect(cm.basisText(undefined)).toBe('');
  });
});

describe('reports/cash-manager-doc — the span', () => {
  test('is today and the days asked for after it, else the payload\'s horizon, and never more than the series has', () => {
    expect(cm.cashSpan(payload(), 30)).toMatchObject({ days: 30, end: '2026-11-11' });
    expect(cm.cashSpan(payload(), 60)).toMatchObject({ days: 60, end: '2026-12-11' });
    expect(cm.cashSpan(payload(), 90)).toMatchObject({ days: 90, end: '2027-01-10' });
    expect(cm.cashSpan(payload(), undefined)).toMatchObject({ days: 90, end: addDays(TODAY, 90) });
    expect(cm.cashSpan(payload(), 'nonsense').days).toBe(90);
    expect(cm.cashSpan(payload(), 365).days).toBe(90);
    expect(cm.cashSpan(payload(), 30).rows).toEqual(SERIES.slice(0, 31));
    expect(cm.cashSpan({}, 60)).toEqual({ days: 0, rows: [], end: '' });
  });
});

describe('reports/cash-manager-doc — the workbook', () => {
  // Every line of a sheet as [row number, values], for finding things by text.
  const sheetRows = ws => {
    const out = [];
    ws.eachRow((r, n) => out.push([n, r.values.slice(1)]));
    return out;
  };
  const headRow = (ws, first) => sheetRows(ws).find(([, v]) => v[0] === first)[0];
  // The rows under the header, up to the blank line before the notes.
  const tableRows = (ws, first) => {
    const rows = [];
    for (let n = headRow(ws, first) + 1; ws.getRow(n).cellCount && ws.getRow(n).getCell(1).value !== null; n++) rows.push(ws.getRow(n));
    return rows;
  };
  const values = (row, n) => Array.from({ length: n }, (_, i) => row.getCell(i + 1).value);
  const iso = v => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
  const wb = cm.cashManagerWorkbook(payload(), { ...SGT, days: 60 });

  test('has the six sheets, the last thirty days ahead of the projection, each opening with the title block', () => {
    expect(wb.worksheets.map(w => w.name)).toEqual(['Summary', 'Actual (last 30 days)', 'Daily', 'Cash in', 'Cash out', 'Overdue']);
    for (const ws of wb.worksheets) {
      const text = sheetRows(ws).map(([, v]) => v.filter(x => typeof x === 'string').join(' ')).join('\n');
      expect(text).toContain('Nexsoss Pte Ltd — Cash Flow Manager');
      expect(text).toContain('Projected for 60 days ending on 11 Dec 2026 · SGD · Generated 12 Oct 2026, 17:00');
      expect(text).toContain('Figures read from Xero at');
      expect(text).toContain("Figures in SGD, the organisation's base currency.");
    }
  });

  test('Summary carries the five figures as numbers, in order, in the money format', () => {
    const ws   = wb.getWorksheet('Summary');
    expect(ws.getRow(headRow(ws, 'Figure')).values.slice(1)).toEqual(['Figure', 'Amount', 'Cash in', 'Cash out']);
    const rows = tableRows(ws, 'Figure');
    expect(rows.map(r => values(r, 4))).toEqual(TILES.map(([label, amount, cin = null, out = null]) => [label, amount, cin, out]));
    for (const r of rows) expect([2, 3, 4].map(c => r.getCell(c).numFmt)).toEqual(new Array(3).fill(render.MONEY_FMT));
    expect(render.MONEY_FMT).toBe('#,##0.00;(#,##0.00);"-"');
    const acct = sheetRows(ws).find(([, v]) => v[0] === 'Aspire SGD account');
    expect(acct[1]).toEqual(['Aspire SGD account', 135491, 'SGD', 'Yes']);
    expect(sheetRows(ws).some(([, v]) => v[0] === 'Overpayments and prepayments are already in the bank and are not projected.')).toBe(true);
  });

  test('the last thirty days sheet carries the payload\'s actuals as dates and numbers, oldest first', () => {
    const ws   = wb.getWorksheet('Actual (last 30 days)');
    const rows = tableRows(ws, 'Date');
    expect(rows.map(r => values(r, 5).map(iso))).toEqual(ACTUALS.map(r => [r.date, r.in, r.out, r.net, r.balance]));
    for (const r of rows) expect([2, 3, 4, 5].map(c => r.getCell(c).numFmt)).toEqual(new Array(4).fill(render.MONEY_FMT));
    const gone = cm.cashManagerWorkbook(payload({ actualsAvailable: false, actuals: [] }), SGT).getWorksheet('Actual (last 30 days)');
    expect(sheetRows(gone).some(([, v]) => v[0] === 'Past cash could not be read from Xero, so the days before today are not shown.')).toBe(true);
  });

  for (const days of [30, 60]) {
    test(`Daily carries today and every one of the ${days} days after it as a date and numbers equal to the payload`, () => {
      const ws   = cm.cashManagerWorkbook(payload(), { ...SGT, days }).getWorksheet('Daily');
      expect(ws.getRow(headRow(ws, 'Date')).values.slice(1)).toEqual(['Date', 'Cash in', 'Cash out', 'Net movement', 'Bank balance']);
      const rows = tableRows(ws, 'Date');
      expect(rows).toHaveLength(days + 1);
      expect(rows.map(r => values(r, 5).map(iso))).toEqual(SERIES.slice(0, days + 1).map(r => [r.date, r.in, r.out, r.net, r.balance]));
      for (const r of rows) {
        expect(r.getCell(1).value).toBeInstanceOf(Date);
        expect(r.getCell(1).numFmt).toBe('ddd d mmm yyyy');
        expect([2, 3, 4, 5].map(c => r.getCell(c).numFmt)).toEqual(new Array(4).fill(render.MONEY_FMT));
      }
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: headRow(ws, 'Date') });
    });
  }

  test('Daily shades the weekends and reds a balance below zero, as the PDF does', () => {
    const rows = tableRows(wb.getWorksheet('Daily'), 'Date');
    rows.forEach((r, i) => {
      const day = SERIES[i];
      expect({ date: day.date, shaded: Boolean(r.getCell(1).fill) }).toEqual({ date: day.date, shaded: weekend(day.date) });
      expect({ date: day.date, red: r.getCell(5).font?.color?.argb === render.ARGB.negative }).toEqual({ date: day.date, red: day.balance < 0 });
    });
  });

  test('Cash in and Cash out list the PDF\'s items, in its order, as dates and numbers', () => {
    const list = name => tableRows(wb.getWorksheet(name), 'Date').map(r => values(r, 8).map(iso));
    const expected = keys => keys.map(k => ITEMS.find(it => it.key === k)).map(it => [
      it.date, it.dueDate, it.contactName, it.number, it.reference, cm.basisText(it), it.amount, it.excluded ? 'Excluded' : '',
    ]);
    expect(list('Cash in')).toEqual(expected(['invoice:inv-1', 'payment:pay-1', 'invoice:inv-4', 'invoice:inv-5']));
    expect(list('Cash out')).toEqual(expected(['bill:bill-1', 'repeating:rep-1', 'manual:e1', 'bill:bill-2']));
    // The same date basis, in the same order, as the PDF's lists.
    expect(list('Cash in').map(r => r[5])).toEqual(CASH_IN_60.map(r => r[3]));
    expect(list('Cash out').map(r => r[5])).toEqual(CASH_OUT_60.map(r => r[3]));
    for (const name of ['Cash in', 'Cash out']) {
      const ws = wb.getWorksheet(name);
      expect(ws.getRow(headRow(ws, 'Date')).values.slice(1)).toEqual(['Date', 'Due date', 'Contact', 'Number', 'Description', 'Date basis', 'Amount', 'Status']);
      for (const r of tableRows(ws, 'Date')) {
        expect(r.getCell(7).numFmt).toBe(render.MONEY_FMT);
        expect(r.getCell(1).numFmt).toBe('d mmm yyyy');
      }
    }
  });

  test('an excluded item is struck through and marked, and a live one is not', () => {
    const rows = tableRows(wb.getWorksheet('Cash in'), 'Date');
    const off  = rows[rows.length - 1];
    expect(off.getCell(8).value).toBe('Excluded');
    expect(off.getCell(1).font.strike).toBe(true);
    expect(off.getCell(7).font.strike).toBe(true);
    expect(rows[0].getCell(1).font?.strike).toBeFalsy();
  });

  test('Overdue lists the overdue items by due date, cash in and out in their own columns', () => {
    const ws = wb.getWorksheet('Overdue');
    expect(ws.getRow(headRow(ws, 'Due date')).values.slice(1)).toEqual(['Due date', 'Contact', 'Number', 'Description', 'Cash in', 'Cash out', 'Status']);
    const rows = tableRows(ws, 'Due date');
    expect(rows.map(r => values(r, 7).map(iso))).toEqual([
      ['2026-09-20', 'Beta Corp', 'INV-0031', '', 45330, null, ''],
      ['2026-09-28', 'Gamma', 'INV-0035', '', 12000, null, ''],
    ]);
    for (const r of rows) expect([5, 6].map(c => r.getCell(c).numFmt)).toEqual([render.MONEY_FMT, render.MONEY_FMT]);
  });

  test('cents of float noise are written as the cents the PDF prints', () => {
    const p = payload();
    p.series[1].balance = 9857.100000000002;
    const row = tableRows(cm.cashManagerWorkbook(p, { ...SGT, days: 30 }).getWorksheet('Daily'), 'Date')[1];
    expect(row.getCell(5).value).toBe(9857.1);
  });
});

describe('reports/cash-manager-doc — filenames', () => {
  test('carry the organisation, the day and the span, with the extension asked for', () => {
    expect(cm.cashManagerFilename(payload(), 'pdf', 60)).toBe('Cash-Flow-Manager_Nexsoss-Pte-Ltd_2026-10-12_60-days.pdf');
    expect(cm.cashManagerFilename(payload(), 'xlsx', 30)).toBe('Cash-Flow-Manager_Nexsoss-Pte-Ltd_2026-10-12_30-days.xlsx');
    expect(cm.cashManagerFilename(payload(), undefined, 60)).toBe('Cash-Flow-Manager_Nexsoss-Pte-Ltd_2026-10-12_60-days');
    expect(cm.cashManagerFilename(payload(), 'pdf')).toBe('Cash-Flow-Manager_Nexsoss-Pte-Ltd_2026-10-12_90-days.pdf');
  });

  test('sanitise the organisation as the budget exports do', () => {
    const odd = payload({ organisation: { name: 'Müller & Söhne (SG) Pte. Ltd.', currency: 'SGD' } });
    expect(cm.cashManagerFilename(odd, 'pdf', 60)).toBe('Cash-Flow-Manager_Müller-Söhne-SG-Pte-Ltd_2026-10-12_60-days.pdf');
    expect(cm.cashManagerFilename({ organisation: {} }, 'pdf')).toBe('Cash-Flow-Manager_organisation_undated.pdf');
  });
});

describe('reports/cash-manager-doc — what Xero could not give', () => {
  // As the service sends it when the Bank Summary, or the bank account list,
  // could not be read: no balance anywhere, cash in and out still there.
  const noBank = () => payload({
    bank: { available: false, unavailableReason: 'summary', accounts: [], balance: null, overdraft: null },
    tiles: { ...payload().tiles, bankBalance: null },
    series: SERIES.map(r => ({ ...r, balance: null })),
    actuals: ACTUALS.map(r => ({ ...r, balance: null })),
    notes: ['Bank balances could not be read from Xero just now, so no opening balance is shown, the running balance is not drawn and no runway is given.'],
  });
  // Xero sent neither a due date nor an invoice date: overdue, on no day.
  const undated = item({ key: 'invoice:inv-x', date: null, dueDate: null, originalDate: null, dateBasis: 'none', overdue: true, amount: 640, contactName: 'Omega', number: 'INV-0001' });

  test('a balance that could not be read is said in words in the PDF, never printed as a nil, and the days carry no balance', () => {
    const d = cm.cashManagerDefinition(noBank(), { ...SGT, days: 30 });
    expect(tileCells(d)[0].stack.map(s => s.text)).toEqual(["Today's bank balance", 'Not available', 'Could not be read from Xero']);
    expect(tileCells(d)[1].stack[1].text).toBe('-');   // the movements still print
    expect(tileCells(d)[2].stack[1].text).toBe('8,531.00');
    const body = bodyAfter(d, 'Day by day');
    expect(body.slice(1).every(r => r[4].text === '')).toBe(true);
    expect(body[4].map(c => c.text)).toEqual(['Thu 15 Oct 2026', '12,000.00', '-', '12,000.00', '']);
    expect(d.content.some(c => c.style === 'note' && /running balance is not drawn/.test(c.text))).toBe(true);
  });

  test('and in the workbook: the words in the balance\'s place, and blank balances on the days', () => {
    const wb = cm.cashManagerWorkbook(noBank(), { ...SGT, days: 30 });
    const summary = wb.getWorksheet('Summary');
    let tile = null;
    summary.eachRow(r => { if (r.getCell(1).value === "Today's bank balance") tile = r; });
    expect([tile.getCell(2).value, tile.getCell(3).value]).toEqual(['Not available', null]);
    const daily = [];
    wb.getWorksheet('Daily').eachRow(r => { if (r.getCell(1).value instanceof Date) daily.push(r.getCell(5).value); });
    expect(daily).toHaveLength(31);
    expect(daily.every(v => v === null)).toBe(true);
  });

  test('an item with no date in Xero is listed as overdue, with the words where its date would be', () => {
    const p = payload({ items: [...ITEMS.map(it => ({ ...it })), undated] });
    const d = cm.cashManagerDefinition(p, { ...SGT, days: 60 });
    const rows = bodyAfter(d, 'Overdue').slice(1).map(r => r.map(plain));
    expect(rows).toEqual([
      ['No date in Xero', 'Omega', 'INV-0001', cell(640), ''],
      ...OVERDUE.map(([date, contact, desc, amount]) => [date, contact, desc, cell(amount), '']),
    ]);
    const ws = cm.cashManagerWorkbook(p, { ...SGT, days: 60 }).getWorksheet('Overdue');
    const found = [];
    ws.eachRow(r => { if (r.getCell(2).value === 'Omega') found.push([r.getCell(1).value, r.getCell(5).value]); });
    expect(found).toEqual([['No date in Xero', 640]]);
  });

  test('Spend and Receive Money dated ahead is listed with its own date basis', () => {
    const tx = item({ key: 'banktx:b1', direction: 'out', source: 'banktx', date: '2026-10-22', dueDate: null, dateBasis: 'banktx', amount: 630, contactName: 'IRAS', reference: 'GST Q3' });
    const d = cm.cashManagerDefinition(payload({ items: [tx] }), { ...SGT, days: 30 });
    expect(bodyAfter(d, 'Cash out').slice(1).map(r => r.map(plain))).toEqual([['22 Oct 2026', 'IRAS', 'GST Q3', 'Spend/Receive Money dated ahead', cell(630)]]);
  });
});

describe('reports/cash-manager-doc — an empty payload', () => {
  test('is an empty report rather than a crash', () => {
    const d = cm.cashManagerDefinition({}, SGT);
    expect(bodyAfter(d, 'Day by day')).toHaveLength(1);
    expect(after(d, 'Overdue').text).toBe('Nothing overdue.');
    expect(cm.cashManagerWorkbook({}, SGT).worksheets).toHaveLength(5);
  });
});

describe('reports/cash-manager-doc — renders', () => {
  test('the PDF goes all the way through pdfmake, with a name the font cannot draw', async () => {
    const p = payload();
    p.items.push(item({ key: 'invoice:inv-9', date: '2026-10-14', amount: 88, contactName: '株式会社テスト', number: 'INV-0099' }));
    const d = cm.cashManagerDefinition(p, { ...SGT, days: 60 });
    const chunks = [];
    const pdf = render.streamPdf(d, new PassThrough());
    await new Promise((resolve, reject) => { pdf.on('data', c => chunks.push(c)); pdf.on('end', resolve); pdf.on('error', reject); });
    const out = Buffer.concat(chunks);
    expect(out.subarray(0, 5).toString()).toBe('%PDF-');
    expect(out.length).toBeGreaterThan(5000);
    expect(bodyAfter(d, 'Cash in').some(r => r[1].text === '???????')).toBe(true);
    expect(d.content[d.content.length - 1].text).toMatch(/Excel export carries every name/);
  });
});
