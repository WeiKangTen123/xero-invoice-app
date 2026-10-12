// The Cash Flow Manager: how each item is dated, what is overdue, what is
// netted, what the repeating templates and future payments add, the entries
// and changes kept here, the arithmetic of the days and tiles, and what it
// costs in Xero calls. Xero is mocked, as everywhere in this suite; nothing
// here reaches it.
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
  _buildCashManager, _repeatingDates, _repeatingDue, _templatesOf, _futurePaymentsOf, _manualDates, _todayBalanceWindow,
  HORIZON_DAYS,
} = require('./cash-manager');
const { _outstandingOf, _latenessOf, LATENESS_MAX_DAYS } = require('./summary');
const { _creditsOf } = require('./ageing');

const TODAY = '2026-10-12';
const day = (n, from = TODAY) => {
  const [y, m, d] = from.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const HORIZON_END = day(89);   // 2027-01-09

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
  bank: BANK, bankAccounts: LIST, templates: [], payments: [],
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
    expect(cm.series[89].balance).toBe(1005);
  });

  test('a date set here takes an overdue item off the overdue list and onto its day', () => {
    const late = inv({ dueDate: `${day(-3)}T00:00:00` });
    const cm = build({ invoices: [late], overrides: { [`invoice:${late.invoiceID}`]: { date: day(2) } } });
    expect(item(cm, `invoice:${late.invoiceID}`)).toMatchObject({ overdue: false, dateBasis: 'override' });
    expect(cm.tiles.overdue).toEqual({ in: 0, out: 0, net: 0 });
    expect(onDay(cm, day(2)).in).toBe(100);
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
    const cm = build({ payments: _futurePaymentsOf(list) });
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
      payments: _futurePaymentsOf(list),
      bank: { accounts: [...BANK.accounts, { name: 'Savings', closingBalance: 50 }] },
      bankAccounts: [...LIST, { accountId: 'a-off', name: 'Savings', currency: 'SGD' }],
      bankOptions: { 'a-off': { included: false } },
    });
    expect(item(cm, 'payment:p-usd')).toMatchObject({ amount: 100, currency: 'USD', faceAmount: 74 });
    expect(item(cm, 'payment:p-off')).toBeUndefined();
    expect(cm.notes.join(' ')).toMatch(/1 future payment goes through a bank account left out of the balance/);
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
    expect(_manualDates(e({ frequency: 'daily', date: day(-3) }), TODAY, HORIZON_END)).toHaveLength(90);
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
    expect(cm.series[89].balance).toBe(1000);
  });

  test('every kind of item can be changed by its key', () => {
    const cm = build({
      templates: [{ repeatingInvoiceId: 'r1', type: 'ACCREC', contactName: 'A', total: 10, currencyCode: '', schedule: { period: 1, unit: 'WEEKLY', nextScheduledDate: day(1), dueDateType: 'DAYSAFTERINVOICEDATE', dueDate: 0 } }],
      payments: _futurePaymentsOf([{ paymentID: 'p1', paymentType: 'ACCRECPAYMENT', status: 'AUTHORISED', date: day(2), amount: 5 }]),
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
  test('ninety consecutive days from today, the balance running from the opening balance, in cents', () => {
    const cm = build({ entries: [
      { id: 'a', direction: 'in',  description: 'x', amountCents: 10, date: TODAY, frequency: 'once' },
      { id: 'b', direction: 'in',  description: 'x', amountCents: 20, date: TODAY, frequency: 'once' },
      { id: 'c', direction: 'out', description: 'x', amountCents: 7,  date: day(1), frequency: 'once' },
    ] });
    expect(cm.horizonDays).toBe(HORIZON_DAYS);
    expect(cm.series).toHaveLength(90);
    expect(cm.series[0].date).toBe(TODAY);
    expect(cm.series[89].date).toBe(HORIZON_END);
    expect(cm.series.every((d, i) => i === 0 || d.date === day(1, cm.series[i - 1].date))).toBe(true);
    expect(cm.series[0]).toEqual({ date: TODAY, in: 0.3, out: 0, net: 0.3, balance: 1000.3 });   // not 0.30000000000000004
    expect(cm.series[1]).toEqual({ date: day(1), in: 0, out: 0.07, net: -0.07, balance: 1000.23 });
    expect(cm.series[89].balance).toBe(1000.23);
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

  test('without a bank balance the projection starts from zero, says so, and gives no runway', () => {
    const cm = build({ bank: null, entries: [{ id: 'o', direction: 'out', description: 'x', amountCents: 100, date: day(1), frequency: 'once' }] });
    expect(cm.bank).toMatchObject({ available: false, balance: 0, accounts: [] });
    expect(cm.runwayDays).toBeNull();
    expect(cm.notes.join(' ')).toMatch(/Bank balances could not be read/);
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

  test('cold: seven reads, each asked for as Xero expects, and only reads', async () => {
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(calls()).toEqual({
      getOrganisations: 1, getInvoices: 1, getCreditNotes: 1, getReportBankSummary: 1,
      getAccounts: 1, getRepeatingInvoices: 1, getPayments: 1,
    });
    expect(api.getRepeatingInvoices.mock.calls[0]).toEqual([T, 'Status=="AUTHORISED"']);
    expect(api.getPayments.mock.calls[0]).toEqual([T, undefined, 'Date > DateTime(2026,10,12) && Status=="AUTHORISED"', 'Date ASC', 1]);
    // The Overview's own balance window, so a Dashboard already open has it.
    expect(api.getReportBankSummary.mock.calls[0]).toEqual([T, '2026-09-11', TODAY]);
    expect(_todayBalanceWindow({ year: 2026, month: 10, day: 12 })).toEqual({ from: '2026-09-11', to: TODAY });
    for (const name of Object.keys(calls())) expect(name).toMatch(/^get/);

    expect(cm).toMatchObject({
      organisation: { name: 'Org Pte Ltd', currency: 'SGD' }, today: TODAY, horizonDays: 90, cached: false,
      bank: { available: true, balance: 1000 },
    });
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

  test('warm, with the Dashboard loaded (summary, Overview, an ageing view): two new calls, the templates and the future payments', async () => {
    await reports.getSummary(U, T, { force: false });
    await reports.getPerformance(U, T, { timezone: 'UTC', period: { preset: 'fy-ytd' } });
    await reports.getAgeing(U, T, { side: 'receivables', timezone: 'UTC' });
    const before = calls();
    await reports.getCashManager(U, T, { timezone: 'UTC' });
    const after = calls();
    const added = Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] || 0)]).filter(([, c]) => c > 0));
    expect(added).toEqual({ getRepeatingInvoices: 1, getPayments: 1 });
  });

  test('warm with only the summary loaded: the bank, the credit notes, the templates and the payments', async () => {
    await reports.getSummary(U, T, { force: false });
    const before = total();
    await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(total() - before).toBe(5);
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
    api.getPayments.mockRejectedValueOnce(new Error('rate limited'));
    api.getReportBankSummary.mockRejectedValueOnce(new Error('bank summary down'));
    const cm = await reports.getCashManager(U, T, { timezone: 'UTC' });
    expect(cm.bank.available).toBe(false);
    expect(cm.notes.join(' ')).toMatch(/Payments dated after today could not be read from Xero just now/);
    expect(cm.notes.join(' ')).toMatch(/Bank balances could not be read/);
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
