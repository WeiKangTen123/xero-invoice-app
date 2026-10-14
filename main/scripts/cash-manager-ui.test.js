const fs   = require('fs');
const path = require('path');

// The Cash Flow Manager tab on the screen side. There is no React test setup
// in this project, so this follows balance-ui.test.js: the decisions — the
// window, what the chart draws and how its axis is ruled, the colour of a
// balance, the tiles, the lists' filters and groups, what each form may send,
// the calendar — are plain functions in cash-manager.js, a file with no
// imports, loaded whole and run here against a payload shaped as the server
// sends it (main/xero/cash-manager.js); the wiring (the tab's place on the
// page, live updates, the requests each control makes, the exports and the
// check against Xero) is checked in the source.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function loadHelpers(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const h     = loadHelpers('pages/xero-insights/cash-manager.js');
const check = loadHelpers('pages/xero-insights/xero-check.js');

// A forecast as the server sends it on Monday 12 Oct 2026, in SGD: 10,000 in
// the bank, an overdraft limit of 5,000 on one account, a tax bill on the
// 15th that takes the balance near zero and rent on the 17th that takes it
// below — within the limit — and an invoice a customer is late with.
const TODAY = '2026-10-12';
const MOVES = { 0: [1200, 300], 3: [5000, 15000], 5: [0, 4000], 10: [900, 0] };
const series = (() => {
  let balance = 10000;
  return Array.from({ length: 91 }, (_, i) => {
    const [cin, cout] = MOVES[i] || [0, 0];
    balance += cin - cout;
    return { date: h.addDays(TODAY, i), in: cin, out: cout, net: cin - cout, balance };
  });
})();

// Xero's amount is the item's own unless a change made here moved it.
const item = (key, extra) => ({
  key, direction: 'in', source: 'invoice', date: TODAY, dueDate: TODAY, dateBasis: 'due', amount: 0,
  currency: 'SGD', contactName: '', number: '', reference: '', overdue: false, excluded: false, overridden: false, entryId: null,
  ...extra, originalAmount: extra.originalAmount ?? extra.amount,
});
const items = [
  item('invoice:i1',  { amount: 1200, contactName: 'Acme Ltd', number: 'INV-0012', reference: 'Oct retainer' }),
  item('invoice:b1',  { direction: 'out', source: 'bill', dateBasis: 'planned', amount: 300, contactName: 'Office Co', number: 'BILL-7' }),
  item('invoice:i5',  { date: '2026-09-30', dueDate: '2026-09-30', amount: 500, contactName: 'Beta Pte', number: 'INV-0005', overdue: true }),
  item('invoice:b2',  { direction: 'out', source: 'bill', date: '2026-10-01', dueDate: '2026-10-01', amount: 800, contactName: 'Gamma', overdue: true }),
  item('invoice:i13', { date: '2026-10-20', dueDate: '2026-10-20', amount: 700, contactName: 'Acme Ltd', number: 'INV-0013', excluded: true }),
  item('manual:e1:2026-10-15', { source: 'manual', date: '2026-10-15', dueDate: null, dateBasis: 'manual', amount: 5000,
                                 reference: 'Loan drawdown', description: 'Loan drawdown', entryId: 'e1' }),
  item('invoice:i9',  { date: '2026-10-22', dueDate: '2026-10-14', dateBasis: 'override', overridden: true, amount: 900, originalAmount: 1000,
                        contactName: 'Beta Pte', number: 'INV-0009' }),
  item('invoice:b3',  { direction: 'out', source: 'bill', date: '2026-10-15', dueDate: '2026-10-15', amount: 15000, contactName: 'Tax Office' }),
  item('invoice:b4',  { direction: 'out', source: 'bill', date: '2026-10-17', dueDate: '2026-10-17', amount: 4000, contactName: 'Landlord' }),
];
const payload = {
  connected: true,
  organisation: { name: 'Nexsoss Pte Ltd', currency: 'SGD' },
  today: TODAY,
  horizonDays: 91,
  bank: {
    accounts: [
      { accountId: 'a1', name: 'Aspire SGD', currency: 'SGD', balance: 9000, included: true, openingAdjustment: 0, overdraft: 0, foreign: false },
      { accountId: 'a2', name: 'OCBC',       currency: 'SGD', balance: 1000, included: true, openingAdjustment: 0, overdraft: 5000, foreign: false },
      { accountId: 'a3', name: 'Wise USD',   currency: 'USD', balance: 2500, included: false, openingAdjustment: 0, overdraft: 0, foreign: true },
    ],
    balance: 10000, overdraft: 5000,
  },
  tiles: {
    bankBalance: 10000,
    today:     { in: 1200, out: 300,   net: 900 },
    next7:     { in: 5000, out: 19000, net: -14000 },
    next8to30: { in: 900,  out: 0,     net: 900 },
    overdue:   { in: 500,  out: 800,   net: -300 },
  },
  runwayDays: null,
  series,
  items,
  notes: ['Anything dated before today is overdue.'],
  cached: false,
  fetchedAt: 1760234520000,
  tenants: [{ tenantId: 't1', tenantName: 'Nexsoss Pte Ltd' }],
  activeTenantId: 't1',
};

describe('dates, read from the string', () => {
  test('a real calendar day, and days added across a month, a year and a leap day', () => {
    expect(h.isIsoDate('2026-10-12')).toBe(true);
    expect(h.isIsoDate('2026-02-30')).toBe(false);
    expect(h.isIsoDate('12/10/2026')).toBe(false);
    expect(h.addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(h.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(h.addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(h.addDays('2026-10-12', -30)).toBe('2026-09-12');
    expect(h.addDays('bad', 1)).toBe('');
  });

  test('labelled for a heading, an axis and a row', () => {
    expect(h.longDay('2026-12-10')).toBe('10 Dec 2026');
    expect(h.shortDay('2026-10-12')).toBe('12 Oct');
    expect(h.weekdayDay('2026-10-12')).toBe('Mon 12 Oct');
    expect(h.weekdayDay('2026-10-15')).toBe('Thu 15 Oct');
    expect(h.longDay('')).toBe('');
  });
});

describe('the window and what is remembered', () => {
  test('today and the 30, 60 or 90 days after it, ending on the day Xero\'s window does', () => {
    const w = h.windowOf(payload, 60);
    expect(w.days).toBe(60);
    expect(w.series).toHaveLength(61);
    expect(w.start).toBe(TODAY);
    expect(w.end).toBe('2026-12-11');
    expect(w.title).toBe('Projected for 60 days ending on 11 Dec 2026');
    expect(h.windowOf(payload, 30)).toMatchObject({ days: 30, end: '2026-11-11', title: 'Projected for 30 days ending on 11 Nov 2026' });
    expect(h.windowOf(payload, 90)).toMatchObject({ days: 90, end: '2027-01-10', title: 'Projected for 90 days ending on 10 Jan 2027' });
    // Xero's own example: seen on 6 Oct, "60 days" ends on 5 Dec.
    const xero = { today: '2026-10-06', series: Array.from({ length: 91 }, (_, i) => ({ date: h.addDays('2026-10-06', i), in: 0, out: 0, net: 0, balance: 0 })) };
    expect(h.windowOf(xero, 60).title).toBe('Projected for 60 days ending on 5 Dec 2026');
    expect(h.windowOf(xero, 30).end).toBe('2026-11-05');
    expect(h.windowOf(xero, 90).end).toBe('2027-01-04');
  });

  test('anything but 30, 60 or 90 is 60, and a short series is counted as it is', () => {
    expect(h.windowOf(payload, 45).days).toBe(60);
    expect(h.windowOf(payload, '90').days).toBe(90);
    expect(h.windowOf({ ...payload, series: series.slice(0, 20) }, 30).title).toBe('Projected for 19 days ending on 31 Oct 2026');
    expect(h.windowOf(null, 30)).toMatchObject({ days: 0, series: [], title: 'Nothing projected yet' });
  });

  test('the view, mode and window remembered are checked one by one, and default to 60 days of cash in and out', () => {
    expect(h.readPrefs(null)).toEqual({ days: 60, view: 'chart', mode: 'inout' });
    expect(h.readPrefs('not json')).toEqual({ days: 60, view: 'chart', mode: 'inout' });
    expect(h.readPrefs('{"days":90,"view":"calendar","mode":"net"}')).toEqual({ days: 90, view: 'calendar', mode: 'net' });
    expect(h.readPrefs({ days: 45, view: 'pie', mode: 'balance' })).toEqual({ days: 60, view: 'chart', mode: 'balance' });
  });

  test('the exports and the check take the organisation and the window', () => {
    expect(h.exportQueryFor({ tenantId: 't1', days: 90 })).toEqual({ tenantId: 't1', days: '90' });
    expect(h.exportQueryFor({ tenantId: '', days: 7 })).toEqual({ days: '60' });
  });

  test('every control is offered, in order', () => {
    expect(h.daysOptions().map(o => o.key)).toEqual([30, 60, 90]);
    expect(h.viewOptions().map(o => o.key)).toEqual(['chart', 'table', 'calendar']);
    expect(h.modeOptions().map(o => o.label)).toEqual(['Cash in & cash out', 'Bank balance', 'Net movement']);
    expect(h.filterOptions().map(o => o.label)).toEqual(['Current', 'Overdue', 'Excluded', 'All']);
    expect(h.groupOptions().map(o => o.label)).toEqual(['None', 'Contact', 'Due date']);
    expect(h.repeatOptions().map(o => o.label)).toEqual(['Once', 'Daily', 'Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Yearly']);
  });
});

describe('what the chart draws', () => {
  test('cash in above zero and out below, a day each, with the overdue pair apart', () => {
    const c = h.chartBars(payload, 30, 'inout');
    expect(c.mode).toBe('inout');
    expect(c.points).toHaveLength(31);
    expect(c.points[0]).toMatchObject({ date: TODAY, label: '12 Oct', in: 1200, out: 300, net: 900, balance: 10900, tick: true });
    expect(c.overdue).toEqual({ in: 500, out: 800, net: -300 });
    // The tax bill on the 15th is the lowest bar, the loan the highest.
    expect(c.min).toBe(-15000);
    expect(c.max).toBe(5000);
    expect(c.empty).toBe(false);
  });

  test('cash out arrives as an amount and is drawn below zero whichever sign it came with', () => {
    const c = h.chartBars({ ...payload, series: [{ date: TODAY, in: 0, out: -250, net: -250, balance: 0 }] }, 30, 'inout');
    expect(c.points[0].out).toBe(250);
    expect(c.min).toBe(-800);
  });

  test('net movement is one bar a day, and the overdue net beside it', () => {
    const c = h.chartBars(payload, 30, 'net');
    expect(c.min).toBe(-10000);
    expect(c.max).toBe(900);
    expect(c.overdue.net).toBe(-300);
  });

  test('the bank balance is a line from today, with no overdue pair, ruled down to the overdraft limit once it dips', () => {
    const c = h.chartBars(payload, 30, 'balance');
    expect(c.overdue).toBe(null);
    expect(c.points.map(p => p.balance).slice(0, 6)).toEqual([10900, 10900, 10900, 900, 900, -3100]);
    expect(c.overdraft).toBe(5000);
    expect(c.min).toBe(-5000);
    expect(c.max).toBe(10900);
    const never = h.chartBars({ ...payload, series: series.slice(0, 3) }, 30, 'balance');
    expect(never.min).toBe(0);
  });

  test('labels are thinned to a rhythm that fits', () => {
    expect(h.labelStep(30, 10)).toBe(3);
    expect(h.labelStep(60, 10)).toBe(7);
    expect(h.labelStep(90, 10)).toBe(14);
    expect(h.labelStep(5, 10)).toBe(1);
    const ticked = h.chartBars(payload, 60, 'inout', { maxLabels: 10 }).points.filter(p => p.tick).map(p => p.label);
    expect(ticked).toEqual(['12 Oct', '19 Oct', '26 Oct', '2 Nov', '9 Nov', '16 Nov', '23 Nov', '30 Nov', '7 Dec']);
  });

  test('a window with nothing in or out says so, and an unknown mode is cash in and out', () => {
    const quiet = { ...payload, series: series.map(s => ({ ...s, in: 0, out: 0, net: 0 })), tiles: { ...payload.tiles, overdue: { in: 0, out: 0, net: 0 } } };
    expect(h.chartBars(quiet, 30, 'inout').empty).toBe(true);
    expect(h.chartBars(payload, 30, 'pie').mode).toBe('inout');
  });
});

describe('the axis', () => {
  test('round ticks a step apart taking in both ends and zero, labelled $50K-style', () => {
    expect(h.axisTicks(-42000, 61000, { symbol: '$' })).toMatchObject({
      ticks: [-50000, 0, 50000, 100000], labels: ['-$50K', '$0', '$50K', '$100K'], min: -50000, max: 100000, step: 50000,
    });
    expect(h.axisTicks(-15000, 5000, { symbol: '$' }).labels).toEqual(['-$15K', '-$10K', '-$5K', '$0', '$5K']);
    expect(h.axisTicks(0, 1234, { symbol: '$' }).labels).toEqual(['$0', '$500', '$1K', '$1.5K']);
  });

  test('an empty window still gets an axis, ruled to a thousand', () => {
    expect(h.axisTicks(0, 0)).toMatchObject({ ticks: [0, 250, 500, 750, 1000], labels: ['0', '250', '500', '750', '1K'] });
  });

  test('figures in a few characters, and the currency\'s sign where it has a well-known one', () => {
    expect(h.compactAmount(1250000, '$')).toBe('$1.25M');
    expect(h.compactAmount(-2500, '$')).toBe('-$2.5K');
    expect(h.compactAmount(12500)).toBe('12.5K');
    expect(h.compactAmount(250)).toBe('250');
    expect(h.compactAmount(0.004, '$')).toBe('$0');
    expect(h.currencySymbol('SGD')).toBe('$');
    expect(h.currencySymbol('gbp')).toBe('£');
    expect(h.currencySymbol('XOF')).toBe('');
  });
});

describe('the colour of a balance', () => {
  test('green at or above zero, orange within the overdraft limit, red past it', () => {
    expect(h.balanceColour(100, 0)).toBe('var(--success)');
    expect(h.balanceColour(0, 0)).toBe('var(--success)');
    expect(h.balanceColour(-0.004, 0)).toBe('var(--success)');
    expect(h.balanceColour(-50, 100)).toBe('var(--warning)');
    expect(h.balanceColour(-100, 100)).toBe('var(--warning)');
    expect(h.balanceColour(-100.01, 100)).toBe('var(--danger)');
    expect(h.balanceColour(-1, 0)).toBe('var(--danger)');
    expect(h.balanceColour(-1, undefined)).toBe('var(--danger)');
  });

  test('a movement is green in, red out, uncoloured when nil', () => {
    expect([900, -300, 0, 0.001].map(h.signColour)).toEqual(['var(--success)', 'var(--danger)', undefined, undefined]);
  });
});

describe('the tiles', () => {
  test('today\'s balance, then the movement today, over the week, the rest of the month, and overdue', () => {
    const tiles = h.tileFigures(payload);
    expect(tiles.map(t => t.label)).toEqual([
      'Today\'s bank balance', 'Today\'s movement', 'Next 1–7 days movement', 'Next 8–30 days movement', 'Overdue (net)',
    ]);
    expect(tiles[0]).toMatchObject({ kind: 'balance', value: 10000, date: '12 Oct 2026', overdraft: 5000, runwayDays: null, tone: undefined });
    expect(tiles[1]).toMatchObject({ kind: 'movement', value: 900, in: 1200, out: 300, tone: 'var(--success)' });
    expect(tiles[2]).toMatchObject({ value: -14000, tone: 'var(--danger)' });
    expect(tiles[4]).toMatchObject({ value: -300, in: 500, out: 800 });
  });

  test('an overdrawn balance is coloured as the line is, and a net the server left out is worked out', () => {
    const t = h.tileFigures({ ...payload, tiles: { bankBalance: -2000, today: { in: 10, out: 4 } }, runwayDays: 12 });
    expect(t[0]).toMatchObject({ value: -2000, tone: 'var(--warning)', runwayDays: 12 });
    expect(t[1].value).toBe(6);
    expect(t[3]).toMatchObject({ value: 0, in: 0, out: 0, tone: undefined });
  });
});

describe('the lists', () => {
  const titles = list => list.groups.flatMap(g => g.rows.map(r => h.itemTitle(r).primary));

  test('current is what is neither overdue nor excluded, in date order, with every filter counted', () => {
    const list = h.listRows(items, 'in', { filter: 'current' });
    expect(titles(list)).toEqual(['INV-0012', 'Loan drawdown', 'INV-0009']);
    expect(list.total).toBe(7100);
    expect(list.counts).toEqual({ current: 3, overdue: 1, excluded: 1, all: 5 });
    expect(list.groups).toHaveLength(1);
  });

  test('overdue, excluded and all; an excluded item is under Excluded alone', () => {
    expect(titles(h.listRows(items, 'in', { filter: 'overdue' }))).toEqual(['INV-0005']);
    expect(titles(h.listRows(items, 'in', { filter: 'excluded' }))).toEqual(['INV-0013']);
    const out = h.listRows(items, 'out', { filter: 'current' });
    expect(out.groups.flatMap(g => g.rows.map(h.contactOf))).toEqual(['Office Co', 'Tax Office', 'Landlord']);
    // A bill with neither number nor reference still fills its column.
    expect(titles(out)).toEqual(['BILL-7', '—', '—']);
    const all = h.listRows(items, 'in', { filter: 'all' });
    expect(all.count).toBe(5);
    expect(all).toMatchObject({ total: 8300, counted: 7600, excluded: 700, excludedCount: 1 });
  });

  test('grouped by contact, alphabetically, an entry made here under its own name, each group totalled', () => {
    const list = h.listRows(items, 'in', { filter: 'all', groupBy: 'contact' });
    expect(list.groups.map(g => [g.label, g.rows.length, g.total])).toEqual([
      ['Acme Ltd', 2, 1900], ['Beta Pte', 2, 1400], ['Your entry', 1, 5000],
    ]);
  });

  test('grouped by due date, earliest first; an entry with no due date by its own date', () => {
    const list = h.listRows(items, 'in', { filter: 'current', groupBy: 'due' });
    expect(list.groups.map(g => g.label)).toEqual(['Due 12 Oct 2026', 'Due 14 Oct 2026', 'Dated 15 Oct 2026']);
  });

  test('an unknown filter or grouping falls back, and nothing is an empty list', () => {
    expect(h.listRows(items, 'in', { filter: 'x', groupBy: 'y' })).toMatchObject({ filter: 'current', groupBy: 'none', count: 3 });
    expect(h.listRows(null, 'in')).toMatchObject({ groups: [], count: 0, total: 0 });
  });

  test('who and what each row is', () => {
    expect(h.contactOf(items[5])).toBe('Your entry');
    expect(h.contactOf({ source: 'payment' })).toBe('No contact');
    expect(h.itemTitle(items[0])).toEqual({ primary: 'INV-0012', secondary: 'Oct retainer' });
    expect(h.itemTitle(items[5])).toEqual({ primary: 'Loan drawdown', secondary: '' });
    expect(h.amountChanged(items[6])).toBe(true);
    expect(h.amountChanged(items[0])).toBe(false);
  });

  test('every basis has a marker and a reason', () => {
    expect(['override', 'expected', 'planned', 'predicted', 'due', 'scheduled', 'payment', 'manual'].map(h.basisLabel))
      .toEqual(['Changed here', 'Expected', 'Planned', 'Predicted', 'Due', 'Repeating', 'Payment', 'Your entry']);
    expect(h.basisHint('predicted')).toMatch(/payment history|paid before/);
    expect(h.basisLabel('other')).toBe('');
  });
});

describe('an entry of one\'s own', () => {
  const good = { direction: 'in', description: '  Loan drawdown ', amount: '1,250.50', date: '2026-10-20', frequency: 'monthly', endDate: '2027-03-20' };

  test('a good entry has no errors, and is sent trimmed, as a number, with its end date', () => {
    expect(h.validateEntry(good)).toEqual({});
    expect(h.entryBody(good, 't1')).toEqual({
      tenantId: 't1', direction: 'in', description: 'Loan drawdown', amount: 1250.5, date: '2026-10-20', frequency: 'monthly', endDate: '2027-03-20',
    });
  });

  test('an end date left in the form goes nowhere once it no longer repeats', () => {
    const once = { ...good, frequency: 'once', endDate: '2020-01-01' };
    expect(h.validateEntry(once)).toEqual({});
    expect(h.entryBody(once, 't1')).not.toHaveProperty('endDate');
  });

  test('every field is checked as the server checks it', () => {
    expect(Object.keys(h.validateEntry({}))).toEqual(['direction', 'description', 'amount', 'date']);
    expect(h.validateEntry({ ...good, description: '   ' }).description).toBe('Enter a description');
    expect(h.validateEntry({ ...good, description: 'x'.repeat(121) }).description).toMatch(/120 characters/);
    expect(h.validateEntry({ ...good, description: 'x'.repeat(120) })).toEqual({});
    expect(h.validateEntry({ ...good, amount: '0' }).amount).toBe('The amount must be more than zero');
    expect(h.validateEntry({ ...good, amount: '-5' }).amount).toBe('The amount must be more than zero');
    expect(h.validateEntry({ ...good, amount: '1.234' }).amount).toBe('Use at most two decimal places');
    expect(h.validateEntry({ ...good, amount: 'ten' }).amount).toBe('Enter an amount, like 1250.00');
    expect(h.validateEntry({ ...good, amount: '1000000001' }).amount).toMatch(/1,000,000,000/);
    expect(h.validateEntry({ ...good, date: '2026-02-30' }).date).toBe('Choose a date');
    expect(h.validateEntry({ ...good, date: '1989-12-31', endDate: '' }).date).toMatch(/between 1990 and 2100/);
    expect(h.validateEntry({ ...good, endDate: '2026-10-19' }).endDate).toBe('The end date is before the first date');
    expect(h.validateEntry({ ...good, frequency: 'hourly' }).frequency).toBe('Choose how often it repeats');
  });

  test('a blank form, an entry the server holds, and finding it', () => {
    expect(h.emptyEntryForm(TODAY, 'out')).toEqual({ direction: 'out', description: '', amount: '', date: TODAY, frequency: 'once', endDate: '' });
    const stored = { id: 'e1', direction: 'in', description: 'Loan drawdown', amount: 5000, date: '2026-10-15', frequency: 'weekly', endDate: null };
    expect(h.entryForm(stored)).toEqual({ direction: 'in', description: 'Loan drawdown', amount: '5000.00', date: '2026-10-15', frequency: 'weekly', endDate: '' });
    expect(h.entryFor(h.entriesFrom({ entries: [stored] }), 'e1')).toBe(stored);
    expect(h.entryFor(h.entriesFrom([stored]), 'e2')).toBe(null);
    expect(h.entriesFrom(null)).toEqual([]);
  });
});

describe('a change to an item Xero holds', () => {
  const inv = items[0];

  test('a date picked, or reached by shifting either way', () => {
    expect(h.overrideFromForm(inv, { how: 'date', date: '2026-10-20', amount: '1200.00' })).toEqual({ body: { key: 'invoice:i1', date: '2026-10-20' }, errors: {} });
    expect(h.overrideFromForm(inv, { how: 'shift', shift: '14', amount: '1200' }).body).toEqual({ key: 'invoice:i1', date: '2026-10-26' });
    expect(h.overrideFromForm(inv, { how: 'shift', shift: '-30', amount: '' }).body).toEqual({ key: 'invoice:i1', date: '2026-09-12' });
  });

  test('an amount, which may be nil but not negative', () => {
    expect(h.overrideFromForm(inv, { how: 'date', date: TODAY, amount: '1,000' }).body).toEqual({ key: 'invoice:i1', amount: 1000 });
    expect(h.overrideFromForm(inv, { how: 'date', date: TODAY, amount: '0' }).body).toEqual({ key: 'invoice:i1', amount: 0 });
    expect(h.overrideFromForm(inv, { how: 'date', date: TODAY, amount: '-1' }).errors.amount).toBe('The amount cannot be negative');
  });

  test('a form that changes nothing, or a shift that is not whole days, is not sent', () => {
    expect(h.overrideFromForm(inv, { how: 'date', date: TODAY, amount: '1200.00' }).errors).toEqual({ form: 'Nothing has changed' });
    expect(h.overrideFromForm(inv, { how: 'shift', shift: '0', amount: '1200' }).errors).toEqual({ form: 'Nothing has changed' });
    expect(h.overrideFromForm(inv, { how: 'shift', shift: '1.5', amount: '1200' }).errors.shift).toBe('Enter a whole number of days');
    expect(h.overrideFromForm(inv, { how: 'shift', shift: '99999', amount: '1200' }).errors.shift).toMatch(/at most 3650 days/);
    expect(h.overrideFromForm(inv, { how: 'date', date: '2026-13-01', amount: '1200' }).errors.date).toBe('Choose a valid date');
  });
});

describe('bank options', () => {
  const accounts = payload.bank.accounts;

  test('the form holds the base-currency accounts as typed; a foreign one is not in it', () => {
    expect(h.bankOptionsForm(accounts)).toEqual({
      a1: { included: true, openingAdjustment: '', overdraft: '' },
      a2: { included: true, openingAdjustment: '', overdraft: '5000.00' },
    });
  });

  test('sent as numbers, blank as nil; an adjustment may be negative, a limit may not', () => {
    const form = { ...h.bankOptionsForm(accounts), a1: { included: true, openingAdjustment: '-250.5', overdraft: '' } };
    expect(h.bankOptionsBody(accounts, form, 't1')).toEqual({
      body: { tenantId: 't1', accounts: { a1: { included: true, openingAdjustment: -250.5, overdraft: 0 }, a2: { included: true, openingAdjustment: 0, overdraft: 5000 } } },
      errors: {},
    });
    const bad = { ...form, a2: { included: true, openingAdjustment: '1.234', overdraft: '-1' } };
    expect(h.bankOptionsBody(accounts, bad, 't1').errors).toEqual({
      a2: { openingAdjustment: 'Use at most two decimal places', overdraft: 'The amount cannot be negative' },
    });
  });

  test('the balance the forecast would start from, as typed', () => {
    const form = h.bankOptionsForm(accounts);
    expect(h.bankStart(accounts, form)).toBe(10000);
    expect(h.bankStart(accounts, { ...form, a1: { ...form.a1, openingAdjustment: '-250.5' } })).toBe(9749.5);
    expect(h.bankStart(accounts, { ...form, a2: { ...form.a2, included: false } })).toBe(9000);
  });
});

describe('a day\'s items, the table and the calendar', () => {
  test('a day\'s items: cash in first, largest first; excluded ones left out; overdue ones under Overdue alone', () => {
    expect(h.dayItems(payload, '2026-10-15').map(i => i.key)).toEqual(['manual:e1:2026-10-15', 'invoice:b3']);
    expect(h.dayItems(payload, 'overdue').map(i => i.key)).toEqual(['invoice:i5', 'invoice:b2']);
    expect(h.dayItems(payload, '2026-10-20')).toEqual([]);
    expect(h.dayItems(payload, '2026-09-30')).toEqual([]);
  });

  test('the tooltip and the day panel: the day, its figures, and its first items', () => {
    expect(h.daySummary(payload, TODAY)).toMatchObject({ title: 'Today, Mon 12 Oct', in: 1200, out: 300, net: 900, balance: 10900, count: 2, more: 0 });
    const tax = h.daySummary(payload, '2026-10-15', 1);
    expect(tax).toMatchObject({ title: 'Thu 15 Oct 2026', in: 5000, out: 15000, net: -10000, balance: 900, count: 2, more: 1 });
    expect(tax.items.map(i => i.key)).toEqual(['manual:e1:2026-10-15']);
    expect(h.daySummary(payload, 'overdue')).toMatchObject({ title: 'Overdue', in: 500, out: 800, net: -300, balance: null, count: 2 });
  });

  test('the table: Overdue first with no balance, a row a day, and the window\'s totals', () => {
    const { rows, total, days } = h.tableRows(payload, 30);
    expect(rows).toHaveLength(32);
    expect(days).toBe(31);
    expect(rows[0]).toEqual({ key: 'overdue', date: 'overdue', label: 'Overdue', in: 500, out: 800, net: -300, balance: null });
    expect(rows[1]).toMatchObject({ date: TODAY, label: 'Mon 12 Oct', today: true, balance: 10900 });
    expect(rows[31]).toMatchObject({ date: '2026-11-11', label: 'Wed 11 Nov' });
    expect(total).toEqual({ in: 7100, out: 19300, net: -12200, balance: -2200 });
  });

  test('the calendar: a month grid from Monday for each month the window touches, figures only inside it', () => {
    const months = h.calendarMonths(payload, 30);
    expect(months.map(m => m.label)).toEqual(['October 2026', 'November 2026']);
    const oct = months[0].weeks;
    // 1 Oct 2026 is a Thursday.
    expect(oct[0].slice(0, 3)).toEqual([null, null, null]);
    expect(oct[0][3]).toMatchObject({ date: '2026-10-01', day: 1, inWindow: false });
    const cells = months.flatMap(m => m.weeks.flat()).filter(Boolean);
    expect(cells.find(c => c.date === '2026-10-11').inWindow).toBe(false);
    expect(cells.find(c => c.date === TODAY)).toMatchObject({ inWindow: true, today: true, net: 900, in: 1200, out: 300 });
    expect(cells.find(c => c.date === '2026-11-11').inWindow).toBe(true);
    expect(cells.find(c => c.date === '2026-11-12')).toMatchObject({ inWindow: false, net: 0, balance: null });
    // 1 Nov 2026 is a Sunday; every week is seven cells.
    expect(months[1].weeks[0].slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(months.every(m => m.weeks.every(w => w.length === 7))).toBe(true);
    expect(h.weekdayLabels()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(h.calendarMonths(payload, 90).map(m => m.key)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01']);
    expect(h.calendarMonths(null, 30)).toEqual([]);
  });
});

// ── The last thirty days, as they happened ──────────────────────────────────

describe('what actually moved before today', () => {
  // Thirty days as the server sends them: 8,000 received on 6 Oct and 1,200
  // paid on 9 Oct, the balance worked back from today's 10,000.
  const actuals = (() => {
    const moves = { '2026-10-06': [8000, 0], '2026-10-09': [0, 1200] };
    let balance = 10000;
    return Array.from({ length: 30 }, (_, i) => h.addDays(TODAY, i - 30)).reverse().map(date => {
      const [cin, out] = moves[date] || [0, 0];
      const row = { date, in: cin, out, net: cin - out, balance };
      balance -= cin - out;
      return row;
    }).reverse();
  })();
  const actualItems = [
    { key: 'actual:payment:p1', direction: 'in', date: '2026-10-06', amount: 8000, source: 'payment', contactName: 'Acme Ltd', number: 'INV-0007', reference: '' },
    { key: 'actual:banktransaction:t1', direction: 'out', date: '2026-10-09', amount: 1200, source: 'banktransaction', contactName: 'Landlord', number: '', reference: 'Sep rent' },
  ];
  const withPast = { ...payload, actualDays: 30, actualsAvailable: true, actuals, actualItems };

  test('drawn muted left of everything, all thirty on a desktop and the last week on a phone, Graph days counting the days ahead only', () => {
    const c = h.chartBars(withPast, 60, 'inout');
    expect(c.points).toHaveLength(61);
    expect(c.actual).toHaveLength(30);
    expect(c.actual[0]).toMatchObject({ date: '2026-09-12', actual: true, in: 0, out: 0 });
    expect(c.actual.find(p => p.date === '2026-10-06')).toMatchObject({ in: 8000, out: 0, net: 8000, balance: 11200 });
    // The receipt is the tallest bar now.
    expect(c.max).toBe(8000);
    expect(c.actualNote).toBe('');
    expect(h.actualDaysFor(1200)).toBeNull();
    expect(h.actualDaysFor(390)).toBe(7);
    const phone = h.chartBars(withPast, 60, 'inout', { actualDays: h.actualDaysFor(390) });
    expect(phone.actual.map(p => p.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(phone.points).toHaveLength(61);
  });

  test('under "Bank balance" the line runs back through the days before today; a balance that could not be worked back draws none', () => {
    const c = h.chartBars(withPast, 30, 'balance');
    expect(c.overdue).toBe(null);
    expect(c.actual.map(p => p.balance).slice(-7)).toEqual([3200, 11200, 11200, 11200, 10000, 10000, 10000]);
    expect(c.min).toBe(-5000);
    expect(c.max).toBe(11200);
    const blind = h.chartBars({ ...withPast, actuals: actuals.map(a => ({ ...a, balance: null })) }, 30, 'balance');
    expect(blind.actual.every(p => p.balance === null)).toBe(true);
    expect(blind.max).toBe(10900);
  });

  test('past cash the server could not read is said, never drawn as nil', () => {
    const gone = { ...payload, actualsAvailable: false, actuals: [], actualItems: [] };
    expect(h.chartBars(gone, 30, 'inout')).toMatchObject({ actual: [], actualNote: 'Past cash unavailable' });
    expect(h.tableRows(gone, 30).actualNote).toBe('Past cash unavailable');
    expect(h.actualWindow(gone)).toEqual({ rows: [], note: 'Past cash unavailable' });
    // A payload from before the actuals existed says nothing either way.
    expect(h.actualWindow(payload)).toEqual({ rows: [], note: '' });
  });

  test('a day before today lists what moved on it, marked Actual, with its own figures', () => {
    expect(h.dayItems(withPast, '2026-10-06')).toEqual([{ ...actualItems[0], actual: true, dateBasis: 'actual' }]);
    expect(h.basisLabel('actual')).toBe('Actual');
    expect(h.daySummary(withPast, '2026-10-09')).toMatchObject({
      title: 'Fri 9 Oct 2026 · Actual', actual: true, in: 0, out: 1200, net: -1200, balance: 10000, count: 1,
    });
    expect(h.daySummary(withPast, '2026-10-07')).toMatchObject({ actual: true, count: 0, balance: 11200 });
    // Today and the days ahead are the forecast's, as before.
    expect(h.daySummary(withPast, TODAY)).toMatchObject({ actual: false, title: 'Today, Mon 12 Oct', count: 2 });
  });

  test('the table leads with the thirty days, each marked Actual, before Overdue; the totals are the days ahead only', () => {
    const t = h.tableRows(withPast, 30);
    expect(t.rows).toHaveLength(30 + 1 + 31);
    expect(t.rows[0]).toMatchObject({ key: 'actual:2026-09-12', actual: true, label: 'Sat 12 Sep', balance: 3200 });
    expect(t.rows[29]).toMatchObject({ date: '2026-10-11', actual: true, balance: 10000 });
    expect(t.rows[30].key).toBe('overdue');
    expect(t.days).toBe(31);
    expect(t.total).toEqual(h.tableRows(payload, 30).total);
  });

  test('the calendar shades the days before today as actual, from the month they start in', () => {
    const months = h.calendarMonths(withPast, 30);
    expect(months.map(m => m.key)).toEqual(['2026-09', '2026-10', '2026-11']);
    const cells = months.flatMap(m => m.weeks.flat()).filter(Boolean);
    expect(cells.find(c => c.date === '2026-09-11')).toMatchObject({ inWindow: false, actual: false });
    expect(cells.find(c => c.date === '2026-10-06')).toMatchObject({ inWindow: true, actual: true, in: 8000, net: 8000, balance: 11200 });
    expect(cells.find(c => c.date === TODAY)).toMatchObject({ inWindow: true, actual: false, today: true });
  });
});

describe('the check panel\'s wording for the forecast', () => {
  test('says what is checked, and how to see the same figures in Xero', () => {
    expect(check.checkIntro('cash-manager-check')).toMatch(/^The forecast's starting figures .* checked against Xero, read separately\. Read-only\.$/);
    expect(check.checkIntro('budget-check')).toBe('The grid asked for again without comparison periods, line by line. Read-only; up to three Xero calls.');
    const steps = check.cashManagerHowTo({ today: TODAY });
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatch(/^In Xero: Accounting → Bank accounts\./);
    expect(steps[1]).toMatch(/Aged Receivables Summary and Aged Payables Summary \(date 12 Oct 2026\)/);
    expect(steps[2]).toMatch(/stay in this app/);
    expect(check.cashManagerHowTo({})[1]).not.toMatch(/\(date/);
  });
});

describe('the page is wired to the tab', () => {
  const page = read('pages/XeroInsights.jsx');

  test('the tab sits right after Cash Flow and is not a performance tab', () => {
    expect(page).toMatch(/\{ key: 'cashflow', label: 'Cash Flow' \},\n(\s*\/\/[^\n]*\n)*\s*\{ key: 'cashmanager', label: 'Cash Flow Manager' \},\n\s*\{ key: 'profit',/);
    expect(page).toMatch(/const PERF_TABS = \['overview', 'revenue', 'banking', 'profit', 'analysis', 'cashflow'\];/);
    expect(page).toMatch(/import CashManagerTab from '\.\/xero-insights\/CashManagerTab';/);
  });

  test('it has its own state, counter and fetch, for the organisation on screen', () => {
    expect(page).toMatch(/const \[cashManager, setCashManager\] = useState\(CASH_MANAGER_IDLE\);/);
    expect(page).toMatch(/const seq = useRef\(\{[^}]*\bcashManager: 0\b/);
    const fn = page.slice(page.indexOf('function fetchCashManager('), page.indexOf('function viewStatement('));
    expect(fn).toMatch(/if \(activeTenantId\) params\.set\('tenantId', activeTenantId\);/);
    expect(fn).toMatch(/if \(opts\.force\) params\.set\('force', 'true'\);/);
    expect(fn).toMatch(/api\.get\(`\/xero-reports\/cash-manager\?\$\{params\.toString\(\)\}`\)/);
    expect(fn).toMatch(/if \(n !== seq\.current\.cashManager\) return false;\s+setCashManager\(\{ status: 'done', data: d, error: '' \}\);\s+return true;/);
    // Quiet keeps the forecast and says nothing; a failure keeps the last one.
    expect(fn).toMatch(/if \(!opts\.quiet\) setCashManager\(/);
    expect(fn).toMatch(/if \(opts\.quiet\) setCashManager\(s => \(s\.status === 'done' \? s : \{ \.\.\.s, status: 'done' \}\)\);/);
    expect(fn).toMatch(/setCashManager\(s => \(\{ status: 'done', data: s\.data, error: /);
  });

  test('fetched on opening, re-asked after a change seen in Xero, reset on a switch of organisation, refreshed with the page', () => {
    expect(page).toMatch(/if \(tab === 'cashmanager'\) \{\s+if \(cashManager\.status === 'idle'\) fetchCashManager\(\);\s+else if \(staleOnOpen\('cashmanager', cashManager\.data\?\.fetchedAt\)\) fetchCashManager\(\{ quiet: true \}\);/);
    const refetch = page.slice(page.indexOf('async function refetchShown()'), page.indexOf('function staleOnOpen('));
    expect(refetch).toMatch(/if \(tab === 'cashmanager'\)\s+jobs\.push\(fetchCashManager\(\{ quiet: true \}\)\);/);
    expect(page).toMatch(/if \(tab === 'cashmanager'\) \{ setCashManager\(CASH_MANAGER_IDLE\); fetchCashManager\(\); \}\s+else \{ seq\.current\.cashManager\+\+; setCashManager\(CASH_MANAGER_IDLE\); \}/);
    expect(page).toMatch(/if \(tab === 'cashmanager'\) fetchCashManager\(\{ force: true \}\);/);
  });

  test('the status line counts the forecast among the reads on screen, and the tab is keyed on the organisation', () => {
    expect(page).toMatch(/if \(tab === 'cashmanager' && !cashManager\.error\)\s+reads\.push\(cashManager\.data\?\.fetchedAt\);/);
    expect(page).toMatch(/<CashManagerTab key=\{activeTenantId \|\| ''\} cash=\{cashManager\} fetchCashManager=\{fetchCashManager\}[\s\S]*?tenantId=\{activeTenantId \|\| ''\}/);
  });
});

describe('the tab and its parts are wired to the helpers and the server', () => {
  const tab    = read('pages/xero-insights/CashManagerTab.jsx');
  const chart  = read('pages/xero-insights/CashManagerChart.jsx');
  const lists  = read('pages/xero-insights/CashManagerLists.jsx');
  const modals = read('pages/xero-insights/CashManagerModals.jsx');

  test('the header exports and checks the forecast on screen', () => {
    expect(tab).toMatch(/const exportQuery = exportQueryFor\(\{ tenantId: tid, days: prefs\.days \}\);/);
    expect(tab).toMatch(/<BudgetExport kind="cashmanager" query=\{exportQuery\} disabled=\{!ready\} \/>/);
    expect(tab).toMatch(/<XeroCheckPanel key=\{JSON\.stringify\(exportQuery\)\} query=\{exportQuery\} endpoint="cash-manager-check" howTo=\{cashManagerHowTo\}/);
    expect(tab).toMatch(/fetchCashManager\(\{ force: true \}\)/);
  });

  test('the sub-tabs, the note, the tiles and the controls are all there', () => {
    for (const label of ['Overview', 'Manage cash in', 'Manage cash out', 'Bank options', '+ Add cash in/out', 'Graph days']) expect(tab).toContain(label);
    expect(tab).toContain('Manage your cash flow without changing anything in Xero. Entries and changes you make here stay in this app.');
    expect(tab).toMatch(/tileFigures\(d\)\.map/);
    expect(tab).toMatch(/viewOptions\(\)/);
    expect(tab).toMatch(/modeOptions\(\)\.map/);
    expect(tab).toMatch(/daysOptions\(\)\.map/);
  });

  test('what is remembered is read and written inside try/catch, so a refused storage cannot break the tab', () => {
    const lines = tab.split('\n').filter(l => /localStorage\./.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const l of lines) expect(l).toMatch(/try \{/);
  });

  test('every change is the request the server expects, and the forecast is re-read quietly after it', () => {
    expect(tab).toMatch(/api\.put\('\/cash-manager\/overrides', \{ \.\.\.\(tid \? \{ tenantId: tid \} : \{\}\), key: item\.key, excluded: !item\.excluded \}\)/);
    expect(tab).toMatch(/api\.delete\(`\/cash-manager\/entries\/\$\{encodeURIComponent\(item\.entryId\)\}/);
    expect(tab).toMatch(/const ok = await fetchCashManager\(\{ quiet: true \}\);/);
    expect(tab).toMatch(/confirm\(\{[\s\S]*?danger: true/);
    expect(modals).toMatch(/api\.put\('\/cash-manager\/bank-options', body\)/);
    expect(modals).toMatch(/api\.post\('\/cash-manager\/entries', body\)/);
    expect(modals).toMatch(/api\.patch\(`\/cash-manager\/entries\/\$\{encodeURIComponent\(entryId\)\}`, body\)/);
    expect(modals).toMatch(/api\.get\(`\/cash-manager\/entries\$\{tenantQuery\(tenantId\)\}`\)/);
    expect(modals).toMatch(/api\.put\('\/cash-manager\/overrides', \{ \.\.\.\(tenantId \? \{ tenantId \} : \{\}\), \.\.\.body \}\)/);
    expect(modals).toMatch(/api\.delete\(`\/cash-manager\/overrides\?\$\{q\.toString\(\)\}`\)/);
    expect(modals).toMatch(/Reset to Xero&apos;s/);
    expect(modals).toMatch(/Not counted \(foreign currency\)/);
  });

  test('the forms validate with the helpers before anything is sent', () => {
    for (const name of ['validateEntry', 'entryBody', 'overrideFromForm', 'bankOptionsBody', 'bankOptionsForm', 'bankStart', 'repeatOptions']) {
      expect(modals).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./cash-manager'`, 's'));
    }
    expect(modals).toMatch(/\{repeating && \(/);
  });

  test('the chart, the table, the calendar and the lists lay out the helpers\' decisions', () => {
    for (const name of ['chartBars', 'axisTicks', 'balanceColour', 'calendarMonths', 'daySummary', 'tableRows', 'actualDaysFor', 'actualWindow']) {
      expect(chart).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./cash-manager'`, 's'));
    }
    expect(chart).toMatch(/strokeDasharray="3 3"/);
    expect(chart).toMatch(/>Overdue<\/text>/);
    // The days before today: the chart's width decides how many, they are
    // muted and labelled, and nothing of Xero's record can be edited.
    expect(chart).toMatch(/chartBars\(payload, days, mode, \{ maxLabels, actualDays: actualDaysFor\(W\) \}\)/);
    expect(chart).toMatch(/>Actual<\/text>/);
    expect(chart).toMatch(/ACTUAL_OPACITY = 0\.\d+/);
    expect(chart).toMatch(/\{onEdit && !item\.actual && \(/);
    expect(chart).toMatch(/· Actual<\/span>/);
    expect(lists).toMatch(/listRows\(payload\?\.items, direction, \{ filter, groupBy \}\)/);
    // The tables scroll sideways in their own box with the first column pinned.
    for (const src of [chart, lists]) {
      expect(src).toMatch(/overflow(X)?: 'auto'/);
      expect(src).toMatch(/position: 'sticky', left: 0/);
    }
  });
});

// What the tab needs from files outside it. Each fails until that file is
// changed, so the gap shows here rather than as a dialog that throws.
describe('what the tab needs from the API client and the check panel', () => {
  test('the API client offers PUT, which the overrides and bank options are saved with', () => {
    const client = read('api/client.js');
    expect(client).toMatch(/\bput:\s*\(path, body\)\s*=>\s*request\(path, \{ method: 'PUT'/);
  });

  test('the check panel asks the cash manager\'s own check route', () => {
    const panel = read('pages/xero-insights/XeroCheckPanel.jsx');
    expect(panel).toMatch(/api\.get\(`\/xero-reports\/cash-manager-check\?\$\{params\.toString\(\)\}`\)/);
  });
});
