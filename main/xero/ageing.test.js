// Receivables and payables ageing: the buckets, what is netted, currencies,
// grouping, the caps, and what it costs in Xero calls. Xero is mocked, as
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
const { _buildAgeing, _creditsOf, _bucketOf, _daysBetween, _asOf, CONTACT_LIMIT, INVOICE_LIMIT } = require('./ageing');
const { _outstandingOf } = require('./summary');

const TODAY = '2026-10-08';
// The calendar day `n` days before TODAY, as Xero's summaryOnly invoices give
// it ("2026-10-08T00:00:00").
function daysAgo(n, from = TODAY) {
  const [y, m, d] = from.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - n));
  return `${t.toISOString().slice(0, 10)}T00:00:00`;
}

let seq = 0;
function inv(over = {}) {
  seq++;
  return {
    invoiceID: `inv-${seq}`, type: 'ACCREC', status: 'AUTHORISED',
    invoiceNumber: `INV-${String(seq).padStart(4, '0')}`, reference: `ref ${seq}`,
    contact: { contactID: 'c-acme', name: 'Acme' },
    date: daysAgo(40), dueDate: daysAgo(10),
    total: 100, amountDue: 100, currencyCode: 'SGD',
    ...over,
  };
}
function credit(over = {}) {
  seq++;
  return {
    creditNoteID: `cn-${seq}`, type: 'ACCRECCREDIT', status: 'AUTHORISED',
    creditNoteNumber: `CN-${String(seq).padStart(4, '0')}`, reference: '',
    contact: { contactID: 'c-acme', name: 'Acme' },
    date: daysAgo(5), total: 30, remainingCredit: 30, currencyCode: 'SGD',
    ...over,
  };
}
// Through summary.js#_outstandingOf and _creditsOf, as the fetched path goes.
// credits: null is credit notes that could not be read.
const build = (invoices, { credits = [], ...opts } = {}) => _buildAgeing({
  side: 'receivables', outstanding: _outstandingOf(invoices), credits: credits === null ? null : _creditsOf(credits),
  baseCurrency: 'SGD', todayISO: TODAY, ...opts,
});
const bucket = (a, key) => a.buckets.find(b => b.key === key);

describe('buckets: days past the due date, as of today', () => {
  test.each([
    [-5, 'current'],     // not yet due
    [0, 'current'],      // due today is not late
    [1, 'd1_30'],
    [30, 'd1_30'],
    [31, 'd31_60'],
    [60, 'd31_60'],
    [61, 'd61_90'],
    [90, 'd61_90'],
    [91, 'd90plus'],
    [400, 'd90plus'],
  ])('%i days past due is %s', (days, key) => {
    const a = build([inv({ dueDate: daysAgo(days) })]);
    expect(a.contacts[0].invoices[0]).toMatchObject({ daysOverdue: days, bucket: key });
    expect(bucket(a, key).amount).toBe(100);
    expect(a.total).toBe(100);
  });

  test('the five buckets, in order, with labels', () => {
    const a = build([]);
    expect(a.buckets.map(b => b.key)).toEqual(['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus']);
    expect(a.buckets.map(b => b.short)).toEqual(['Current', '1–30', '31–60', '61–90', '90+']);
  });

  test('due dates are calendar days, whichever form Xero sends them in', () => {
    // A Date at UTC midnight is what xero-node makes of "/Date(...)/".
    const asDate = new Date(Date.UTC(2026, 8, 7));                    // 7 Sep: 31 days
    const a = build([
      inv({ dueDate: asDate }),
      inv({ dueDate: '/Date(1788739200000+0000)/' }),                    // 7 Sep 2026
      inv({ dueDate: '2026-09-08' }),                                     // 30 days
    ]);
    expect(a.contacts[0].invoices.map(i => [i.dueDate, i.bucket])).toEqual([
      ['2026-09-07', 'd31_60'], ['2026-09-07', 'd31_60'], ['2026-09-08', 'd1_30'],
    ]);
  });

  test('an invoice with no due date is counted as current, not guessed late', () => {
    const a = build([inv({ dueDate: null })]);
    expect(a.contacts[0].invoices[0]).toMatchObject({ daysOverdue: null, bucket: 'current' });
  });

  test('_bucketOf and _daysBetween at the edges', () => {
    expect(_bucketOf(null)).toBe('current');
    expect(_daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(_daysBetween('2028-02-28', '2028-03-01')).toBe(2);           // leap year
    expect(_daysBetween('2026-03-28', '2026-03-30')).toBe(2);           // across a DST change
  });
});

describe('today is the user\'s today', () => {
  afterEach(() => jest.useRealTimers());

  test('at 01:30 on the 8th in Singapore it is still the 7th in UTC and in Los Angeles', () => {
    jest.useFakeTimers({ now: new Date('2026-10-07T17:30:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
    expect(_asOf('Asia/Singapore')).toBe('2026-10-08');
    expect(_asOf('UTC')).toBe('2026-10-07');
    expect(_asOf('America/Los_Angeles')).toBe('2026-10-07');
  });
});

describe('what counts as outstanding', () => {
  test('a part-paid invoice counts what is still due, not its total', () => {
    const a = build([inv({ total: 1000, amountDue: 250 })]);
    expect(a.total).toBe(250);
    expect(a.contacts[0].invoices[0].amountDue).toBe(250);
  });

  test('voided, paid, draft, submitted and deleted invoices are left out, and so is one paid down to nothing', () => {
    const a = build([
      inv({ status: 'VOIDED' }), inv({ status: 'PAID', amountDue: 0 }), inv({ status: 'DRAFT' }),
      inv({ status: 'SUBMITTED' }), inv({ status: 'DELETED' }), inv({ amountDue: 0 }),
      inv({ amountDue: 40 }),
    ]);
    expect(a.count).toBe(1);
    expect(a.total).toBe(40);
  });

  test('each side reads only its own documents', () => {
    const docs = [
      inv({ type: 'ACCREC', amountDue: 100 }),
      inv({ type: 'ACCPAY', amountDue: 70, contact: { contactID: 'c-sup', name: 'Supplier' } }),
    ];
    const credits = [credit({ type: 'ACCPAYCREDIT', remainingCredit: 20, contact: { contactID: 'c-sup', name: 'Supplier' } })];
    const ar = build(docs, { credits });
    const ap = build(docs, { credits, side: 'payables' });
    expect(ar).toMatchObject({ side: 'receivables', total: 100, credits: { count: 0, amount: 0 } });
    expect(ap).toMatchObject({ side: 'payables', total: 50, gross: 70, credits: { count: 1, amount: 20 } });
    expect(ap.contacts.map(c => c.name)).toEqual(['Supplier']);
  });

  test('an unknown side is refused', () => {
    expect(() => build([], { side: 'both' })).toThrow(/Unknown ageing side/);
  });
});

describe('credit notes are netted', () => {
  test('an unallocated credit note comes off its contact, in the column for its own date', () => {
    const a = build([inv({ amountDue: 100, dueDate: daysAgo(45) })], { credits: [credit({ remainingCredit: 30, date: daysAgo(5) })] });
    expect(a).toMatchObject({ total: 70, gross: 100, credits: { netted: true, count: 1, amount: 30 } });
    expect(bucket(a, 'd31_60').amount).toBe(100);
    expect(bucket(a, 'd1_30').amount).toBe(-30);
    const acme = a.contacts[0];
    expect(acme).toMatchObject({ total: 70, count: 1, credits: 1, buckets: { d31_60: 100, d1_30: -30 } });
    expect(acme.invoices.map(r => [r.kind, r.amountDue])).toEqual([['invoice', 100], ['credit-note', -30]]);
    expect(a.notes.join(' ')).toMatch(/1 unallocated credit note is subtracted/);
  });

  test('only the credit still unallocated counts; a used-up, voided or draft note does not', () => {
    const notes = _creditsOf([
      credit({ remainingCredit: 12.5 }),
      credit({ status: 'PAID', remainingCredit: 0 }),
      credit({ status: 'AUTHORISED', remainingCredit: 0 }),
      credit({ status: 'VOIDED', remainingCredit: 30 }),
      credit({ status: 'DRAFT', remainingCredit: 30 }),
    ]);
    expect(notes.map(n => n.remainingCredit)).toEqual([12.5]);
  });

  test('a contact holding only a credit is listed with what it is owed back, below those who owe', () => {
    const a = build([inv({ amountDue: 10 })], { credits: [credit({ remainingCredit: 25, contact: { contactID: 'c-zed', name: 'Zed' } })] });
    expect(a.contacts.map(c => [c.name, c.total, c.count])).toEqual([['Acme', 10, 1], ['Zed', -25, 0]]);
    expect(a.total).toBe(-15);
  });

  test('when credit notes could not be read nothing is netted, and the payload says so', () => {
    const a = build([inv({ amountDue: 100 })], { credits: null });
    expect(a.credits).toEqual({ netted: false, count: 0, amount: 0 });
    expect(a.total).toBe(100);
    expect(a.notes.join(' ')).toMatch(/Credit notes could not be read/);
  });

  test('overpayments and prepayments are said plainly not to be netted', () => {
    const a = build([inv()]);
    expect(a.overpaymentsNetted).toBe(false);
    expect(a.notes.join(' ')).toMatch(/overpayments and prepayments are not subtracted/);
  });
});

describe('currencies', () => {
  test('a foreign invoice is converted at its own rate and flagged, with its face amount kept', () => {
    // Xero's rate is document units per base unit: 100 USD at 0.75 is 133.33 SGD.
    const a = build([inv({ amountDue: 100, currencyCode: 'USD', currencyRate: 0.75 }), inv({ amountDue: 50 })]);
    const [usd, sgd] = a.contacts[0].invoices;
    expect(usd).toMatchObject({ amountDue: 100, currency: 'USD', amountDueBase: 133.33, foreign: true });
    expect(sgd).toMatchObject({ amountDue: 50, currency: 'SGD', amountDueBase: 50, foreign: false });
    expect(a.contacts[0].foreign).toBe(true);
    expect(a.total).toBe(183.33);
    expect(a.currency).toBe('SGD');
    expect(a.foreignCurrency).toMatchObject({ mixed: true, currencies: ['USD'], unconvertible: 0 });
    expect(a.notes.join(' ')).toMatch(/USD are converted to SGD/);
  });

  test('a foreign credit note is converted the same way', () => {
    const a = build([inv({ amountDue: 100 })], { credits: [credit({ remainingCredit: 15, currencyCode: 'USD', currencyRate: 0.75 })] });
    expect(a.credits.amount).toBe(20);
    expect(a.total).toBe(80);
  });

  test('a foreign document with no rate is counted at face value and counted as unconvertible', () => {
    const a = build([inv({ amountDue: 100, currencyCode: 'EUR', currencyRate: null })]);
    expect(a.total).toBe(100);
    expect(a.foreignCurrency.unconvertible).toBe(1);
    expect(a.notes.join(' ')).toMatch(/1 had no rate and is counted at face value/);
  });

  test('a single-currency organisation gets no currency note', () => {
    const a = build([inv()]);
    expect(a.foreignCurrency.mixed).toBe(false);
    expect(a.notes.join(' ')).not.toMatch(/converted/);
  });

  test('cents add up exactly: the buckets, the contacts and the total agree', () => {
    const a = build([inv({ amountDue: 0.1 }), inv({ amountDue: 0.2, dueDate: daysAgo(70) }),
                     inv({ amountDue: 10, currencyCode: 'USD', currencyRate: 0.3 })]);
    const sumBuckets = a.buckets.reduce((s, b) => s + Math.round(b.amount * 100), 0);
    expect(sumBuckets).toBe(Math.round(a.total * 100));
    expect(a.total).toBe(33.63);   // 0.10 + 0.20 + 33.33
  });
});

describe('by contact', () => {
  test('grouped by Xero contact id, sorted by total, largest first, with oldest due date and count', () => {
    const a = build([
      inv({ contact: { contactID: 'c1', name: 'Smith' }, amountDue: 50, dueDate: daysAgo(3) }),
      inv({ contact: { contactID: 'c2', name: 'Smith' }, amountDue: 500, dueDate: daysAgo(100) }),
      inv({ contact: { contactID: 'c1', name: 'Smith' }, amountDue: 60, dueDate: daysAgo(20) }),
      inv({ contact: { contactID: 'c3', name: 'Brown' }, amountDue: 200 }),
    ]);
    expect(a.contacts.map(c => [c.contactId, c.name, c.total, c.count])).toEqual([
      ['c2', 'Smith', 500, 1], ['c3', 'Brown', 200, 1], ['c1', 'Smith', 110, 2],
    ]);
    expect(a.contacts[2].oldestDue).toBe(daysAgo(20).slice(0, 10));
    expect(a.contacts[2].buckets).toEqual({ current: 0, d1_30: 110, d31_60: 0, d61_90: 0, d90plus: 0 });
    expect(a.contactCount).toBe(3);
    expect(a.count).toBe(4);
  });

  test('equal totals go by name, so the order is stable', () => {
    const a = build([
      inv({ contact: { contactID: 'z', name: 'Zeta' } }), inv({ contact: { contactID: 'a', name: 'Alpha' } }),
    ]);
    expect(a.contacts.map(c => c.name)).toEqual(['Alpha', 'Zeta']);
  });

  test('each contact\'s documents are listed oldest first, with what the screen needs', () => {
    const a = build([inv({ dueDate: daysAgo(2), invoiceNumber: 'B' }), inv({ dueDate: daysAgo(64), invoiceNumber: 'A', reference: 'PO 7' })]);
    expect(a.contacts[0].invoices[0]).toEqual({
      kind: 'invoice', id: expect.any(String), number: 'A', reference: 'PO 7',
      date: daysAgo(40).slice(0, 10), dueDate: daysAgo(64).slice(0, 10), daysOverdue: 64, bucket: 'd61_90',
      amountDue: 100, currency: 'SGD', amountDueBase: 100, foreign: false,
    });
    expect(a.contacts[0].invoices[1].number).toBe('B');
  });
});

describe('caps', () => {
  test('past the contact limit the rest are one row, and every bucket still adds up to the total', () => {
    const invoices = [];
    for (let i = 1; i <= 5; i++) invoices.push(inv({ contact: { contactID: `c${i}`, name: `C${i}` }, amountDue: i * 10, dueDate: daysAgo(i * 25) }));
    const a = build(invoices, { contactLimit: 2 });
    expect(a.contacts.map(c => c.name)).toEqual(['C5', 'C4']);
    expect(a.others).toEqual({
      contactCount: 3, total: 60, count: 3,
      buckets: { current: 0, d1_30: 10, d31_60: 20, d61_90: 30, d90plus: 0 },
    });
    const shownPlusOthers = a.contacts.reduce((s, c) => s + c.total, 0) + a.others.total;
    expect(shownPlusOthers).toBe(a.total);
    expect(a.limits).toEqual({ contacts: 2, invoicesPerContact: INVOICE_LIMIT });
    expect(a.notes.join(' ')).toMatch(/The 2 largest balances of 5 contacts are listed; the other 3/);
  });

  test('a contact\'s list keeps its oldest documents and says how many more there are', () => {
    const a = build([inv({ dueDate: daysAgo(1) }), inv({ dueDate: daysAgo(99) }), inv({ dueDate: daysAgo(50) })], { invoiceLimit: 2 });
    const c = a.contacts[0];
    expect(c.invoices.map(i => i.daysOverdue)).toEqual([99, 50]);
    expect(c.invoicesOmitted).toBe(1);
    expect(c.total).toBe(300);
    expect(a.notes.join(' ')).toMatch(/lists its 2 oldest documents/);
  });

  test('no caps note when nothing was cut, and sensible defaults', () => {
    const a = build([inv()]);
    expect(a.others).toBeNull();
    expect(a.contacts[0].invoicesOmitted).toBe(0);
    expect(a.notes.join(' ')).not.toMatch(/largest balances|oldest documents/);
    expect(CONTACT_LIMIT).toBeGreaterThanOrEqual(20);
    expect(INVOICE_LIMIT).toBeGreaterThanOrEqual(10);
  });

  test('nothing outstanding is an empty, well-formed payload', () => {
    const a = build([]);
    expect(a).toMatchObject({ total: 0, gross: 0, count: 0, contactCount: 0, contacts: [], others: null });
    expect(a.buckets.every(b => b.amount === 0 && b.count === 0)).toBe(true);
  });
});

// ── Fetched: what it costs in Xero calls ────────────────────────────────────
describe('getAgeing — Xero calls', () => {
  const U = 'u-age';
  let n = 0;
  let T;
  const ORG = { name: 'Org', baseCurrency: 'SGD' };

  beforeEach(() => {
    jest.clearAllMocks();
    reports._cache.clear();
    T = `t-age-${++n}`;
    api.getOrganisations.mockResolvedValue({ body: { organisations: [ORG] } });
    api.getInvoices.mockResolvedValue({ body: { invoices: [
      inv({ amountDue: 100, dueDate: daysAgo(45, new Date().toISOString().slice(0, 10)) }),
      inv({ type: 'ACCPAY', amountDue: 70, contact: { contactID: 's1', name: 'Supplier' } }),
      inv({ status: 'PAID', amountDue: 0 }),
    ] } });
    api.getCreditNotes.mockResolvedValue({ body: { creditNotes: [credit({ remainingCredit: 30 })] } });
  });
  afterEach(() => jest.useRealTimers());

  const calls = () => ({
    org: api.getOrganisations.mock.calls.length,
    invoices: api.getInvoices.mock.calls.length,
    credits: api.getCreditNotes.mock.calls.length,
  });

  test('cold: the summary\'s fetch plus one page of credit notes, asked for by status', async () => {
    const a = await reports.getAgeing(U, T, { side: 'receivables', timezone: 'UTC' });
    expect(calls()).toEqual({ org: 1, invoices: 1, credits: 1 });
    expect(a).toMatchObject({ side: 'receivables', currency: 'SGD', total: 70, gross: 100, cached: false });
    expect(typeof a.fetchedAt).toBe('number');
    const [tenant, since, where, order, page] = api.getCreditNotes.mock.calls[0];
    expect([tenant, since, where, order, page]).toEqual([T, undefined, 'Status=="AUTHORISED"', 'Date DESC', 1]);
  });

  test('a repeat, and the other side, cost no Xero call at all', async () => {
    await reports.getAgeing(U, T, { side: 'receivables', timezone: 'UTC' });
    const again = await reports.getAgeing(U, T, { side: 'receivables', timezone: 'UTC' });
    const ap    = await reports.getAgeing(U, T, { side: 'payables', timezone: 'Asia/Singapore' });
    expect(calls()).toEqual({ org: 1, invoices: 1, credits: 1 });
    expect(again.cached).toBe(true);
    expect(ap).toMatchObject({ side: 'payables', total: 70, cached: true });
  });

  test('after the dashboard\'s summary has loaded, the ageing costs only the credit notes, and the summary nothing after it', async () => {
    await reports.getSummary(U, T, { force: false });
    expect(calls()).toEqual({ org: 1, invoices: 1, credits: 0 });
    await reports.getAgeing(U, T, { side: 'receivables' });
    expect(calls()).toEqual({ org: 1, invoices: 1, credits: 1 });
    const summary = await reports.getSummary(U, T, { force: false });
    expect(summary.cached).toBe(true);
    expect(calls()).toEqual({ org: 1, invoices: 1, credits: 1 });
  });

  test('the summary and both sides asked for at once share one fetch of each', async () => {
    await Promise.all([
      reports.getSummary(U, T, { force: false }),
      reports.getAgeing(U, T, { side: 'receivables' }),
      reports.getAgeing(U, T, { side: 'payables' }),
    ]);
    expect(calls()).toEqual({ org: 1, invoices: 1, credits: 1 });
  });

  test('the ageing and the headline receivables are the same invoices', async () => {
    const [summary, a] = await Promise.all([
      reports.getSummary(U, T, { force: false }),
      reports.getAgeing(U, T, { side: 'receivables' }),
    ]);
    expect(a.gross).toBe(summary.kpis.totalReceivables);
    expect(a.count).toBe(summary.kpis.receivablesCount);
  });

  test('force within seconds of a fetch reuses it; past the grace window it reads both again', async () => {
    await reports.getAgeing(U, T, { side: 'receivables' });
    await reports.getAgeing(U, T, { side: 'receivables', force: true });
    expect(calls()).toEqual({ org: 1, invoices: 1, credits: 1 });
    for (const [k, v] of reports._cache) if (k.includes(`:${U}:${T}`)) v.fetchedAt -= reports.FORCE_GRACE_MS + 1;
    const a = await reports.getAgeing(U, T, { side: 'receivables', force: true });
    expect(calls()).toEqual({ org: 2, invoices: 2, credits: 2 });
    expect(a.cached).toBe(false);
  });

  test('credit notes that cannot be read cost the netting, not the view, and are asked for again next time', async () => {
    api.getCreditNotes.mockRejectedValueOnce(new Error('403 Forbidden'));
    const a = await reports.getAgeing(U, T, { side: 'receivables' });
    expect(a).toMatchObject({ total: 100, credits: { netted: false } });
    const b = await reports.getAgeing(U, T, { side: 'receivables' });
    expect(b).toMatchObject({ total: 70, credits: { netted: true, count: 1 } });
    expect(calls()).toEqual({ org: 1, invoices: 1, credits: 2 });
  });

  test('a summary cached without its outstanding list is fetched again, never read as nothing owed', async () => {
    await reports.getSummary(U, T, { force: false });
    reports._cache.delete(`outstanding:${U}:${T}`);
    const a = await reports.getAgeing(U, T, { side: 'receivables' });
    expect(a.total).toBe(70);
    expect(calls().invoices).toBe(2);
  });

  test('an invoice fetch stopped at the page cap is said to be incomplete', async () => {
    const page = Array.from({ length: reports.LIST_PAGE_SIZE }, () => inv());
    api.getInvoices.mockResolvedValue({ body: { invoices: page } });
    const a = await reports.getAgeing(U, T, { side: 'receivables' });
    expect(api.getInvoices).toHaveBeenCalledTimes(reports.LIST_MAX_PAGES);
    expect(a.incomplete).toBe(true);
    expect(a.notes.join(' ')).toMatch(/oldest unpaid ones may be missing/);
  });

  test('an invoice due "yesterday" in UTC is a day late in Singapore and due today in Los Angeles', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-07T17:30:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
    api.getInvoices.mockResolvedValue({ body: { invoices: [inv({ dueDate: '2026-10-07T00:00:00', amountDue: 100 })] } });
    api.getCreditNotes.mockResolvedValue({ body: { creditNotes: [] } });
    const sg = await reports.getAgeing(U, T, { side: 'receivables', timezone: 'Asia/Singapore' });
    const la = await reports.getAgeing(U, T, { side: 'receivables', timezone: 'America/Los_Angeles' });
    expect(sg).toMatchObject({ asOf: '2026-10-08', timezone: 'Asia/Singapore' });
    expect(sg.contacts[0].invoices[0]).toMatchObject({ daysOverdue: 1, bucket: 'd1_30' });
    expect(la).toMatchObject({ asOf: '2026-10-07' });
    expect(la.contacts[0].invoices[0]).toMatchObject({ daysOverdue: 0, bucket: 'current' });
    // Both from the one fetch: the day moved, not the data.
    expect(calls()).toEqual({ org: 1, invoices: 1, credits: 1 });
  });

  test('an unknown side never reaches Xero', async () => {
    await expect(reports.getAgeing(U, T, { side: 'all' })).rejects.toThrow(/Unknown ageing side/);
    expect(calls()).toEqual({ org: 0, invoices: 0, credits: 0 });
  });
});

// The SDK's getCreditNotes takes where, order and page in the slots the call
// above fills. sdk-contract.test.js pins the other methods the same way.
describe('xero-node getCreditNotes argument positions', () => {
  test('where, order and page are the 3rd, 4th and 5th arguments', () => {
    const { AccountingApi } = jest.requireActual('xero-node');
    const src = AccountingApi.prototype.getCreditNotes.toString();
    const params = /^[^(]*\(([^)]*)\)/.exec(src)[1].split(',')
      .map(p => p.trim().replace(/\s*=.*$/, '').replace(/_1$/, '')).filter(p => p && p !== 'options');
    expect(params.slice(0, 5)).toEqual(['xeroTenantId', 'ifModifiedSince', 'where', 'order', 'page']);
  });
});
