// The Dashboard's header figures (summary.js): when an invoice turns overdue,
// and what the receivables and payables totals net off. Xero is mocked, as
// everywhere in this suite; nothing here reaches it.

jest.mock('xero-node', () => {
  const api = {
    getOrganisations: jest.fn(),
    getInvoices:      jest.fn(),
    getCreditNotes:   jest.fn(),
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
});
afterEach(() => jest.useRealTimers());

const calls = () => ({
  invoices: api.getInvoices.mock.calls.length,
  credits: api.getCreditNotes.mock.calls.length,
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
    expect(calls()).toEqual({ invoices: 1, credits: 1 });
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
    expect(calls()).toEqual({ invoices: 1, credits: 1 });
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
    expect(calls()).toEqual({ invoices: 1, credits: 2 });
  });
});
