// The Dashboard's header figures (summary.js): when an invoice turns overdue,
// and what the receivables and payables totals net off. Xero is mocked, as
// everywhere in this suite; nothing here reaches it.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations: jest.fn(),
    getInvoices:      jest.fn(),
    getCreditNotes:   jest.fn(),
    getPayments:      jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: () => [],
}));

const { __api: api } = require('xero-node');
const reports = require('./reports');

const U = 'u-summary';
const ORG = { name: 'Org', baseCurrency: 'SGD' };
const fakeNow = iso => jest.useFakeTimers({
  now: new Date(iso),
  doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'],
});

let seq = 0;
function inv(over = {}) {
  seq++;
  return {
    invoiceID: `inv-${seq}`, type: 'ACCREC', status: 'AUTHORISED', invoiceNumber: `INV-${seq}`,
    contact: { contactID: 'c-acme', name: 'Acme' },
    date: '2026-09-01T00:00:00', dueDate: '2026-10-07T00:00:00',
    total: 100, amountDue: 100, currencyCode: 'SGD',
    ...over,
  };
}
function credit(over = {}) {
  seq++;
  return {
    creditNoteID: `cn-${seq}`, type: 'ACCRECCREDIT', status: 'AUTHORISED', creditNoteNumber: `CN-${seq}`,
    contact: { contactID: 'c-acme', name: 'Acme' },
    date: '2026-10-01T00:00:00', total: 30, remainingCredit: 30, currencyCode: 'SGD',
    ...over,
  };
}

let n = 0, T;
beforeEach(() => {
  jest.clearAllMocks();
  reports._cache.clear();
  T = `t-summary-${++n}`;
  api.getOrganisations.mockResolvedValue({ body: { organisations: [ORG] } });
  api.getCreditNotes.mockResolvedValue({ body: { creditNotes: [] } });
  api.getPayments.mockResolvedValue({ body: { payments: [] } });
});
afterEach(() => jest.useRealTimers());

const calls = () => ({
  invoices: api.getInvoices.mock.calls.length,
  credits: api.getCreditNotes.mock.calls.length,
  payments: api.getPayments.mock.calls.length,
});

// An invoice due on the 7th was compared with the clock as an instant: Xero's
// "2026-10-07T00:00:00" read as midnight UTC, which is 08:00 in Singapore, so
// it turned overdue that morning while the ageing view, counting calendar days
// where the user is, still called it current until midnight.
describe('overdue is by calendar day where the user is', () => {
  const SG = 'Asia/Singapore';
  const ask = async (now) => {
    fakeNow(now);
    reports._cache.clear();
    const s = await reports.getSummary(U, T, { timezone: SG });
    const a = await reports.getAgeing(U, T, { side: 'receivables', timezone: SG });
    return { s, a };
  };

  test('due the 7th: still current at 23:30 that night in Singapore, overdue at 00:30 on the 8th, as the ageing says', async () => {
    api.getInvoices.mockResolvedValue({ body: { invoices: [inv()] } });

    // 2026-10-07 23:30 in Singapore; the old comparison had it overdue since 08:00.
    const dueDay = await ask('2026-10-07T15:30:00Z');
    expect(dueDay.s.kpis).toMatchObject({ overdueReceivables: 0, overdueReceivablesCount: 0, statusBreakdown: { awaiting: 1, overdue: 0 } });
    expect(dueDay.s.invoices[0].status).toBe('awaiting');
    expect(dueDay.s.aging.receivables.within7).toEqual({ count: 1, amount: 100 });
    expect(dueDay.a.contacts[0].invoices[0]).toMatchObject({ daysOverdue: 0, bucket: 'current' });

    // 2026-10-08 00:30 in Singapore, though still the 7th in UTC.
    const dayAfter = await ask('2026-10-07T16:30:00Z');
    expect(dayAfter.s.kpis).toMatchObject({ overdueReceivables: 100, overdueReceivablesCount: 1, statusBreakdown: { awaiting: 0, overdue: 1 } });
    expect(dayAfter.s.invoices[0].status).toBe('overdue');
    expect(dayAfter.s.aging.receivables.overdue).toEqual({ count: 1, amount: 100 });
    expect(dayAfter.a.contacts[0].invoices[0]).toMatchObject({ daysOverdue: 1, bucket: 'd1_30' });
  });

  // The fetch is cached once per company, and the day applied per request,
  // so a reader in another timezone gets their own day without a second read
  // of every invoice; getPerformance, which names no timezone, shares it too.
  test('one cached fetch serves each timezone its own day; no timezone means UTC', async () => {
    fakeNow('2026-10-07T17:30:00Z');   // the 8th in Singapore, the 7th in UTC
    api.getInvoices.mockResolvedValue({ body: { invoices: [inv()] } });
    const [sg, utc, none] = await Promise.all([
      reports.getSummary(U, T, { timezone: SG }),
      reports.getSummary(U, T, { timezone: 'UTC' }),
      reports.getSummary(U, T),
    ]);
    const later = await reports.getSummary(U, T, { timezone: SG });
    expect(sg.invoices[0].status).toBe('overdue');
    expect(later.invoices[0].status).toBe('overdue');
    expect(utc.invoices[0].status).toBe('awaiting');
    expect(none.kpis).toEqual(utc.kpis);
    expect(calls()).toEqual({ invoices: 1, credits: 1, payments: 1 });
    expect(later.cached).toBe(true);
  });
});

// How late each contact pays (for the Cash Flow Manager's dates) was measured
// over the year to today in UTC, inside the shared, timezone-free read: in
// Singapore before 08:00, an invoice paid that morning was not yet counted,
// and one paid a year and a day ago still was.
describe('lateness is measured over the year to today where the user is', () => {
  const { _getOutstanding } = require('./summary');
  const paidOn = (due, paid) => inv({ status: 'PAID', amountDue: 0, dueDate: `${due}T00:00:00`, fullyPaidOnDate: `${paid}T00:00:00` });

  test('a payment made this morning in Singapore counts there before it is today in UTC; one read serves both', async () => {
    fakeNow('2026-10-12T17:30:00Z');   // 01:30 on the 13th in Singapore
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      paidOn('2026-09-01', '2026-09-11'),
      paidOn('2026-10-03', '2026-10-13'),   // today in Singapore, tomorrow in UTC
      inv({ dueDate: '2026-10-20T00:00:00' }),
    ] } });
    const sg   = await _getOutstanding(U, T, { timezone: 'Asia/Singapore' });
    const utc  = await _getOutstanding(U, T, { timezone: 'UTC' });
    const none = await _getOutstanding(U, T);
    expect(sg.lateness).toEqual({ 'ACCREC:c-acme': { days: 10, count: 2, average: 10 } });
    expect(utc.lateness).toEqual({});
    expect(none.lateness).toEqual({});
    expect(calls().invoices).toBe(1);
    // The open invoices are the same for every reader, and the history they are measured from stays inside.
    expect(sg.invoices).toEqual(utc.invoices);
    expect(sg).not.toHaveProperty('paidHistory');
  });

  test('and at the far end: the year back from Singapore\'s day leaves out a payment UTC\'s year still takes in', async () => {
    fakeNow('2026-10-12T17:30:00Z');
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      paidOn('2025-10-02', '2025-10-12'),   // 365 days before UTC's 12 Oct, 366 before Singapore's 13th
      paidOn('2026-09-01', '2026-09-11'),
    ] } });
    expect((await _getOutstanding(U, T, { timezone: 'UTC' })).lateness).toEqual({ 'ACCREC:c-acme': { days: 10, count: 2, average: 10 } });
    expect((await _getOutstanding(U, T, { timezone: 'Asia/Singapore' })).lateness).toEqual({});
  });

  test('the Dashboard\'s summary is the same whatever the lateness', async () => {
    fakeNow('2026-10-12T17:30:00Z');
    api.getInvoices.mockResolvedValue({ body: { invoices: [paidOn('2026-10-03', '2026-10-13'), inv({ dueDate: '2026-10-20T00:00:00' })] } });
    const s = await reports.getSummary(U, T, { timezone: 'Asia/Singapore' });
    expect(s.kpis).toMatchObject({ totalReceivables: 100, receivablesCount: 1, statusBreakdown: { paid: 1, awaiting: 1, overdue: 0 } });
  });
});

// The lateness was measured from each paid invoice's FullyPaidOnDate, which
// Xero's summaryOnly invoice list never sends (a live organisation: none of
// eleven paid invoices carried it), so the paid history was always empty and
// the Cash Flow Manager never placed an item on a predicted date. The day an
// invoice was paid now comes from its payments, read in the same cached fetch.
describe('the paid history is dated by Xero\'s payments', () => {
  const { _getOutstanding, _lastPaidOn, _paidHistoryOf } = require('./summary');
  const logger = require('../utils/logger');
  // A PAID invoice as the list sends it: no FullyPaidOnDate.
  const paid = (id, due, over = {}) => inv({ invoiceID: id, status: 'PAID', amountDue: 0, dueDate: `${due}T00:00:00`, ...over });
  const pay  = (invoiceID, date, over = {}) => ({
    paymentID: `p-${++seq}`, status: 'AUTHORISED', paymentType: 'ACCRECPAYMENT',
    date: `${date}T00:00:00`, amount: 50, invoice: { invoiceID }, ...over,
  });
  const supplier = { contactID: 's1', name: 'Supplier' };
  // 2026-10-12 in UTC: the history reaches back a year and two days, to 10 Oct 2025.
  const NOW   = '2026-10-12T17:30:00Z';
  const WHERE = 'Date >= DateTime(2025,10,10) && Status=="AUTHORISED"';

  test('a paid invoice without FullyPaidOnDate is dated by its last payment, and the contact has a lateness', async () => {
    fakeNow(NOW);
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      paid('a1', '2026-09-01'),
      paid('a2', '2026-10-01'),
      paid('a3', '2026-09-15'),                         // settled by a credit note alone: no payment, no day
      paid('b1', '2026-08-01', { type: 'ACCPAY', contact: supplier }),
      paid('b2', '2026-09-01', { type: 'ACCPAY', contact: supplier }),
      inv({ dueDate: '2026-10-20T00:00:00' }),
    ] } });
    api.getPayments.mockResolvedValue({ body: { payments: [
      pay('a1', '2026-09-11'),                          // the part that finished it, listed first
      pay('a1', '2026-09-05'),                          // a part payment before it
      pay('a2', '2026-10-09'),
      pay('b1', '2026-08-21', { paymentType: 'ACCPAYPAYMENT' }),
      pay('b2', '', { paymentType: 'ACCPAYPAYMENT', date: '/Date(1789948800000+0000)/' }),   // 21 Sep, as Xero's JSON dates it
    ] } });

    const out = await _getOutstanding(U, T, { timezone: 'UTC' });
    expect(out.lateness).toEqual({
      'ACCREC:c-acme': { days: 9, count: 2, average: 9 },   // 10 and 8 days late; a3 left out
      'ACCPAY:s1':     { days: 20, count: 2, average: 20 },
    });
    expect(out.invoices).toHaveLength(1);
    // One payments read, paged from page 1, over the history's span.
    expect(api.getPayments).toHaveBeenCalledTimes(1);
    expect(api.getPayments).toHaveBeenCalledWith(T, undefined, WHERE, 'Date DESC', 1);

    // Still one cached read per company, shared with the Dashboard's summary.
    const again = await _getOutstanding(U, T, { timezone: 'Asia/Singapore' });
    const s     = await reports.getSummary(U, T, { timezone: 'UTC' });
    expect(again.lateness).toEqual(out.lateness);
    expect(s.kpis).toMatchObject({ totalReceivables: 100, statusBreakdown: { paid: 5 } });
    expect(calls()).toEqual({ invoices: 1, credits: 1, payments: 1 });
  });

  test('the invoice\'s own FullyPaidOnDate wins over its payments when Xero sends it', async () => {
    fakeNow(NOW);
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      paid('a1', '2026-09-01', { fullyPaidOnDate: '2026-09-11T00:00:00' }),
      paid('a2', '2026-10-01', { fullyPaidOnDate: '2026-10-11T00:00:00' }),
    ] } });
    api.getPayments.mockResolvedValue({ body: { payments: [pay('a1', '2026-09-30'), pay('a2', '2026-10-01')] } });
    expect((await _getOutstanding(U, T, { timezone: 'UTC' })).lateness)
      .toEqual({ 'ACCREC:c-acme': { days: 10, count: 2, average: 10 } });
  });

  test('payments outside the year, or for an invoice not in the list or still open, change nothing', async () => {
    fakeNow(NOW);
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      paid('a1', '2026-09-01'),
      paid('a2', '2026-10-01'),
      paid('old', '2025-09-01'),                       // paid off 1 Oct 2025, before the history begins
      inv({ invoiceID: 'open', dueDate: '2026-09-01T00:00:00', amountDue: 40 }),   // part paid, still owed
    ] } });
    api.getPayments.mockResolvedValue({ body: { payments: [
      pay('a1', '2026-09-11'),
      pay('a2', '2026-10-11'),
      pay('old', '2025-10-01'),
      pay('gone', '2026-09-30'),                       // an invoice the list did not return
      pay('open', '2026-10-01'),
    ] } });
    const out = await _getOutstanding(U, T, { timezone: 'UTC' });
    expect(out.lateness).toEqual({ 'ACCREC:c-acme': { days: 10, count: 2, average: 10 } });
    expect(api.getPayments).toHaveBeenCalledWith(T, undefined, WHERE, 'Date DESC', 1);
  });

  test.each([
    ['fails', new Error(JSON.stringify({ response: { statusCode: 500 }, body: {} })), false],
    ['is refused for want of accounting.payments.read',
      new Error(JSON.stringify({ response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' } }, body: {} })), true],
  ])('a payments read that %s leaves no lateness; the summary and open invoices still come', async (_, err, scope) => {
    fakeNow(NOW);
    const warn = jest.spyOn(logger, 'warn');
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      paid('a1', '2026-09-01'), paid('a2', '2026-10-01'), inv({ dueDate: '2026-10-20T00:00:00' }),
    ] } });
    api.getPayments.mockRejectedValue(err);

    const out = await _getOutstanding(U, T, { timezone: 'UTC' });
    const s   = await reports.getSummary(U, T, { timezone: 'UTC' });
    expect(out.lateness).toEqual({});
    expect(out.invoices).toHaveLength(1);
    expect(s.kpis).toMatchObject({ totalReceivables: 100, receivablesCount: 1, statusBreakdown: { paid: 2, awaiting: 1 } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/payments unavailable/), expect.objectContaining({ tenantId: T, scope }));
    expect(calls()).toEqual({ invoices: 1, credits: 1, payments: 1 });
    warn.mockRestore();
  });

  test('_lastPaidOn: the latest payment per invoice; deleted ones, and refunds that pay no invoice, passed over', () => {
    const days = _lastPaidOn([
      pay('a1', '2026-09-05'), pay('a1', '2026-09-11'), pay('a1', '2026-09-08'),
      pay('a2', '2026-09-01'), pay('a2', '2026-09-20', { status: 'DELETED' }),
      pay(undefined, '2026-09-25', { invoice: undefined, paymentType: 'ARCREDITPAYMENT', creditNote: { creditNoteID: 'cn' } }),
      pay('a3', null),
      null,
    ]);
    expect(Object.fromEntries(days)).toEqual({ a1: '2026-09-11', a2: '2026-09-01' });
  });

  test('_paidHistoryOf keeps the compact shape _latenessOf reads, with no payments as before', () => {
    const list = [paid('a1', '2026-09-01'), paid('a2', '2026-09-01', { fullyPaidOnDate: '2026-09-04T00:00:00' })];
    expect(_paidHistoryOf(list, '2026-10-12')).toEqual([
      { status: 'PAID', type: 'ACCREC', dueDate: '2026-09-01', fullyPaidOnDate: '2026-09-04', contact: { contactID: 'c-acme', name: 'Acme' } },
    ]);
    expect(_paidHistoryOf(list, '2026-10-12', new Map([['a1', '2026-09-11']])).map(r => r.fullyPaidOnDate))
      .toEqual(['2026-09-11', '2026-09-04']);
  });
});

// The header showed every open invoice gross while the ageing, and Xero's
// Balance Sheet, took off the credit customers and suppliers had not yet used,
// so "Total Receivables" was higher than the ageing it opens.
describe('receivables and payables net unallocated credit notes, as the ageing does', () => {
  test('each total is the ageing\'s total to the cent; the counts stay invoice counts', async () => {
    fakeNow('2026-10-08T04:00:00Z');
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      inv({ amountDue: 1000.10 }),
      inv({ amountDue: 74.07, total: 74.07, currencyCode: 'USD', currencyRate: 0.7407 }),
      inv({ type: 'ACCPAY', amountDue: 500, contact: { contactID: 's1', name: 'Supplier' } }),
      inv({ status: 'PAID', amountDue: 0 }),
    ] } });
    api.getCreditNotes.mockResolvedValue({ body: { creditNotes: [
      credit({ remainingCredit: 30.33 }),
      credit({ remainingCredit: 7.41, currencyCode: 'USD', currencyRate: 0.741 }),
      credit({ type: 'ACCPAYCREDIT', remainingCredit: 120, contact: { contactID: 's1', name: 'Supplier' } }),
      credit({ status: 'PAID', remainingCredit: 0 }),          // fully used: nothing left to net
    ] } });

    const s  = await reports.getSummary(U, T, { timezone: 'Asia/Singapore' });
    const ar = await reports.getAgeing(U, T, { side: 'receivables', timezone: 'Asia/Singapore' });
    const ap = await reports.getAgeing(U, T, { side: 'payables', timezone: 'Asia/Singapore' });

    expect(s.kpis.totalReceivables).toBe(ar.total);
    expect(s.kpis.totalPayables).toBe(ap.total);
    expect(s.kpis.totalReceivables).toBe(1059.77);   // 1,000.10 + 100 (74.07 USD) - 30.33 - 10 (7.41 USD)
    expect(s.kpis.totalPayables).toBe(380);
    expect(s.kpis.creditsNetted).toEqual({ receivables: 40.33, payables: 120 });
    expect(s.kpis.creditsUnavailable).toBe(false);
    expect(s.kpis).toMatchObject({ receivablesCount: 2, payablesCount: 1 });
    // One read of the credit notes between them.
    expect(calls()).toEqual({ invoices: 1, credits: 1, payments: 1 });
  });

  test('credit notes that cannot be read leave the gross figure, flagged, and are asked for again next time', async () => {
    api.getInvoices.mockResolvedValue({ body: { invoices: [inv({ amountDue: 100 })] } });
    api.getCreditNotes.mockRejectedValueOnce(new Error('403 Forbidden'));
    api.getCreditNotes.mockResolvedValue({ body: { creditNotes: [credit({ remainingCredit: 30 })] } });

    const failed = await reports.getSummary(U, T, { timezone: 'Asia/Singapore' });
    expect(failed.kpis).toMatchObject({
      totalReceivables: 100, receivablesCount: 1,
      creditsUnavailable: true, creditsNetted: { receivables: 0, payables: 0 },
    });
    expect(failed.cached).toBe(false);

    const next = await reports.getSummary(U, T, { timezone: 'Asia/Singapore' });
    expect(next.kpis).toMatchObject({ totalReceivables: 70, creditsUnavailable: false, creditsNetted: { receivables: 30 } });
    expect(calls()).toEqual({ invoices: 1, credits: 2, payments: 1 });
  });
});
