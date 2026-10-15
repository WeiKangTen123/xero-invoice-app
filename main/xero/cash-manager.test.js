// The Cash Flow Manager: how each item is dated, what is overdue, what is
// netted, what the repeating templates and future payments add, the entries
// and changes kept here, the arithmetic of the days and tiles, what actually
// moved in the last thirty days, and what it costs in Xero calls. Xero is
// mocked, as everywhere in this suite; nothing here reaches it.
jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getInvoices:            jest.fn(),
    getCreditNotes:         jest.fn(),
    getReportBankSummary:   jest.fn(),
    getAccounts:            jest.fn(),
    getRepeatingInvoices:   jest.fn(),
    getPayments:            jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
    getBudgets:             jest.fn(),
    getBankTransactions:    jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

const { AccountingApi, __api: api } = require('xero-node');
require('../db/migrate').run();
const reports = require('./reports');
const {
  _buildCashManager, _repeatingDates, _repeatingDue, _templatesOf, _paymentsOf, _bankTransactionsOf, _manualDates, _todayBalanceWindow,
  HORIZON_DAYS, ACTUAL_DAYS, REPEATING_TTL_MS,
} = require('./cash-manager');
const { _outstandingOf, _latenessOf, LATENESS_MAX_DAYS } = require('./summary');
const { _creditsOf } = require('./ageing');

const TODAY = '2026-10-12';
const day = (n, from = TODAY) => {
  const [y, m, d] = from.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const HORIZON_END = day(90);   // 2027-01-10

let seq = 0;
// A Xero invoice as the summary's summaryOnly fetch returns it.
function inv(over = {}) {
  seq++;
  return {
    invoiceID: `i${seq}`, type: 'ACCREC', status: 'AUTHORISED',
    invoiceNumber: `INV-${String(seq).padStart(4, '0')}`, reference: '',
    contact: { contactID: 'c1', name: 'Acme' },
    date: `${day(-20)}T00:00:00`, dueDate: `${day(5)}T00:00:00`,
    total: 100, amountDue: 100, currencyCode: 'SGD',
    ...over,
  };
}
// A paid invoice, due `dueIn` days from today and fully paid `late` days after.
const paid = (dueIn, late, over = {}) => inv({
  status: 'PAID', amountDue: 0, dueDate: `${day(dueIn)}T00:00:00`, fullyPaidOnDate: `${day(dueIn + late)}T00:00:00`, ...over,
});
function credit(over = {}) {
  seq++;
  return {
    creditNoteID: `cn${seq}`, type: 'ACCRECCREDIT', status: 'AUTHORISED', creditNoteNumber: `CN-${seq}`,
    contact: { contactID: 'c1', name: 'Acme' }, date: `${day(-5)}T00:00:00`, remainingCredit: 30, currencyCode: 'SGD',
    ...over,
  };
}

const BANK = { accounts: [{ name: 'Operating', closingBalance: 1000, cashReceived: 0, cashSpent: 0, openingBalance: 1000 }] };
const LIST = [{ accountId: 'a-op', name: 'Operating', currency: 'SGD' }];

// Through summary.js and ageing.js exactly as the fetched path goes.
const build = ({ invoices = [], paidHistory = [], credits = [], ...opts } = {}) => _buildCashManager({
  todayISO: TODAY, timezone: 'UTC', organisation: { name: 'Org' }, baseCurrency: 'SGD',
  outstanding: _outstandingOf(invoices), lateness: _latenessOf(paidHistory, TODAY),
  credits: credits === null ? null : _creditsOf(credits),
  bank: BANK, bankAccounts: LIST, templates: [], payments: [], bankTransactions: [],
  ...opts,
});
const item = (cm, key) => cm.items.find(i => i.key === key);
const onDay = (cm, iso) => cm.series.find(d => d.date === iso);

// ── How an item is dated ────────────────────────────────────────────────────

describe('the date basis, first match wins', () => {
  const history = [paid(-60, 10), paid(-40, 10)];   // Acme pays ten days late

  test('a date set here beats Xero\'s expected payment date', () => {
    const i = inv({ expectedPaymentDate: `${day(10)}T00:00:00` });
    const cm = build({ invoices: [i], paidHistory: history, overrides: { [`invoice:${i.invoiceID}`]: { date: day(20) } } });
    expect(item(cm, `invoice:${i.invoiceID}`)).toMatchObject({ date: day(20), dateBasis: 'override', originalDate: day(10), overridden: true });
  });

  test('a sales invoice\'s expected payment date beats the payment history and the due date', () => {
    const i = inv({ expectedPaymentDate: `/Date(${Date.UTC(2026, 9, 18)}+0000)/` });
    const cm = build({ invoices: [i], paidHistory: history });
    expect(item(cm, `invoice:${i.invoiceID}`)).toMatchObject({ date: '2026-10-18', dateBasis: 'expected', dueDate: day(5) });
  });

  test('a bill\'s planned payment date is its own; an expected date on a bill is not read', () => {
    const planned = inv({ type: 'ACCPAY', plannedPaymentDate: `${day(12)}T00:00:00` });
    const stray   = inv({ type: 'ACCPAY', expectedPaymentDate: `${day(12)}T00:00:00` });
    const cm = build({ invoices: [planned, stray] });
    expect(item(cm, `invoice:${planned.invoiceID}`)).toMatchObject({ date: day(12), dateBasis: 'planned', direction: 'out', source: 'bill' });
    expect(item(cm, `invoice:${stray.invoiceID}`)).toMatchObject({ date: day(5), dateBasis: 'due' });
  });

  test('with no date given, the due date moves by how late the contact pays', () => {
    const i = inv();
    const cm = build({ invoices: [i], paidHistory: history });
    expect(item(cm, `invoice:${i.invoiceID}`)).toMatchObject({ date: day(15), dateBasis: 'predicted', daysLate: 10, dueDate: day(5) });
  });

  test('with no history either, the due date', () => {
    const i = inv();
    const cm = build({ invoices: [i] });
    expect(item(cm, `invoice:${i.invoiceID}`)).toMatchObject({ date: day(5), dateBasis: 'due', daysLate: null });
  });

  test('how a contact pays our bills says nothing about how they pay our invoices', () => {
    const bill = inv({ type: 'ACCPAY' });
    const cm = build({ invoices: [bill], paidHistory: history });   // the history is of sales invoices
    expect(item(cm, `invoice:${bill.invoiceID}`).dateBasis).toBe('due');
  });

  test('the note says when no open invoice carried an expected or planned date, and not otherwise', () => {
    expect(build({ invoices: [inv()] }).notes.join(' ')).toMatch(/No open invoice or bill carried an expected or planned payment date/);
    expect(build({ invoices: [inv({ expectedPaymentDate: day(9) })] }).notes.join(' ')).not.toMatch(/No open invoice/);
    expect(build({ invoices: [] }).notes.join(' ')).not.toMatch(/No open invoice/);
  });
});

describe('lateness, from the summary\'s paid invoices', () => {
  const late = list => _latenessOf(list, TODAY);

  test('needs at least two paid invoices for the contact', () => {
    expect(late([paid(-30, 10)])).toEqual({});
    expect(late([paid(-30, 10), paid(-60, 20)])).toEqual({ 'ACCREC:c1': { days: 15, count: 2, average: 15 } });
  });

  test('the average is rounded to whole days', () => {
    expect(late([paid(-30, 3), paid(-60, 4)])['ACCREC:c1']).toMatchObject({ days: 4, average: 3.5 });
  });

  test('held between 0 and 60 days', () => {
    expect(late([paid(-30, -5), paid(-60, -3)])['ACCREC:c1'].days).toBe(0);
    expect(late([paid(-200, 90), paid(-150, 100)])['ACCREC:c1'].days).toBe(LATENESS_MAX_DAYS);
  });

  test('over invoices paid in the last year only, PAID ones only, per side and per contact', () => {
    const map = late([
      paid(-500, 30), paid(-450, 30),                                   // paid over a year ago
      paid(-30, 5), inv({ fullyPaidOnDate: day(-1), dueDate: day(-6) }), // one paid + one still AUTHORISED
      paid(-30, 8, { type: 'ACCPAY' }), paid(-60, 8, { type: 'ACCPAY' }),
      paid(-30, 2, { contact: { contactID: 'c2', name: 'Beta' } }), paid(-60, 2, { contact: { contactID: 'c2', name: 'Beta' } }),
    ]);
    expect(map).toEqual({
      'ACCPAY:c1': { days: 8, count: 2, average: 8 },
      'ACCREC:c2': { days: 2, count: 2, average: 2 },
    });
  });

  test('Xero\'s dates are read as calendar days in whichever form they come', () => {
    const map = late([
      paid(-30, 0, { dueDate: new Date(Date.UTC(2026, 8, 1)), fullyPaidOnDate: new Date(Date.UTC(2026, 8, 11)) }),
      paid(-30, 0, { dueDate: '/Date(1788220800000+0000)/', fullyPaidOnDate: '2026-09-11T00:00:00' }),   // 1 Sep
    ]);
    expect(map['ACCREC:c1']).toMatchObject({ days: 10, count: 2 });
  });
});

// ── Overdue ─────────────────────────────────────────────────────────────────

describe('overdue', () => {
  test('an item dated before today is overdue: listed and totalled, on no day', () => {
    const late = inv({ dueDate: `${day(-3)}T00:00:00`, amountDue: 70 });
    const bill = inv({ type: 'ACCPAY', dueDate: `${day(-1)}T00:00:00`, amountDue: 20 });
    const now  = inv({ dueDate: `${TODAY}T00:00:00`, amountDue: 5 });
    const cm = build({ invoices: [late, bill, now] });
    expect(item(cm, `invoice:${late.invoiceID}`).overdue).toBe(true);
    expect(item(cm, `invoice:${now.invoiceID}`).overdue).toBe(false);
    expect(cm.tiles.overdue).toEqual({ in: 70, out: 20, net: 50 });
    expect(cm.tiles.today).toEqual({ in: 5, out: 0, net: 5 });
    expect(cm.series.reduce((s, d) => s + d.in - d.out, 0)).toBe(5);
    expect(cm.series[90].balance).toBe(1005);
  });

  test('a date set here takes an overdue item off the overdue list and onto its day', () => {
    const late = inv({ dueDate: `${day(-3)}T00:00:00` });
    const cm = build({ invoices: [late], overrides: { [`invoice:${late.invoiceID}`]: { date: day(2) } } });
    expect(item(cm, `invoice:${late.invoiceID}`)).toMatchObject({ overdue: false, dateBasis: 'override' });
    expect(cm.tiles.overdue).toEqual({ in: 0, out: 0, net: 0 });
    expect(onDay(cm, day(2)).in).toBe(100);
  });

  test('an invoice with neither a due date nor an invoice date is undated and overdue: on no day, never on today', () => {
    const none = inv({ dueDate: null, date: null, amountDue: 40 });
    const bill = inv({ type: 'ACCPAY', dueDate: undefined, date: undefined, amountDue: 15, contact: { contactID: 's1', name: 'Supplier' } });
    const dated = inv({ dueDate: null, date: `${day(3)}T00:00:00`, amountDue: 9 });   // no due date: its own date
    const cm = build({ invoices: [none, bill, dated], credits: [credit({ remainingCredit: 10 })] });
    expect(item(cm, `invoice:${none.invoiceID}`)).toMatchObject({
      date: null, dueDate: null, originalDate: null, dateBasis: 'none', overdue: true, beyondHorizon: false,
    });
    expect(item(cm, `invoice:${bill.invoiceID}`)).toMatchObject({ date: null, dateBasis: 'none', overdue: true });
    expect(item(cm, `invoice:${dated.invoiceID}`)).toMatchObject({ date: day(3), dateBasis: 'due', overdue: false });
    // The credit goes against the undated invoice first: it is the oldest.
    expect(item(cm, `invoice:${none.invoiceID}`)).toMatchObject({ amount: 30, creditApplied: 10 });
    expect(cm.tiles.overdue).toEqual({ in: 30, out: 15, net: 15 });
    expect(cm.tiles.today).toEqual({ in: 0, out: 0, net: 0 });
    expect(onDay(cm, TODAY)).toMatchObject({ in: 0, out: 0 });
    expect(onDay(cm, day(3)).in).toBe(9);
    // Listed first, before anything dated.
    expect(cm.items.slice(0, 2).map(i => i.date)).toEqual([null, null]);
    expect(cm.notes.join(' ')).toMatch(/2 invoices and bills carry neither a due date nor an invoice date in Xero, so they are counted as overdue and placed on no day until a date is set here/);
    expect(cm.open).toEqual({ receivables: { amount: 49, count: 2 }, payables: { amount: 15, count: 1 } });
  });

  test('a date set here places an undated invoice, and then it is no longer counted as undated', () => {
    const none = inv({ dueDate: null, date: null });
    const cm = build({ invoices: [none], overrides: { [`invoice:${none.invoiceID}`]: { date: day(6) } } });
    expect(item(cm, `invoice:${none.invoiceID}`)).toMatchObject({ date: day(6), dateBasis: 'override', originalDate: null, overdue: false });
    expect(onDay(cm, day(6)).in).toBe(100);
    expect(cm.notes.join(' ')).not.toMatch(/neither a due date/);
  });

  test('history can push a not-yet-due invoice past today, and one already late further, never earlier', () => {
    const history = [paid(-60, 10), paid(-40, 10)];
    const late = inv({ dueDate: `${day(-30)}T00:00:00` });
    const cm = build({ invoices: [late], paidHistory: history });
    expect(item(cm, `invoice:${late.invoiceID}`)).toMatchObject({ date: day(-20), overdue: true, dateBasis: 'predicted' });
  });
});

// ── Credit notes ────────────────────────────────────────────────────────────

describe('unallocated credit notes', () => {
  test('netted against the same contact\'s earliest items, never placed on a day alone', () => {
    const a = inv({ dueDate: `${day(2)}T00:00:00` });
    const b = inv({ dueDate: `${day(10)}T00:00:00` });
    const cm = build({ invoices: [b, a], credits: [credit({ remainingCredit: 150 })] });
    expect(item(cm, `invoice:${a.invoiceID}`)).toMatchObject({ amount: 0, originalAmount: 100, creditApplied: 100 });
    expect(item(cm, `invoice:${b.invoiceID}`)).toMatchObject({ amount: 50, creditApplied: 50 });
    expect(cm.series.reduce((s, d) => s + d.in, 0)).toBe(50);
    expect(cm.items).toHaveLength(2);
    expect(cm.notes.join(' ')).toMatch(/1 unallocated credit note is netted .* 150\.00 in all/);
  });

  test('another contact\'s credit, or a supplier credit, does not touch these invoices', () => {
    const a = inv();
    const bill = inv({ type: 'ACCPAY' });
    const cm = build({ invoices: [a, bill], credits: [
      credit({ contact: { contactID: 'c9', name: 'Other' } }),
      credit({ type: 'ACCPAYCREDIT', remainingCredit: 40 }),
    ] });
    expect(item(cm, `invoice:${a.invoiceID}`).amount).toBe(100);
    expect(item(cm, `invoice:${bill.invoiceID}`)).toMatchObject({ amount: 60, creditApplied: 40 });
  });

  test('credit left once the contact\'s items are used up is said and counts nowhere', () => {
    const a = inv({ amountDue: 20 });
    const cm = build({ invoices: [a], credits: [credit({ remainingCredit: 50 })] });
    expect(item(cm, `invoice:${a.invoiceID}`).amount).toBe(0);
    expect(cm.series.every(d => d.in === 0 && d.out === 0)).toBe(true);
    expect(cm.notes.join(' ')).toMatch(/30\.00 of credit on 1 note has no open item/);
  });

  test('an excluded item, or one whose amount was set here, takes none; the next one does', () => {
    const a = inv({ dueDate: `${day(1)}T00:00:00` });
    const b = inv({ dueDate: `${day(2)}T00:00:00` });
    const c = inv({ dueDate: `${day(3)}T00:00:00` });
    const cm = build({ invoices: [a, b, c], credits: [credit({ remainingCredit: 30 })], overrides: {
      [`invoice:${a.invoiceID}`]: { excluded: true },
      [`invoice:${b.invoiceID}`]: { amountCents: 8000 },
    } });
    expect(item(cm, `invoice:${a.invoiceID}`)).toMatchObject({ amount: 100, creditApplied: 0, excluded: true });
    expect(item(cm, `invoice:${b.invoiceID}`)).toMatchObject({ amount: 80, creditApplied: 0 });
    expect(item(cm, `invoice:${c.invoiceID}`)).toMatchObject({ amount: 70, creditApplied: 30 });
  });

  test('"earliest" is by the date the item is placed on, after any date set here', () => {
    const a = inv({ dueDate: `${day(1)}T00:00:00` });
    const b = inv({ dueDate: `${day(2)}T00:00:00` });
    const cm = build({ invoices: [a, b], credits: [credit({ remainingCredit: 30 })], overrides: { [`invoice:${a.invoiceID}`]: { date: day(9) } } });
    expect(item(cm, `invoice:${b.invoiceID}`).creditApplied).toBe(30);
    expect(item(cm, `invoice:${a.invoiceID}`).creditApplied).toBe(0);
  });

  test('a credit note in another currency with no exchange rate is left out and named, never netted at face value', () => {
    const a = inv({ amountDue: 500 });
    const cm = build({ invoices: [a], credits: [
      credit({ creditNoteNumber: 'CN-USD', remainingCredit: 100, currencyCode: 'USD' }),                       // no rate
      credit({ creditNoteNumber: 'CN-EUR', remainingCredit: 60, currencyCode: 'EUR', currencyRate: 0 }),        // nor this
      credit({ creditNoteNumber: 'CN-OK', remainingCredit: 74, currencyCode: 'USD', currencyRate: 0.74 }),      // 100 SGD
    ] });
    expect(item(cm, `invoice:${a.invoiceID}`)).toMatchObject({ amount: 400, creditApplied: 100 });
    const notes = cm.notes.join(' ');
    expect(notes).toMatch(/1 unallocated credit note is netted .* 100\.00 in all/);
    expect(notes).toMatch(/2 credit notes in another currency carried no exchange rate and are not netted off: CN-EUR \(Acme, EUR\), CN-USD \(Acme, USD\)\./);
    // A base-currency note needs no rate.
    expect(build({ invoices: [a], credits: [credit({ remainingCredit: 30 })] }).notes.join(' ')).not.toMatch(/no exchange rate/);
  });

  test('credit notes that could not be read net nothing, and say so', () => {
    const a = inv();
    const cm = build({ invoices: [a], credits: null });
    expect(item(cm, `invoice:${a.invoiceID}`).amount).toBe(100);
    expect(cm.notes.join(' ')).toMatch(/Credit notes could not be read/);
  });

  test('overpayments and prepayments are said plainly not to be used', () => {
    expect(build().notes.join(' ')).toMatch(/overpayments and prepayments are not used: that money is already in the bank/);
  });
});

// ── Repeating templates ─────────────────────────────────────────────────────

describe('repeating invoices', () => {
  const sched = over => ({ period: 1, unit: 'MONTHLY', dueDate: 0, dueDateType: 'DAYSAFTERBILLDATE', startDate: null, nextScheduledDate: null, endDate: null, ...over });

  test('weekly: from the next scheduled date, every period × 7 days, up to the horizon', () => {
    expect(_repeatingDates(sched({ unit: 'WEEKLY', period: 2, nextScheduledDate: '2026-10-15' }), '2026-11-20'))
      .toEqual(['2026-10-15', '2026-10-29', '2026-11-12']);
  });

  test('monthly keeps the day it started on, held to each month\'s length', () => {
    expect(_repeatingDates(sched({ startDate: '2026-01-31', nextScheduledDate: '2026-10-31' }), '2027-03-31'))
      .toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31']);
  });

  test('every three months, and the template\'s end date stops it', () => {
    expect(_repeatingDates(sched({ period: 3, startDate: '2026-04-15', nextScheduledDate: '2026-10-15' }), '2027-12-31'))
      .toEqual(['2026-10-15', '2027-01-15', '2027-04-15', '2027-07-15', '2027-10-15']);
    expect(_repeatingDates(sched({ startDate: '2026-01-31', nextScheduledDate: '2026-10-31', endDate: '2026-12-15' }), '2027-03-31'))
      .toEqual(['2026-10-31', '2026-11-30']);
    expect(_repeatingDates(sched({ nextScheduledDate: '2026-10-31', endDate: '2026-10-01' }), '2027-03-31')).toEqual([]);
  });

  test.each([
    ['DAYSAFTERBILLDATE',     14, '2026-10-31', '2026-11-14'],
    ['DAYSAFTERINVOICEDATE',   0, '2026-10-31', '2026-10-31'],
    ['DAYSAFTERBILLMONTH',    10, '2026-10-05', '2026-11-10'],
    ['DAYSAFTERINVOICEMONTH', 20, '2026-02-10', '2026-03-20'],   // 28 Feb + 20
    ['OFCURRENTMONTH',        31, '2026-11-05', '2026-11-30'],   // held to 30 days
    ['OFCURRENTMONTH',        20, '2026-11-05', '2026-11-20'],
    ['OFFOLLOWINGMONTH',      31, '2027-01-15', '2027-02-28'],   // held to February
    ['OFFOLLOWINGMONTH',      20, '2026-12-03', '2027-01-20'],   // into the next year
  ])('%s %i: raised %s, due %s', (dueDateType, n, raised, due) => {
    expect(_repeatingDue(raised, { dueDateType, dueDate: n })).toBe(due);
  });

  test('approved templates only, with every date read as a calendar day', () => {
    const t = _templatesOf([
      { repeatingInvoiceID: 'r1', type: 'ACCREC', status: 'AUTHORISED', total: 500, currencyCode: 'SGD', contact: { contactID: 'c1', name: 'Acme' },
        schedule: { period: 1, unit: 'MONTHLY', dueDate: 7, dueDateType: 'DAYSAFTERINVOICEDATE', startDate: '/Date(1767225600000+0000)/', nextScheduledDate: new Date(Date.UTC(2026, 10, 1)) } },
      { repeatingInvoiceID: 'r2', type: 'ACCREC', status: 'DRAFT', total: 9, schedule: {} },
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].schedule).toMatchObject({ startDate: '2026-01-01', nextScheduledDate: '2026-11-01', unit: 'MONTHLY', dueDate: 7 });
  });

  const tpl = over => ({
    repeatingInvoiceId: 'r1', type: 'ACCREC', contactId: 'c1', contactName: 'Acme', reference: 'Retainer', total: 500, currencyCode: 'SGD',
    schedule: sched({ startDate: '2026-01-25', nextScheduledDate: '2026-10-25', dueDate: 7, dueDateType: 'DAYSAFTERINVOICEDATE' }),
    ...over,
  });

  test('each occurrence is an item on its due date, keyed by the date it is raised', () => {
    const cm = build({ templates: [tpl(), tpl({ repeatingInvoiceId: 'r2', type: 'ACCPAY', total: 200, schedule: sched({ unit: 'WEEKLY', nextScheduledDate: day(1), dueDate: 0 }) })] });
    const monthly = cm.items.filter(i => i.key.startsWith('repeating:r1:'));
    // Raised 25 Oct, 25 Nov, 25 Dec (25 Jan is past the horizon), each due 7 days on.
    expect(monthly.map(i => [i.key, i.date, i.dateBasis, i.amount, i.direction])).toEqual([
      ['repeating:r1:2026-10-25', '2026-11-01', 'scheduled', 500, 'in'],
      ['repeating:r1:2026-11-25', '2026-12-02', 'scheduled', 500, 'in'],
      ['repeating:r1:2026-12-25', '2027-01-01', 'scheduled', 500, 'in'],
    ]);
    const weekly = cm.items.filter(i => i.key.startsWith('repeating:r2:'));
    expect(weekly).toHaveLength(13);   // day 1, 8, … 85
    expect(weekly.every(i => i.direction === 'out' && i.source === 'repeating')).toBe(true);
  });

  test('a template in another currency is named in the notes and left out', () => {
    const cm = build({ templates: [tpl({ currencyCode: 'USD', contactName: 'Yankee Co' })] });
    expect(cm.items).toEqual([]);
    expect(cm.notes.join(' ')).toMatch(/Repeating Yankee Co \(USD\) is left out: a template in another currency has no exchange rate/);
  });

  test('templates that could not be read say why, and the rest stands', () => {
    const a = inv();
    const scope = build({ invoices: [a], templates: null, repeatingFailure: 'scope' });
    expect(scope.notes.join(' ')).toMatch(/Repeating invoices could not be read: the Xero connection does not allow it/);
    expect(item(scope, `invoice:${a.invoiceID}`).amount).toBe(100);
    expect(build({ templates: null, repeatingFailure: 'error' }).notes.join(' ')).toMatch(/could not be read from Xero just now/);
  });
});

// ── Payments dated after today ──────────────────────────────────────────────

describe('future-dated payments', () => {
  const pay = over => ({
    paymentID: `p${++seq}`, paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: `${day(3)}T00:00:00`, amount: 250,
    invoice: { invoiceNumber: 'INV-9', contact: { name: 'Acme' } }, account: { accountID: 'a-op' }, reference: 'Scheduled',
    ...over,
  });

  test('receipts in and payments out on their own date; a refund to a customer goes out; deleted ones are not there', () => {
    const list = [
      pay({ paymentID: 'p-in' }),
      pay({ paymentID: 'p-out', paymentType: 'ACCPAYPAYMENT', amount: 80, date: `${day(4)}T00:00:00` }),
      pay({ paymentID: 'p-refund', paymentType: 'ARCREDITPAYMENT', amount: 10, date: `${day(4)}T00:00:00` }),
      pay({ paymentID: 'p-gone', status: 'DELETED' }),
    ];
    const cm = build({ payments: _paymentsOf(list) });
    expect(item(cm, 'payment:p-in')).toMatchObject({ direction: 'in', date: day(3), dateBasis: 'payment', amount: 250, source: 'payment', contactName: 'Acme', number: 'INV-9' });
    expect(item(cm, 'payment:p-out')).toMatchObject({ direction: 'out', amount: 80 });
    expect(item(cm, 'payment:p-refund')).toMatchObject({ direction: 'out', amount: 10 });
    expect(item(cm, 'payment:p-gone')).toBeUndefined();
    expect(onDay(cm, day(4))).toMatchObject({ in: 0, out: 90 });
  });

  test('converted at the rate on the payment, and left out with an account the balance leaves out', () => {
    const list = [
      pay({ paymentID: 'p-usd', amount: 74, currencyRate: 0.74, invoice: { invoiceNumber: 'X', currencyCode: 'USD', contact: { name: 'Y' } } }),
      pay({ paymentID: 'p-off', account: { accountID: 'a-off' } }),
    ];
    const cm = build({
      payments: _paymentsOf(list),
      bank: { accounts: [...BANK.accounts, { name: 'Savings', closingBalance: 50 }] },
      bankAccounts: [...LIST, { accountId: 'a-off', name: 'Savings', currency: 'SGD' }],
      bankOptions: { 'a-off': { included: false } },
    });
    expect(item(cm, 'payment:p-usd')).toMatchObject({ amount: 100, currency: 'USD', faceAmount: 74 });
    expect(item(cm, 'payment:p-off')).toBeUndefined();
    expect(cm.notes.join(' ')).toMatch(/1 future payment goes through a bank account left out of the balance/);
  });
});

// ── Spend and Receive Money dated after today ───────────────────────────────

describe('Spend and Receive Money dated after today', () => {
  const list = [...LIST, { accountId: 'a-op2', name: 'Payroll', currency: 'SGD' },
    { accountId: 'a-sav', name: 'Savings', currency: 'SGD' }, { accountId: 'a-usd', name: 'USD Account', currency: 'USD' }];
  const bank = { accounts: [
    { name: 'Operating', closingBalance: 1000 }, { name: 'Payroll', closingBalance: 0 },
    { name: 'Savings', closingBalance: 0 }, { name: 'USD Account', closingBalance: 0 },
  ] };
  const btx = (id, n, type, total, over = {}) => ({
    bankTransactionID: id, type, status: 'AUTHORISED', date: new Date(`${day(n)}T00:00:00Z`), total,
    bankAccount: { accountID: 'a-op' }, contact: { name: 'Landlord' }, reference: `ref ${id}`,
    lineAmountTypes: 'Inclusive', lineItems: [{ accountCode: '400', lineAmount: total }], ...over,
  });
  const ahead = (records, over = {}) => build({
    bank, bankAccounts: list, bankOptions: { 'a-sav': { included: false } },
    bankTransactions: _bankTransactionsOf(records), ...over,
  });

  test('each is an item on its own date, in base currency, with its accounts; today\'s and earlier ones are in the balance already', () => {
    const cm = ahead([
      btx('rent', 5, 'SPEND', 1200),
      btx('grant', 9, 'RECEIVE', 500, { contact: { name: 'Agency' }, lineItems: [{ accountCode: '260', lineAmount: 500 }] }),
      btx('usd', 10, 'SPEND', 74, { currencyCode: 'USD', currencyRate: 0.74, lineItems: [{ accountCode: '400', lineAmount: 74 }] }),
      btx('today', 0, 'SPEND', 99), btx('past', -2, 'SPEND', 88), btx('gone', 6, 'SPEND', 77, { status: 'DELETED' }),
    ]);
    expect(item(cm, 'banktx:rent')).toEqual({
      key: 'banktx:rent', direction: 'out', source: 'banktx', date: day(5), dueDate: null, dateBasis: 'banktx',
      amount: 1200, originalAmount: 1200, currency: 'SGD', contactName: 'Landlord', number: '', reference: 'ref rent',
      overdue: false, excluded: false, overridden: false, entryId: null, originalDate: day(5), faceAmount: 1200, foreign: false,
      creditApplied: 0, daysLate: null, invoiceDate: null, description: null, beyondHorizon: false,
      accounts: [{ code: '400', amount: 1200 }], transfer: false,
    });
    expect(item(cm, 'banktx:grant')).toMatchObject({ direction: 'in', amount: 500, contactName: 'Agency', accounts: [{ code: '260', amount: 500 }] });
    expect(item(cm, 'banktx:usd')).toMatchObject({ amount: 100, currency: 'USD', faceAmount: 74, foreign: true, accounts: [{ code: '400', amount: 100 }] });
    for (const id of ['today', 'past', 'gone']) expect(item(cm, `banktx:${id}`)).toBeUndefined();
    expect(onDay(cm, day(5)).out).toBe(1200);
    expect(onDay(cm, day(9)).in).toBe(500);
    expect(cm.notes.join(' ')).toMatch(/3 Spend and Receive Money transactions recorded in Xero with a date after today are on that date\./);
    // Only the items carry accounts.
    expect(build({ invoices: [inv()] }).items[0]).not.toHaveProperty('accounts');
  });

  test('accounts: each line\'s cash with its tax, put together by code, split to add up to the amount to the cent', () => {
    const cm = ahead([
      btx('mixed', 3, 'SPEND', 109, { lineAmountTypes: 'Exclusive', lineItems: [
        { accountCode: '400', lineAmount: 50, taxAmount: 4.5 }, { accountCode: '420', lineAmount: 40, taxAmount: 3.6 },
        { accountCode: '400', lineAmount: 10, taxAmount: 0.9 },
      ] }),
      btx('thirds', 4, 'SPEND', 100, { lineItems: [1, 2, 3].map(k => ({ accountCode: `40${k}`, lineAmount: 33.33 + (k === 3 ? 0.01 : 0) })) }),
      btx('discount', 5, 'SPEND', 90, { lineItems: [{ accountCode: '400', lineAmount: 100 }, { accountCode: '410', lineAmount: -10 }] }),
      btx('bare', 6, 'SPEND', 40, { lineItems: [] }),
      btx('nolines', 7, 'SPEND', 40, { lineItems: undefined }),
    ]);
    expect(item(cm, 'banktx:mixed').accounts).toEqual([{ code: '400', amount: 65.4 }, { code: '420', amount: 43.6 }]);
    expect(item(cm, 'banktx:thirds').accounts).toEqual([{ code: '401', amount: 33.33 }, { code: '402', amount: 33.33 }, { code: '403', amount: 33.34 }]);
    // A code that comes to less than nothing takes no share; the rest still adds up.
    expect(item(cm, 'banktx:discount').accounts).toEqual([{ code: '400', amount: 90 }]);
    expect(item(cm, 'banktx:bare').accounts).toEqual([]);
    expect(item(cm, 'banktx:nolines').accounts).toEqual([]);
    for (const it of cm.items.filter(i => i.accounts.length)) {
      expect(Math.round(it.accounts.reduce((s, a) => s + a.amount * 100, 0))).toBe(Math.round(it.amount * 100));
      expect(it.accounts.every(a => a.amount > 0)).toBe(true);
    }
  });

  test('an amount set here is split across the same accounts, so they still add up to it; a date set here moves it', () => {
    const cm = ahead([btx('split', 3, 'SPEND', 300, { lineItems: [{ accountCode: '400', lineAmount: 200 }, { accountCode: '420', lineAmount: 100 }] })], {
      overrides: { 'banktx:split': { amountCents: 10000, date: day(8) } },
    });
    expect(item(cm, 'banktx:split')).toMatchObject({
      amount: 100, originalAmount: 300, date: day(8), dateBasis: 'override', accounts: [{ code: '400', amount: 66.67 }, { code: '420', amount: 33.33 }],
    });
  });

  test('left out with an account the balance leaves out, and said', () => {
    const cm = ahead([
      btx('sav', 3, 'SPEND', 20, { bankAccount: { accountID: 'a-sav' } }),
      btx('usd', 3, 'RECEIVE', 20, { bankAccount: { accountID: 'a-usd' } }),
      btx('op', 3, 'SPEND', 20),
    ]);
    expect(cm.items.map(i => i.key)).toEqual(['banktx:op']);
    expect(cm.notes.join(' ')).toMatch(/2 Spend and Receive Money transactions dated after today go through a bank account left out of the balance, so they are left out too/);
  });

  test('a transfer between two counted accounts is left out, both halves; one with an account left out moves the balance counted and is projected', () => {
    const cm = ahead([
      // Operating to Payroll, both counted: no money in or out.
      btx('t-out', 4, 'SPEND-TRANSFER', 800, { lineItems: [] }),
      btx('t-in', 4, 'RECEIVE-TRANSFER', 800, { bankAccount: { accountID: 'a-op2' }, lineItems: [] }),
      // Operating to Savings, switched off here: the Savings half goes with
      // its account, and Operating's 300 out is real.
      btx('s-out', 6, 'SPEND-TRANSFER', 300, { lineItems: [] }),
      btx('s-in', 6, 'RECEIVE-TRANSFER', 300, { bankAccount: { accountID: 'a-sav' }, lineItems: [] }),
      // A spend of the same amount on the same day as a transfer is not taken for its other half.
      btx('lookalike', 4, 'RECEIVE', 800, { bankAccount: { accountID: 'a-op2' } }),
    ]);
    expect(cm.items.map(i => i.key).sort()).toEqual(['banktx:lookalike', 'banktx:s-out']);
    expect(item(cm, 'banktx:s-out')).toMatchObject({ direction: 'out', amount: 300, transfer: true, accounts: [] });
    expect(onDay(cm, day(4))).toMatchObject({ in: 800, out: 0 });
    expect(cm.series[90].balance).toBe(1000 + 800 - 300);
    const notes = cm.notes.join(' ');
    expect(notes).toMatch(/1 transfer dated after today between two bank accounts counted in the balance is left out: it moves no money in or out/);
    expect(notes).toMatch(/One is a transfer with no matching transfer into or out of another account counted in the balance/);
    expect(notes).toMatch(/1 Spend or Receive Money transaction dated after today goes through a bank account left out/);
  });

  test('bank transactions that could not be read say so for the days ahead too', () => {
    expect(build({ bankTransactions: null, bankTransactionsFailure: 'error' }).notes.join(' '))
      .toMatch(/Spend and Receive Money dated after today could not be read from Xero just now, so none is included/);
    expect(build({ bankTransactions: null, bankTransactionsFailure: 'scope' }).notes.join(' '))
      .toMatch(/Spend and Receive Money dated after today could not be read: the Xero connection does not allow it/);
  });

  test('the actuals still take the same read\'s past records, and none of the ones ahead', () => {
    const cm = ahead([btx('past', -2, 'SPEND', 88), btx('rent', 5, 'SPEND', 1200)]);
    expect(cm.actualItems.map(i => i.key)).toEqual(['actual:banktransaction:past']);
    expect(cm.items.map(i => i.key)).toEqual(['banktx:rent']);
  });
});

// ── What actually moved ─────────────────────────────────────────────────────

describe('the last thirty days, as they happened', () => {
  // Operating counts in the balance (60,000 today); Savings is switched off here.
  const bank = { accounts: [
    { name: 'Operating', closingBalance: 60000, cashReceived: 57139, cashSpent: 1420, openingBalance: 0 },
    { name: 'Savings',   closingBalance: 5000,  cashReceived: 1050,  cashSpent: 0,    openingBalance: 0 },
  ] };
  const list = [...LIST, { accountId: 'a-sav', name: 'Savings', currency: 'SGD' }];
  const pay = (id, n, amount, over = {}) => ({
    paymentID: id, paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: `${day(n)}T00:00:00`, amount,
    account: { accountID: 'a-op' }, invoice: { invoiceNumber: `INV-${id}`, contact: { name: 'Acme' } }, ...over,
  });
  const btx = (id, n, type, total, account = 'a-op', over = {}) => ({
    bankTransactionID: id, type, status: 'AUTHORISED', date: new Date(`${day(n)}T00:00:00Z`), total,
    bankAccount: { accountID: account }, contact: { name: 'Shop' }, reference: `ref ${id}`, isReconciled: false, ...over,
  });
  const PAYMENTS = [
    pay('p1', -5, 57000),                                             // the receipt Xero draws left of today
    pay('p2', -5, 300, { paymentType: 'ACCPAYPAYMENT' }),
    pay('p3', 0, 40),                                                 // today: in today's balance
    pay('p4', 3, 250),                                                // ahead: projected
    pay('p5', -31, 99),                                               // the Bank Summary window's first day
  ];
  const BANK_TX = [
    btx('t1', -2, 'SPEND', 120),
    btx('t2', -3, 'SPEND-TRANSFER', 1000),                            // to Savings: no cash out, but the balance moves
    btx('t3', -3, 'RECEIVE-TRANSFER', 1000, 'a-sav'),                 // into an account switched off here
    btx('t4', -1, 'RECEIVE', 50, 'a-sav'),
    btx('t5', -4, 'SPEND', 777, 'a-op', { status: 'DELETED' }),
    btx('t6', -6, 'SPEND', 64, 'a-op', { status: 'VOIDED' }),
  ];
  const past = (over = {}) => build({
    bank, bankAccounts: list, bankOptions: { 'a-sav': { included: false } },
    payments: _paymentsOf(PAYMENTS), bankTransactions: _bankTransactionsOf(BANK_TX), ...over,
  });

  test('thirty days before today, oldest first, from past payments and bank transactions; transfers, deleted ones and excluded accounts left out', () => {
    const cm = past();
    expect(ACTUAL_DAYS).toBe(30);
    expect(cm.actualsAvailable).toBe(true);
    expect(cm.actuals).toHaveLength(30);
    expect(cm.actuals[0].date).toBe(day(-30));
    expect(cm.actuals[29].date).toBe(day(-1));
    const on = n => cm.actuals.find(d => d.date === day(n));
    expect(on(-5)).toMatchObject({ in: 57000, out: 300, net: 56700 });
    expect(on(-3)).toMatchObject({ in: 0, out: 0, net: 0 });       // the transfer is no bar
    expect(on(-2)).toMatchObject({ in: 0, out: 120, net: -120 });
    expect(on(-1)).toMatchObject({ in: 0, out: 0 });               // Savings is switched off
    expect(cm.actualItems).toEqual([
      { key: 'actual:payment:p1', direction: 'in', date: day(-5), amount: 57000, source: 'payment', contactName: 'Acme', number: 'INV-p1', reference: '' },
      { key: 'actual:payment:p2', direction: 'out', date: day(-5), amount: 300, source: 'payment', contactName: 'Acme', number: 'INV-p2', reference: '' },
      { key: 'actual:banktransaction:t1', direction: 'out', date: day(-2), amount: 120, source: 'banktransaction', contactName: 'Shop', number: '', reference: 'ref t1' },
    ]);
    // The same read's payment ahead is projected; today's and the past ones are not.
    expect(cm.items.filter(i => i.source === 'payment').map(i => i.key)).toEqual(['payment:p4']);
    expect(onDay(cm, day(3)).in).toBe(250);
    expect(cm.tiles.today).toEqual({ in: 0, out: 0, net: 0 });
  });

  test('the balance is worked back from today\'s: less today\'s, then less each later day\'s, the transfer out included', () => {
    const cm = past();
    const bal = n => cm.actuals.find(d => d.date === day(n)).balance;
    expect(cm.bank.balance).toBe(60000);
    expect(bal(-1)).toBe(59960);    // 60,000 less the 40 received today
    expect(bal(-2)).toBe(59960);
    expect(bal(-3)).toBe(60080);    // before the 120 spent on day −2
    expect(bal(-4)).toBe(61080);    // before the 1,000 moved to Savings
    expect(bal(-5)).toBe(61080);
    expect(bal(-6)).toBe(4380);     // before the 57,000 in and 300 out
    expect(bal(-30)).toBe(4380);
    expect(build({ bank: null, payments: [], bankTransactions: [] }).actuals.every(d => d.balance === null)).toBe(true);
  });

  test('either read failing leaves no actuals, says so, and the projection stands', () => {
    for (const over of [{ payments: null, paymentsFailure: 'error' }, { bankTransactions: null, bankTransactionsFailure: 'error' }]) {
      const cm = past(over);
      expect(cm).toMatchObject({ actualsAvailable: false, actuals: [], actualItems: [], actualsCheck: null });
      expect(cm.notes.join(' ')).toMatch(/Past cash could not be read from Xero just now, so the last 30 days are not shown/);
      expect(cm.series).toHaveLength(91);
    }
    expect(past({ bankTransactions: null, bankTransactionsFailure: 'scope' }).notes.join(' '))
      .toMatch(/Past cash could not be read: the Xero connection does not allow/);
  });

  test('checked against the Bank Summary over its own window: agreement is silent, a difference of a cent is a note', () => {
    // Operating received 57,139 (57,000 + 40 today + 99 on day −31) and spent
    // 1,420, of which 1,000 was the transfer to Savings.
    const agrees = past();
    expect(agrees.actualsCheck).toEqual({
      from: day(-31), to: TODAY,
      records: { in: 57139, out: 420 }, bank: { in: 57139, out: 420 }, transfers: { in: 0, out: 1000 }, agrees: true,
    });
    expect(agrees.notes.join(' ')).not.toMatch(/does not tie/);

    const off = past({ bank: { accounts: [{ ...bank.accounts[0], cashReceived: 57139.01 }, bank.accounts[1]] } });
    expect(off.actualsCheck).toMatchObject({ agrees: false, bank: { in: 57139.01, out: 420 } });
    expect(off.notes.join(' ')).toMatch(new RegExp(`Past cash does not tie to Xero's Bank Summary for ${day(-31)} to ${TODAY}: `
      + 'the payments and bank transactions come to 57139\\.00 in and 420\\.00 out, the Bank Summary to 57139\\.01 in and 420\\.00 out'));
    expect(past({ bank: null }).actualsCheck).toBeNull();
  });
});

// ── Entries kept here ───────────────────────────────────────────────────────

describe('entries made here', () => {
  const e = over => ({ id: 'e1', direction: 'out', description: 'Rent', amountCents: 150000, date: TODAY, frequency: 'once', endDate: null, ...over });

  test('once: on its day; one dated before today is still expected, so overdue; past the horizon, not listed', () => {
    expect(_manualDates(e(), TODAY, HORIZON_END)).toEqual([TODAY]);
    expect(_manualDates(e({ date: day(-4) }), TODAY, HORIZON_END)).toEqual([day(-4)]);
    expect(_manualDates(e({ date: day(120) }), TODAY, HORIZON_END)).toEqual([]);
  });

  test('daily, weekly and fortnightly from their start, earlier dates taken as happened', () => {
    expect(_manualDates(e({ frequency: 'daily', date: day(-3) }), TODAY, HORIZON_END)).toHaveLength(91);
    expect(_manualDates(e({ frequency: 'weekly', date: day(-10) }), TODAY, day(30))).toEqual([day(4), day(11), day(18), day(25)]);
    expect(_manualDates(e({ frequency: 'fortnightly', date: day(2), endDate: day(40) }), TODAY, HORIZON_END)).toEqual([day(2), day(16), day(30)]);
  });

  test('monthly keeps its day of the month, and yearly its date, each held to the month', () => {
    expect(_manualDates(e({ frequency: 'monthly', date: '2026-01-31' }), TODAY, HORIZON_END)).toEqual(['2026-10-31', '2026-11-30', '2026-12-31']);
    expect(_manualDates(e({ frequency: 'yearly', date: '2024-02-29' }), TODAY, '2029-12-31')).toEqual(['2027-02-28', '2028-02-29', '2029-02-28']);
  });

  test('each occurrence is an item of its own, with the entry it came from', () => {
    const cm = build({ entries: [e({ frequency: 'monthly', date: '2026-10-20', direction: 'in', amountCents: 12345 })] });
    expect(cm.items.map(i => [i.key, i.date, i.dateBasis, i.amount, i.entryId, i.source, i.reference])).toEqual([
      ['manual:e1:2026-10-20', '2026-10-20', 'manual', 123.45, 'e1', 'manual', 'Rent'],
      ['manual:e1:2026-11-20', '2026-11-20', 'manual', 123.45, 'e1', 'manual', 'Rent'],
      ['manual:e1:2026-12-20', '2026-12-20', 'manual', 123.45, 'e1', 'manual', 'Rent'],
    ]);
  });
});

// ── Changes made here ───────────────────────────────────────────────────────

describe('overrides', () => {
  test('an amount set here replaces the amount; the original is kept beside it', () => {
    const a = inv();
    const cm = build({ invoices: [a], overrides: { [`invoice:${a.invoiceID}`]: { amountCents: 4050 } } });
    expect(item(cm, `invoice:${a.invoiceID}`)).toMatchObject({ amount: 40.5, originalAmount: 100, overridden: true, dateBasis: 'due' });
    expect(onDay(cm, day(5)).in).toBe(40.5);
  });

  test('an excluded item stays listed and counts nowhere', () => {
    const a = inv({ dueDate: `${day(-2)}T00:00:00` });
    const b = inv();
    const cm = build({ invoices: [a, b], overrides: { [`invoice:${a.invoiceID}`]: { excluded: true }, [`invoice:${b.invoiceID}`]: { excluded: true } } });
    expect(cm.items.map(i => i.excluded)).toEqual([true, true]);
    expect(cm.tiles.overdue).toEqual({ in: 0, out: 0, net: 0 });
    expect(cm.series.every(d => d.in === 0)).toBe(true);
    expect(cm.series[90].balance).toBe(1000);
  });

  test('every kind of item can be changed by its key', () => {
    const cm = build({
      templates: [{ repeatingInvoiceId: 'r1', type: 'ACCREC', contactName: 'A', total: 10, currencyCode: '', schedule: { period: 1, unit: 'WEEKLY', nextScheduledDate: day(1), dueDateType: 'DAYSAFTERINVOICEDATE', dueDate: 0 } }],
      payments: _paymentsOf([{ paymentID: 'p1', paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: day(2), amount: 5 }]),
      entries: [{ id: 'e1', direction: 'in', description: 'Grant', amountCents: 100, date: day(3), frequency: 'once' }],
      overrides: {
        [`repeating:r1:${day(1)}`]: { date: day(6) },
        'payment:p1': { amountCents: 700 },
        [`manual:e1:${day(3)}`]: { excluded: true },
      },
    });
    expect(item(cm, `repeating:r1:${day(1)}`)).toMatchObject({ date: day(6), dateBasis: 'override' });
    expect(item(cm, 'payment:p1')).toMatchObject({ amount: 7, originalAmount: 5 });
    expect(item(cm, `manual:e1:${day(3)}`)).toMatchObject({ excluded: true });
  });

  test('a date set past the horizon keeps the item listed, so the change can be undone, and counts nowhere', () => {
    const a = inv();
    const cm = build({ invoices: [a], overrides: { [`invoice:${a.invoiceID}`]: { date: day(200) } } });
    expect(item(cm, `invoice:${a.invoiceID}`)).toMatchObject({ beyondHorizon: true, overridden: true });
    expect(cm.series.every(d => d.in === 0)).toBe(true);
  });

  test('an invoice due past the horizon is not listed, and the note counts it', () => {
    const cm = build({ invoices: [inv({ dueDate: `${day(120)}T00:00:00` })] });
    expect(cm.items).toEqual([]);
    expect(cm.notes.join(' ')).toMatch(new RegExp(`1 item falls after ${HORIZON_END}`));
  });
});

// ── Days, tiles, runway ─────────────────────────────────────────────────────

describe('the series, the tiles and the runway', () => {
  test('today and the ninety days after it, as Xero counts "90 days", the balance running from the opening balance, in cents', () => {
    const cm = build({ entries: [
      { id: 'a', direction: 'in',  description: 'x', amountCents: 10, date: TODAY, frequency: 'once' },
      { id: 'b', direction: 'in',  description: 'x', amountCents: 20, date: TODAY, frequency: 'once' },
      { id: 'c', direction: 'out', description: 'x', amountCents: 7,  date: day(1), frequency: 'once' },
    ] });
    expect(cm.horizonDays).toBe(HORIZON_DAYS);
    expect(HORIZON_DAYS).toBe(91);
    expect(cm.series).toHaveLength(91);
    expect(cm.series[0].date).toBe(TODAY);
    expect(cm.series[90].date).toBe(HORIZON_END);
    expect(cm.horizonEnd).toBe('2027-01-10');
    expect(cm.series.every((d, i) => i === 0 || d.date === day(1, cm.series[i - 1].date))).toBe(true);
    expect(cm.series[0]).toEqual({ date: TODAY, in: 0.3, out: 0, net: 0.3, balance: 1000.3 });   // not 0.30000000000000004
    expect(cm.series[1]).toEqual({ date: day(1), in: 0, out: 0.07, net: -0.07, balance: 1000.23 });
    expect(cm.series[90].balance).toBe(1000.23);
  });

  test('the tiles: today, the next 7 days, days 8 to 30, overdue; day 31 is in none', () => {
    const at = (n, cents, direction = 'in') => ({ id: `e${n}${direction}`, direction, description: 'x', amountCents: cents, date: day(n), frequency: 'once' });
    const cm = build({ entries: [at(0, 100), at(1, 200), at(7, 300), at(8, 400), at(30, 500), at(31, 600), at(-1, 700), at(3, 50, 'out')] });
    expect(cm.tiles).toEqual({
      bankBalance: 1000,
      today:     { in: 1, out: 0, net: 1 },
      next7:     { in: 5, out: 0.5, net: 4.5 },
      next8to30: { in: 9, out: 0, net: 9 },
      overdue:   { in: 7, out: 0, net: 7 },
    });
  });

  test('runway is the first day the balance drops below the overdraft', () => {
    const out = (n, cents) => ({ id: `o${n}`, direction: 'out', description: 'x', amountCents: cents, date: day(n), frequency: 'once' });
    expect(build({ entries: [out(5, 150000)] }).runwayDays).toBe(5);              // 1,000 − 1,500
    expect(build({ entries: [out(5, 100000)] }).runwayDays).toBeNull();           // exactly zero is not below it
    expect(build({ entries: [out(5, 150000)], bankOptions: { 'a-op': { overdraftCents: 50000 } } }).runwayDays).toBeNull();
    expect(build({ entries: [out(5, 150001)], bankOptions: { 'a-op': { overdraftCents: 50000 } } }).runwayDays).toBe(5);
    expect(build({ entries: [out(0, 100001)] }).runwayDays).toBe(0);
  });

  test('without a bank balance there is no balance anywhere, never a 0; cash in and out still are, and it says so', () => {
    const cm = build({ bank: null, entries: [{ id: 'o', direction: 'out', description: 'x', amountCents: 100, date: day(1), frequency: 'once' }] });
    expect(cm.bank).toEqual({ available: false, unavailableReason: 'summary', balance: null, overdraft: null, accounts: [] });
    expect(cm.tiles.bankBalance).toBeNull();
    expect(cm.series).toHaveLength(91);
    expect(cm.series.every(d => d.balance === null)).toBe(true);
    expect(cm.series[1]).toEqual({ date: day(1), in: 0, out: 1, net: -1, balance: null });
    expect(cm.tiles.next7).toEqual({ in: 0, out: 1, net: -1 });
    expect(cm.runwayDays).toBeNull();
    expect(cm.notes.join(' ')).toMatch(/Bank balances could not be read from Xero just now, so no opening balance is shown, the running balance is not drawn and no runway is given/);
    expect(cm.notes.join(' ')).not.toMatch(/starts from zero/);
  });

  test('with a balance, unavailableReason is null and the running balance is drawn', () => {
    const cm = build();
    expect(cm.bank).toMatchObject({ available: true, unavailableReason: null, balance: 1000, overdraft: 0 });
    expect(cm.series.every(d => d.balance === 1000)).toBe(true);
  });
});

// ── The bank account list could not be read ─────────────────────────────────

describe('without Xero\'s list of bank accounts', () => {
  // 5,000 SGD in Operating and 11,000 USD: without the list, the USD line was
  // taken for base currency and the balance read 16,000.
  const bank = { accounts: [
    { name: 'Operating', closingBalance: 5000, cashReceived: 0, cashSpent: 0, openingBalance: 5000 },
    { name: 'USD Account', closingBalance: 11000, cashReceived: 0, cashSpent: 0, openingBalance: 11000 },
  ] };
  const pay = (id, n, over = {}) => ({
    paymentID: id, paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: `${day(n)}T00:00:00`, amount: 70,
    account: { accountID: 'a-usd' }, invoice: { invoiceNumber: `INV-${id}`, contact: { name: 'Acme' } }, ...over,
  });

  test('no balance is given, never one with a foreign account added in at face value, and the reason is the list', () => {
    const cm = build({ bank, bankAccounts: null });
    expect(cm.bank).toEqual({ available: false, unavailableReason: 'accounts', balance: null, overdraft: null, accounts: [] });
    expect(cm.tiles.bankBalance).toBeNull();
    expect(cm.series.every(d => d.balance === null)).toBe(true);
    expect(cm.runwayDays).toBeNull();
    const notes = cm.notes.join(' ');
    expect(notes).toMatch(/Xero's list of bank accounts could not be read just now, so which accounts are in base currency and which are switched off here is not known: the bank balance is not shown, the running balance is not drawn and no runway is given/);
    expect(notes).not.toMatch(/Bank balances could not be read/);
    // With the list, the same Bank Summary counts the SGD account only.
    const known = build({ bank, bankAccounts: [...LIST, { accountId: 'a-usd', name: 'USD Account', currency: 'USD' }] });
    expect(known.bank).toMatchObject({ available: true, unavailableReason: null, balance: 5000 });
  });

  test('the last thirty days are not shown rather than guessed, and say why', () => {
    const cm = build({ bank, bankAccounts: null, payments: _paymentsOf([pay('old', -3)]), bankTransactions: [] });
    expect(cm).toMatchObject({ actualsAvailable: false, actuals: [], actualItems: [], actualsCheck: null });
    const notes = cm.notes.join(' ');
    expect(notes).toMatch(/The 30 days before today are not shown either, since money through an account in another currency or switched off here cannot be told apart/);
    // Both reads succeeded, so it is not said that they failed.
    expect(notes).not.toMatch(/Past cash could not be read/);
  });

  test('payments dated ahead are all counted, since none can be checked, and the note says so', () => {
    const cm = build({ bank, bankAccounts: null, payments: _paymentsOf([pay('ahead', 4)]) });
    expect(item(cm, 'payment:ahead')).toMatchObject({ amount: 70, date: day(4) });
    expect(cm.notes.join(' ')).toMatch(/Payments and Spend or Receive Money dated after today are all counted: without the list of bank accounts, the account each goes through could not be checked/);
    // With the list, the same payment into the USD account is left out.
    const known = build({ bank, bankAccounts: [...LIST, { accountId: 'a-usd', name: 'USD Account', currency: 'USD' }], payments: _paymentsOf([pay('ahead', 4)]) });
    expect(item(known, 'payment:ahead')).toBeUndefined();
    expect(known.notes.join(' ')).not.toMatch(/all counted/);
  });

  test('with the Bank Summary unreadable but the list read, a foreign or switched-off account\'s records are still left out', () => {
    const list = [...LIST, { accountId: 'a-usd', name: 'USD Account', currency: 'USD' }, { accountId: 'a-sav', name: 'Savings', currency: 'SGD' }];
    const cm = build({
      bank: null, bankAccounts: list, bankOptions: { 'a-sav': { included: false } },
      payments: _paymentsOf([pay('usd', 4), pay('sav', 5, { account: { accountID: 'a-sav' } }), pay('op', 6, { account: { accountID: 'a-op' } }),
        pay('usd-past', -2), pay('op-past', -2, { account: { accountID: 'a-op' } })]),
    });
    expect(cm.bank.unavailableReason).toBe('summary');
    expect(cm.items.filter(i => i.source === 'payment').map(i => i.key)).toEqual(['payment:op']);
    expect(cm.actualsAvailable).toBe(true);
    expect(cm.actualItems.map(i => i.key)).toEqual(['actual:payment:op-past']);
  });
});

describe('the bank', () => {
  const bank = { accounts: [
    { name: 'Operating', closingBalance: 1000 }, { name: 'Savings', closingBalance: 500 },
    { name: 'USD Account', closingBalance: 7000 }, { name: 'Petty Cash', closingBalance: 25 },
  ] };
  const list = [...LIST, { accountId: 'a-sav', name: 'Savings', currency: 'SGD' }, { accountId: 'a-usd', name: 'USD Account', currency: 'USD' }];

  test('base accounts count; a foreign one is listed apart and noted; options apply per account', () => {
    const cm = build({ bank, bankAccounts: list, bankOptions: {
      'a-op': { openingAdjustmentCents: -10050, overdraftCents: 200000 },
      'a-sav': { included: false },
      'a-usd': { included: true },
    } });
    expect(cm.bank.accounts).toEqual([
      { accountId: 'a-op', name: 'Operating', currency: 'SGD', balance: 1000, included: true, openingAdjustment: -100.5, overdraft: 2000, foreign: false },
      { accountId: 'a-sav', name: 'Savings', currency: 'SGD', balance: 500, included: false, openingAdjustment: 0, overdraft: 0, foreign: false },
      // Not in the account list, so named by its name and taken as base.
      { accountId: 'name:Petty Cash', name: 'Petty Cash', currency: 'SGD', balance: 25, included: true, openingAdjustment: 0, overdraft: 0, foreign: false },
      { accountId: 'a-usd', name: 'USD Account', currency: 'USD', balance: 7000, included: false, openingAdjustment: 0, overdraft: 0, foreign: true },
    ]);
    expect(cm.bank).toMatchObject({ available: true, balance: 924.5, overdraft: 2000 });
    expect(cm.tiles.bankBalance).toBe(924.5);
    expect(cm.notes.join(' ')).toMatch(/USD Account \(USD\) is in another currency/);
  });

  test('foreign invoices are converted at their own rate and noted', () => {
    const a = inv({ currencyCode: 'USD', currencyRate: 0.74, amountDue: 74 });
    const cm = build({ invoices: [a] });
    expect(item(cm, `invoice:${a.invoiceID}`)).toMatchObject({ amount: 100, faceAmount: 74, currency: 'USD', foreign: true });
    expect(cm.notes.join(' ')).toMatch(/Amounts in USD are converted to SGD/);
  });
});

// ── Fetched: Xero calls, cold and warm ──────────────────────────────────────

const cell = value => ({ value });
const row = (label, values, rowType = 'Row') => ({ rowType, cells: [label, ...values].map(cell) });
const bankRows = closing => [
  { rowType: 'Header', cells: ['Bank Accounts', 'Opening Balance', 'Cash Received', 'Cash Spent', 'Closing Balance'].map(cell) },
  { rowType: 'Section', title: '', rows: [
    row('Operating',   ['900.00', '200.00', '(100.00)', closing]),
    row('USD Account', ['7,000.00', '0.00', '0.00', '7,000.00']),
  ] },
];
const NOW = new Date(`${TODAY}T04:00:00Z`);
const fakeNow = () => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });

describe('getCashManager — Xero calls', () => {
  const U = 'u-cm';
  let n = 0, T;
  const ORG = { name: 'Org Pte Ltd', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 };
  const scopeError = () => JSON.stringify({ response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' }, body: {} } });

  beforeEach(() => {
    jest.clearAllMocks();
    reports._cache.clear();
    fakeNow();
    T = `t-cm-${++n}`;
    const empty = { body: { reports: [{ rows: [] }] } };
    api.getOrganisations.mockResolvedValue({ body: { organisations: [ORG] } });
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      inv({ dueDate: `${day(5)}T00:00:00`, amountDue: 300 }),
      inv({ type: 'ACCPAY', dueDate: `${day(9)}T00:00:00`, amountDue: 120, contact: { contactID: 's1', name: 'Supplier' } }),
      paid(-60, 10), paid(-40, 10),
    ] } });
    api.getCreditNotes.mockResolvedValue({ body: { creditNotes: [] } });
    api.getReportBankSummary.mockResolvedValue({ body: { reports: [{ rows: bankRows('1,000.00') }] } });
    api.getAccounts.mockResolvedValue({ body: { accounts: [
      { accountID: 'a-op', name: 'Operating', type: 'BANK', currencyCode: 'SGD' },
      { accountID: 'a-usd', name: 'USD Account', type: 'BANK', currencyCode: 'USD' },
    ] } });
    api.getRepeatingInvoices.mockResolvedValue({ body: { repeatingInvoices: [] } });
    api.getPayments.mockResolvedValue({ body: { payments: [] } });
    api.getReportProfitAndLoss.mockResolvedValue(empty);
    api.getReportBudgetSummary.mockResolvedValue(empty);
    api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
    api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: [] } });
  });
  afterEach(() => jest.useRealTimers());

  // The client is one shared object, so _apiFor's accessToken lands on it too.
  const calls = () => Object.fromEntries(Object.entries(api).filter(([, f]) => f && f.mock)
    .map(([k, f]) => [k, f.mock.calls.length]).filter(([, c]) => c > 0));
  const total = () => Object.values(calls()).reduce((s, c) => s + c, 0);

  test('the SDK is the mock: nothing here reaches Xero', () => {
    expect(jest.isMockFunction(AccountingApi)).toBe(true);
    expect(jest.isMockFunction(api.getRepeatingInvoices)).toBe(true);
  });

  test('cold: eight reads, each asked for as Xero expects, and only reads', async () => {
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(calls()).toEqual({
      getOrganisations: 1, getInvoices: 1, getCreditNotes: 1, getReportBankSummary: 1,
      getAccounts: 1, getRepeatingInvoices: 1, getPayments: 2, getBankTransactions: 1,
    });
    expect(api.getRepeatingInvoices.mock.calls[0]).toEqual([T, 'Status=="AUTHORISED"']);
    // One read of payments for both sides of today, from the Bank Summary
    // window's first day; one of bank transactions over that same window.
    // The other payments read is the summary's, over the year and two days
    // that date its paid invoices for the lateness (summary.js#_readPaidOn).
    expect(api.getPayments.mock.calls).toEqual(expect.arrayContaining([
      [T, undefined, 'Date >= DateTime(2026,9,11) && Status=="AUTHORISED"', 'Date ASC', 1],
      [T, undefined, 'Date >= DateTime(2025,10,10) && Status=="AUTHORISED"', 'Date DESC', 1],
    ]));
    // No upper bound, as the payments: Spend and Receive Money dated ahead
    // come from the same read.
    expect(api.getBankTransactions.mock.calls[0]).toEqual([T, undefined, 'Date >= DateTime(2026,9,11) && Status=="AUTHORISED"', 'Date ASC', 1]);
    // The Overview's own balance window, so a Dashboard already open has it.
    expect(api.getReportBankSummary.mock.calls[0]).toEqual([T, '2026-09-11', TODAY]);
    expect(_todayBalanceWindow({ year: 2026, month: 10, day: 12 })).toEqual({ from: '2026-09-11', to: TODAY });
    for (const name of Object.keys(calls())) expect(name).toMatch(/^get/);

    expect(cm).toMatchObject({
      organisation: { name: 'Org Pte Ltd', currency: 'SGD' }, today: TODAY, horizonDays: 91, cached: false,
      bank: { available: true, balance: 1000 }, actualsAvailable: true,
    });
    expect(cm.actuals).toHaveLength(30);
    expect(typeof cm.fetchedAt).toBe('number');
    // Acme's history, from the same fetch, dates its invoice ten days late.
    expect(cm.items.find(i => i.source === 'invoice')).toMatchObject({ date: day(15), dateBasis: 'predicted', amount: 300 });
    expect(cm.items.find(i => i.source === 'bill')).toMatchObject({ date: day(9), dateBasis: 'due', amount: 120 });
    expect(cm.bank.accounts.find(a => a.name === 'USD Account')).toMatchObject({ foreign: true, included: false });
  });

  test('a repeat costs nothing and says it is cached', async () => {
    await reports.getCashManager(U, T, { timezone: 'UTC' });
    const before = total();
    const again = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(total()).toBe(before);
    expect(again.cached).toBe(true);
  });

  test('warm, with the Dashboard loaded (summary, Overview, an ageing view): three new calls, the templates, the payments and the bank transactions', async () => {
    await reports.getSummary(U, T, { force: false });
    await reports.getPerformance(U, T, { timezone: 'UTC', period: { preset: 'fy-ytd' } });
    await reports.getAgeing(U, T, { side: 'receivables', timezone: 'UTC' });
    const before = calls();
    await reports.getCashManager(U, T, { timezone: 'UTC' });
    const after = calls();
    const added = Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] || 0)]).filter(([, c]) => c > 0));
    expect(added).toEqual({ getRepeatingInvoices: 1, getPayments: 1, getBankTransactions: 1 });
  });

  test('warm with only the summary loaded: the bank, its account list, the templates, the payments and the bank transactions', async () => {
    await reports.getSummary(U, T, { force: false });
    const before = calls();
    await reports.getCashManager(U, T, { timezone: 'UTC' });
    const after = calls();
    expect(Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] || 0)]).filter(([, c]) => c > 0))).toEqual({
      getReportBankSummary: 1, getAccounts: 1, getRepeatingInvoices: 1, getPayments: 1, getBankTransactions: 1,
    });
    expect(api.getInvoices).toHaveBeenCalledTimes(1);
    expect(api.getOrganisations).toHaveBeenCalledTimes(1);
  });

  test('a change made here shows on the next load at once, and costs no Xero call', async () => {
    const users = require('../utils/users');
    const user  = await users.createUser(`cm-${Date.now()}@test.com`, 'password123', 'user');
    const first = await reports.getCashManager(user.id, T, { timezone: 'UTC' });
    const before = total();
    const store = require('../utils/cash-manager-store').forTenant(user.id, T);
    store.addEntry({ direction: 'out', description: 'Rent', amount: 2500, date: day(3), frequency: 'once' });
    const inv0 = first.items.find(i => i.source === 'invoice');
    store.setOverride(inv0.key, { excluded: true });
    const next = await reports.getCashManager(user.id, T, { timezone: 'UTC' });
    expect(total()).toBe(before);
    expect(next.items.find(i => i.source === 'manual')).toMatchObject({ amount: 2500, date: day(3) });
    expect(next.items.find(i => i.key === inv0.key)).toMatchObject({ excluded: true });
  });

  test('a scope error on the templates is a note, not a failure, and they are asked for again next time', async () => {
    api.getRepeatingInvoices.mockRejectedValueOnce(scopeError());
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(cm.notes.join(' ')).toMatch(/Repeating invoices could not be read: the Xero connection does not allow it/);
    expect(cm.items.length).toBeGreaterThan(0);
    await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(api.getRepeatingInvoices).toHaveBeenCalledTimes(2);
  });

  test('payments and the bank failing cost what they add, not the projection', async () => {
    // Both payments reads: this tab's, and the summary's behind the lateness.
    api.getPayments.mockRejectedValue(new Error('rate limited'));
    api.getReportBankSummary.mockRejectedValueOnce(new Error('bank summary down'));
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(cm.bank.available).toBe(false);
    expect(cm.notes.join(' ')).toMatch(/Payments dated after today could not be read from Xero just now/);
    expect(cm.notes.join(' ')).toMatch(/Bank balances could not be read/);
  });

  test('the Bank Summary failing gives no balance, not a 0, and says the summary was the reason', async () => {
    api.getReportBankSummary.mockRejectedValueOnce(new Error('bank summary down'));
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(cm.bank).toMatchObject({ available: false, unavailableReason: 'summary', balance: null, overdraft: null });
    expect(cm.tiles.bankBalance).toBeNull();
    expect(cm.series.every(d => d.balance === null)).toBe(true);
    expect(cm.series.some(d => d.in > 0)).toBe(true);
  });

  test('the account list failing gives no balance and no actuals, rather than the USD account counted as base', async () => {
    api.getAccounts.mockRejectedValueOnce(new Error('accounts down'));
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(cm.bank).toMatchObject({ available: false, unavailableReason: 'accounts', balance: null, accounts: [] });
    expect(cm.tiles.bankBalance).toBeNull();
    expect(cm.actualsAvailable).toBe(false);
    expect(cm.notes.join(' ')).toMatch(/Xero's list of bank accounts could not be read just now/);
    // Not cached as an empty list: the next load asks again and has the balance.
    const again = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(again.bank).toMatchObject({ available: true, unavailableReason: null, balance: 1000 });
    expect(again.actualsAvailable).toBe(true);
  });

  test('the templates are read again as soon as the invoices are, so an invoice raised from one is not counted twice', async () => {
    const { CACHE_TTL_MS } = require('./report-cache');
    expect(REPEATING_TTL_MS).toBe(CACHE_TTL_MS);
    await reports.getCashManager(U, T, { timezone: 'UTC' });
    jest.setSystemTime(new Date(NOW.getTime() + CACHE_TTL_MS - 1000));
    await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect([api.getInvoices.mock.calls.length, api.getRepeatingInvoices.mock.calls.length]).toEqual([1, 1]);
    jest.setSystemTime(new Date(NOW.getTime() + CACHE_TTL_MS + 1000));
    await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect([api.getInvoices.mock.calls.length, api.getRepeatingInvoices.mock.calls.length]).toEqual([2, 2]);
  });

  test('Spend and Receive Money dated ahead come from the one bank-transactions read, and a longer horizon finds the same read', async () => {
    api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: [
      { bankTransactionID: 'past', type: 'SPEND', status: 'AUTHORISED', date: new Date(Date.UTC(2026, 9, 9)), total: 45, bankAccount: { accountID: 'a-op' } },
      { bankTransactionID: 'gst', type: 'SPEND', status: 'AUTHORISED', date: new Date(Date.UTC(2026, 9, 28)), total: 630,
        bankAccount: { accountID: 'a-op' }, contact: { name: 'IRAS' }, reference: 'GST Q3', lineAmountTypes: 'NoTax', lineItems: [{ accountCode: '820', lineAmount: 630 }] },
      { bankTransactionID: 'far', type: 'RECEIVE', status: 'AUTHORISED', date: new Date(Date.UTC(2027, 4, 3)), total: 900,
        bankAccount: { accountID: 'a-op' }, lineItems: [{ accountCode: '260', lineAmount: 900 }] },
    ] } });
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(cm.items.find(i => i.key === 'banktx:gst')).toMatchObject({
      source: 'banktx', dateBasis: 'banktx', date: '2026-10-28', direction: 'out', amount: 630, contactName: 'IRAS', reference: 'GST Q3',
      accounts: [{ code: '820', amount: 630 }],
    });
    expect(cm.items.find(i => i.key === 'banktx:far')).toBeUndefined();   // past the 90 days
    expect(cm.actualItems.map(i => i.key)).toEqual(['actual:banktransaction:past']);
    // The monthly forecast's year ahead: no second read, and the one past the 90 days is on it.
    const long = await reports.getCashManager(U, T, { timezone: 'UTC', horizonDays: 300 });
    expect(api.getBankTransactions).toHaveBeenCalledTimes(1);
    expect(long.items.find(i => i.key === 'banktx:far')).toMatchObject({ date: '2027-05-03', direction: 'in', amount: 900 });
  });

  test('a failed read of the bank transactions costs the actuals only, and is asked for again next time', async () => {
    api.getBankTransactions.mockRejectedValueOnce(new Error('rate limited'));
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(cm).toMatchObject({ actualsAvailable: false, actuals: [], bank: { available: true } });
    expect(cm.items.length).toBeGreaterThan(0);
    const again = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(again.actualsAvailable).toBe(true);
    expect(api.getBankTransactions).toHaveBeenCalledTimes(2);
    // This tab's payments and the summary's (summary.js#_readPaidOn), each read once.
    expect(api.getPayments).toHaveBeenCalledTimes(2);
  });

  test('past payments and bank transactions from Xero reach the actuals, from the one payments read', async () => {
    api.getPayments.mockResolvedValue({ body: { payments: [
      { paymentID: 'old', paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: new Date(Date.UTC(2026, 9, 7)), amount: 57000, account: { accountID: 'a-op' }, invoice: { invoiceNumber: 'INV-7', contact: { name: 'Acme' } } },
      { paymentID: 'new', paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: new Date(Date.UTC(2026, 9, 20)), amount: 90, account: { accountID: 'a-op' }, invoice: { invoiceNumber: 'INV-8', contact: { name: 'Acme' } } },
    ] } });
    api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: [
      { bankTransactionID: 'b1', type: 'SPEND', status: 'AUTHORISED', date: new Date(Date.UTC(2026, 9, 9)), total: 45, bankAccount: { accountID: 'a-op' }, contact: { name: 'Shop' } },
      { bankTransactionID: 'b2', type: 'SPEND', status: 'AUTHORISED', date: new Date(Date.UTC(2026, 9, 9)), total: 500, bankAccount: { accountID: 'a-usd' } },
    ] } });
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(cm.actuals.find(d => d.date === '2026-10-07')).toMatchObject({ in: 57000, out: 0 });
    // The USD account is not in the balance, so its spending is not either.
    expect(cm.actuals.find(d => d.date === '2026-10-09')).toMatchObject({ in: 0, out: 45 });
    expect(cm.actualItems.map(i => [i.key, i.source])).toEqual([['actual:payment:old', 'payment'], ['actual:banktransaction:b1', 'banktransaction']]);
    expect(cm.items.find(i => i.key === 'payment:new')).toMatchObject({ date: '2026-10-20', amount: 90 });
    // The one read of this tab's; the other is the summary's year behind the lateness.
    expect(api.getPayments.mock.calls.map(c => c[2]).sort()).toEqual([
      'Date >= DateTime(2025,10,10) && Status=="AUTHORISED"', 'Date >= DateTime(2026,9,11) && Status=="AUTHORISED"',
    ]);
  });

  test('templates and future payments from Xero reach the projection', async () => {
    api.getRepeatingInvoices.mockResolvedValue({ body: { repeatingInvoices: [
      { repeatingInvoiceID: 'r1', type: 'ACCPAY', status: 'AUTHORISED', total: 400, currencyCode: 'SGD', contact: { contactID: 's1', name: 'Landlord' },
        schedule: { period: 1, unit: 'MONTHLY', dueDate: 1, dueDateType: 'OFFOLLOWINGMONTH', startDate: new Date(Date.UTC(2026, 0, 15)), nextScheduledDate: new Date(Date.UTC(2026, 9, 15)) } },
    ] } });
    api.getPayments.mockResolvedValue({ body: { payments: [
      { paymentID: 'p1', paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: new Date(Date.UTC(2026, 9, 20)), amount: 90, account: { accountID: 'a-op' }, invoice: { invoiceNumber: 'INV-1', contact: { name: 'Acme' } } },
    ] } });
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(cm.items.filter(i => i.source === 'repeating').map(i => [i.key, i.date])).toEqual([
      ['repeating:r1:2026-10-15', '2026-11-01'], ['repeating:r1:2026-11-15', '2026-12-01'], ['repeating:r1:2026-12-15', '2027-01-01'],
    ]);
    expect(cm.items.find(i => i.key === 'payment:p1')).toMatchObject({ date: '2026-10-20', direction: 'in', amount: 90 });
  });

  test('how late a contact pays is measured to the user\'s today: a payment made this morning in Singapore counts there', async () => {
    jest.setSystemTime(new Date('2026-10-12T17:30:00Z'));   // the 13th in Singapore
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      inv({ dueDate: `${day(5)}T00:00:00`, amountDue: 300 }),
      paid(-60, 10),
      inv({ status: 'PAID', amountDue: 0, dueDate: '2026-10-03T00:00:00', fullyPaidOnDate: '2026-10-13T00:00:00' }),
    ] } });
    const sg = await reports.getCashManager(U, T, { timezone: 'Asia/Singapore' });
    const la = await reports.getCashManager(U, T, { timezone: 'America/Los_Angeles' });
    expect(sg.items.find(i => i.source === 'invoice')).toMatchObject({ dateBasis: 'predicted', daysLate: 10 });
    expect(la.items.find(i => i.source === 'invoice')).toMatchObject({ dateBasis: 'due', daysLate: null });
    expect(api.getInvoices).toHaveBeenCalledTimes(1);
  });

  test('"today" is the user\'s: Singapore is already on the 13th', async () => {
    jest.setSystemTime(new Date('2026-10-12T17:30:00Z'));
    const sg = await reports.getCashManager(U, T, { timezone: 'Asia/Singapore' });
    const la = await reports.getCashManager(U, T, { timezone: 'America/Los_Angeles' });
    expect(sg.today).toBe('2026-10-13');
    expect(la.today).toBe('2026-10-12');
    expect(sg.series[0].date).toBe('2026-10-13');
  });
});

// ── The Cash Flow tab's forecast ────────────────────────────────────────────

describe('the Cash Flow tab\'s 13-week forecast starts from today\'s balance', () => {
  const U = 'u-cf';
  let n = 0;
  beforeEach(() => {
    jest.clearAllMocks();
    reports._cache.clear();
    fakeNow();
    const empty = { body: { reports: [{ rows: [] }] } };
    api.getOrganisations.mockResolvedValue({ body: { organisations: [{ name: 'Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 12 }] } });
    api.getInvoices.mockResolvedValue({ body: { invoices: [inv({ dueDate: `${day(3)}T00:00:00`, amountDue: 250 })] } });
    api.getReportProfitAndLoss.mockResolvedValue(empty);
    api.getReportBudgetSummary.mockResolvedValue(empty);
    api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
    api.getPayments.mockResolvedValue({ body: { payments: [] } });
    api.getBankTransactions.mockResolvedValue({ body: { bankTransactions: [] } });
    api.getAccounts.mockResolvedValue({ body: { accounts: [
      { accountID: 'a-op', name: 'Operating', type: 'BANK', currencyCode: 'SGD' },
      { accountID: 'a-usd', name: 'USD Account', type: 'BANK', currencyCode: 'USD' },
    ] } });
    // The balance at the end of last quarter was 1,000; today it is 5,000.
    api.getReportBankSummary.mockImplementation(async (t, from, to) => ({
      body: { reports: [{ rows: bankRows(to === TODAY ? '5,000.00' : '1,000.00') }] },
    }));
  });
  afterEach(() => jest.useRealTimers());

  test('on a past period the period closes on its own balance, and the forecast opens on today\'s', async () => {
    const cf = await reports.getCashFlow(U, `t-cf-${++n}`, { timezone: 'UTC', period: { preset: 'last-quarter' } });
    expect(cf.cash.closing).toBe(1000);
    expect(cf.forecast).toMatchObject({ openingBalance: 5000, openingAsOf: TODAY });
    expect(cf.forecast.weeks[0]).toMatchObject({ receipts: 250, balance: 5250 });
    expect(api.getReportBankSummary.mock.calls.map(c => c.slice(1))).toContainEqual(['2026-09-11', TODAY]);
  });

  test('today\'s balance is the Overview\'s read: with the Overview loaded it costs no call', async () => {
    const T = `t-cf-${++n}`;
    await reports.getPerformance(U, T, { timezone: 'UTC', period: { preset: 'fy-ytd' } });
    const before = api.getReportBankSummary.mock.calls.length;
    await reports.getCashFlow(U, T, { timezone: 'UTC', period: { preset: 'last-quarter' } });
    // Only the period's own window is new.
    expect(api.getReportBankSummary.mock.calls.length - before).toBe(1);
  });

  test('when today\'s balance cannot be read, the forecast falls back to the period\'s and says which', async () => {
    api.getReportBankSummary.mockImplementation(async (t, from, to) => {
      if (to === TODAY) throw new Error('bank summary down');
      return { body: { reports: [{ rows: bankRows('1,000.00') }] } };
    });
    const cf = await reports.getCashFlow(U, `t-cf-${++n}`, { timezone: 'UTC', period: { preset: 'last-quarter' } });
    expect(cf.forecast).toMatchObject({ openingBalance: 1000, openingAsOf: '2026-09-30' });
  });
});
