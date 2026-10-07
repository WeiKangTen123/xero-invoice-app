// Reading back from Xero what became of posted records: grouped by company,
// asked 50 IDs at a time, If-Modified-Since from the last complete read, and
// stopped for a company by its daily limit. The SDK class is replaced by a
// small fake Xero (a book of invoices per company that answers getInvoices
// the way Xero does), so nothing here reaches Xero. The database, the token
// cache and withRetry are the real ones.
const mockGetInvoices = jest.fn();
jest.mock('xero-node', () => ({
  AccountingApi: jest.fn().mockImplementation(() => ({ getInvoices: mockGetInvoices })),
}));

const fs   = require('fs');
const path = require('path');

const HOUR = 60 * 60 * 1000;
let seq = 0;

// tenantId -> Map(invoiceID -> invoice as xero-node returns it)
const xero = new Map();
function inXero(tenantId, invoiceID, fields = {}, updatedAt) {
  if (!xero.has(tenantId)) xero.set(tenantId, new Map());
  xero.get(tenantId).set(invoiceID, { invoiceID, status: 'DRAFT', amountDue: 110, amountPaid: 0, total: 110, updatedDateUTC: new Date(updatedAt), ...fields });
}
// getInvoices(tenant, ifModifiedSince, where, order, iDs, invoiceNumbers,
//             contactIDs, statuses, page, includeArchived, createdByMyApp, unitdp, summaryOnly)
function fakeXero(tenantId, since, _where, _order, ids) {
  const book = xero.get(tenantId) || new Map();
  const found = (ids || []).map(id => book.get(id)).filter(Boolean)
    .filter(inv => !since || inv.updatedDateUTC >= since);
  return Promise.resolve({ body: { invoices: found.map(i => ({ ...i })) } });
}
const xid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const callsFor = tenantId => mockGetInvoices.mock.calls.filter(c => c[0] === tenantId);

// How xero-node rejects a 429 for the daily limit: its serialised error.
const dailyLimitRejection = tenantId => JSON.stringify({
  response: {
    statusCode: 429,
    headers: { 'x-rate-limit-problem': 'day', 'retry-after': '3600' },
    request: { headers: { 'xero-tenant-id': tenantId } },
  },
  body: { Title: 'Too Many Requests' },
});

describe('xero/status-sync', () => {
  let statusSync, invoiceStore, users, tokenCache, db, user, store, clock;
  const run = () => statusSync.syncUser(user.id, { now: () => new Date(clock) });

  beforeEach(async () => {
    jest.resetModules();
    mockGetInvoices.mockReset().mockImplementation(fakeXero);
    xero.clear();
    require('../db/migrate').run();
    db           = require('../db');
    users        = require('../utils/users');
    tokenCache   = require('../utils/token-cache');
    invoiceStore = require('../utils/invoice-store');
    statusSync   = require('./status-sync');
    user  = await users.createUser(`sync${++seq}-${Date.now()}@test.com`, 'password123', 'user');
    store = invoiceStore.forUser(user.id);
    clock = Date.now();
  });

  // A connected company with a live token, so getValidToken never reconnects.
  const connect = (tenantId, name = tenantId) =>
    tokenCache.forUser(user.id).cacheToken(tenantId, name, `token-${tenantId}`, Date.now() + HOUR, 'oauth');
  const posted = (id, xeroInvoiceId, tenantId, extra = {}) => store.add({
    id, status: 'posted', vendorName: 'Acme', invoiceNumber: `N-${id}`, totalAmount: 110, currency: 'SGD',
    xeroInvoiceId, xeroTenantId: tenantId, processedAt: new Date().toISOString(), ...extra,
  });
  const raw = id => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);

  test('asks each company about its own records only, 50 IDs to a call, summaryOnly', async () => {
    connect('t-A'); connect('t-B');
    for (let i = 1; i <= 120; i++) { posted(`a${i}`, xid(i), 't-A'); inXero('t-A', xid(i), {}, clock - HOUR); }
    for (let i = 201; i <= 203; i++) { posted(`b${i}`, xid(i), 't-B'); inXero('t-B', xid(i), {}, clock - HOUR); }

    const result = await run();

    expect(callsFor('t-A').map(c => c[4].length)).toEqual([50, 50, 20]);
    expect(callsFor('t-B').map(c => c[4].length)).toEqual([3]);
    expect(mockGetInvoices).toHaveBeenCalledTimes(4);
    // Every ID asked once, of the company that holds it.
    expect(callsFor('t-A').flatMap(c => c[4]).sort()).toEqual([...Array(120)].map((_, i) => xid(i + 1)).sort());
    expect(callsFor('t-B').flatMap(c => c[4])).toEqual([xid(201), xid(202), xid(203)]);
    for (const call of mockGetInvoices.mock.calls) {
      expect(call[1]).toBeUndefined();        // first read: no If-Modified-Since
      expect(call[12]).toBe(true);            // summaryOnly
      for (const i of [2, 3, 5, 6, 7, 8, 9, 10, 11]) expect(call[i]).toBeUndefined(); // no where, statuses, page...
    }
    expect(result).toEqual({ checked: 123, updated: 123, failedTenants: 0 });
  });

  test('stores the status, the amounts in cents and the paid-on day, and puts them on the record', async () => {
    connect('t-A');
    const t0 = clock - HOUR;
    posted('paid', xid(1), 't-A');
    posted('part', xid(2), 't-A');
    posted('waiting', xid(3), 't-A');
    posted('draft', xid(4), 't-A');
    inXero('t-A', xid(1), { status: 'PAID', amountDue: 0, amountPaid: 110, fullyPaidOnDate: new Date('2026-09-15T00:00:00Z') }, t0);
    inXero('t-A', xid(2), { status: 'AUTHORISED', amountDue: 60.5, amountPaid: 49.5 }, t0);
    inXero('t-A', xid(3), { status: 'SUBMITTED' }, t0);
    inXero('t-A', xid(4), {}, t0);
    const before = store.getById('paid').updatedAt;

    await run();

    const at = new Date(clock).toISOString();
    expect(store.getById('paid')).toMatchObject({
      status: 'posted', xeroStatus: 'PAID', xeroAmountDue: 0, xeroAmountPaid: 110, xeroPaidOn: '2026-09-15', xeroSyncedAt: at,
    });
    expect(store.getById('part')).toMatchObject({ xeroStatus: 'AUTHORISED', xeroAmountDue: 60.5, xeroAmountPaid: 49.5, xeroPaidOn: null });
    expect(store.getById('waiting')).toMatchObject({ xeroStatus: 'SUBMITTED', xeroAmountDue: 110, xeroAmountPaid: 0 });
    expect(store.getById('draft')).toMatchObject({ xeroStatus: 'DRAFT' });
    // Cents in the columns, like every other money column.
    expect(raw('part')).toMatchObject({ xero_amount_due: 6050, xero_amount_paid: 4950 });
    expect(raw('paid')).toMatchObject({ xero_amount_due: 0, xero_amount_paid: 11000, xero_paid_on: '2026-09-15' });
    // A check against Xero is not a person's edit.
    expect(store.getById('paid').updatedAt).toBe(before);
  });

  test('Xero dates and a summary without AmountPaid are read the same way', () => {
    const { fromXero } = statusSync;
    expect(fromXero({ status: 'PAID', amountDue: 0, amountPaid: 5, fullyPaidOnDate: '/Date(1757894400000+0000)/' }).paidOn).toBe('2025-09-15');
    expect(fromXero({ status: 'PAID', amountDue: 0, amountPaid: 5, fullyPaidOnDate: '2026-03-01T00:00:00' }).paidOn).toBe('2026-03-01');
    // Total = AmountDue + AmountPaid + AmountCredited.
    expect(fromXero({ status: 'AUTHORISED', total: 100, amountDue: 30, amountCredited: 20 }).amountPaid).toBe(50);
    expect(fromXero({ status: 'ARCHIVED' })).toBeNull();
    expect(fromXero({ status: 'AUTHORISED', amountDue: 10, amountPaid: 0, fullyPaidOnDate: '2026-01-01' }).paidOn).toBeNull();
  });

  test('the next read sends If-Modified-Since from the last complete one and leaves unchanged records alone', async () => {
    connect('t-A');
    const t0 = clock;
    for (let i = 1; i <= 3; i++) { posted(`r${i}`, xid(i), 't-A'); inXero('t-A', xid(i), {}, t0 - 24 * HOUR); }
    await run();
    const amountsBefore = raw('r1');

    // An hour later Xero approves r2; three hours later the next read.
    inXero('t-A', xid(2), { status: 'AUTHORISED' }, t0 + HOUR);
    clock = t0 + 3 * HOUR;
    mockGetInvoices.mockClear();
    const result = await run();

    expect(mockGetInvoices).toHaveBeenCalledTimes(1);
    const since = mockGetInvoices.mock.calls[0][1];
    expect(since).toBeInstanceOf(Date);                     // the SDK calls toISOString() on it
    expect(since.getTime()).toBe(t0 - statusSync.CLOCK_SLACK_MS);
    expect(mockGetInvoices.mock.calls[0][4]).toEqual([xid(1), xid(2), xid(3)]);

    expect(store.getById('r2').xeroStatus).toBe('AUTHORISED');
    // Unchanged: same status and amounts, and confirmed as of this read.
    for (const id of ['r1', 'r3']) {
      expect(raw(id)).toMatchObject({ xero_status: 'DRAFT', xero_amount_due: amountsBefore.xero_amount_due, xero_amount_paid: 0 });
      expect(store.getById(id).xeroSyncedAt).toBe(new Date(clock).toISOString());
    }
    expect(result).toEqual({ checked: 3, updated: 1, failedTenants: 0 });
  });

  test('a record never read before is asked without If-Modified-Since, in a call of its own', async () => {
    connect('t-A');
    posted('old', xid(1), 't-A'); inXero('t-A', xid(1), {}, clock - 48 * HOUR);
    await run();
    // Posted long ago, read for the first time now: If-Modified-Since would hide it.
    posted('new', xid(2), 't-A'); inXero('t-A', xid(2), { status: 'AUTHORISED' }, clock - 48 * HOUR);
    clock += 3 * HOUR;
    mockGetInvoices.mockClear();

    await run();

    const calls = mockGetInvoices.mock.calls.map(c => ({ since: c[1], ids: c[4] }));
    expect(calls).toEqual([{ since: undefined, ids: [xid(2)] }, { since: expect.any(Date), ids: [xid(1)] }]);
    expect(store.getById('new').xeroStatus).toBe('AUTHORISED');
  });

  test('a 304 to an If-Modified-Since read is "nothing changed", not a failure', async () => {
    connect('t-A');
    posted('r1', xid(1), 't-A'); inXero('t-A', xid(1), {}, clock - HOUR);
    await run();
    clock += HOUR;
    mockGetInvoices.mockImplementationOnce(() => Promise.reject(JSON.stringify({ response: { statusCode: 304 } })));
    await expect(run()).resolves.toEqual({ checked: 1, updated: 0, failedTenants: 0 });
    expect(store.getById('r1').xeroSyncedAt).toBe(new Date(clock).toISOString());
  });

  test('a record Xero does not return by its ID is left as it is; only Xero saying DELETED marks it', async () => {
    connect('t-A');
    posted('missing', xid(1), 't-A');                     // not in Xero's answer at all
    posted('gone', xid(2), 't-A'); inXero('t-A', xid(2), { status: 'DELETED', amountDue: 0 }, clock - HOUR);
    posted('void', xid(3), 't-A'); inXero('t-A', xid(3), { status: 'VOIDED', amountDue: 0 }, clock - HOUR);

    const result = await run();

    expect(store.getById('missing')).toMatchObject({ status: 'posted', xeroStatus: null, xeroSyncedAt: null });
    expect(store.getById('gone').xeroStatus).toBe('DELETED');
    expect(store.getById('void').xeroStatus).toBe('VOIDED');
    expect(result).toEqual({ checked: 2, updated: 2, failedTenants: 0 });

    // Voided and deleted are final in Xero, so they are not asked about again.
    // The one never found is, still without If-Modified-Since.
    clock += HOUR;
    mockGetInvoices.mockClear();
    await run();
    expect(mockGetInvoices.mock.calls.map(c => [c[1], c[4]])).toEqual([[undefined, [xid(1)]]]);
    expect(store.getById('missing').xeroStatus).toBeNull();
  });

  test('a record with no company recorded is asked of the only company, and learns it', async () => {
    connect('t-A');
    posted('legacy', xid(1), undefined); inXero('t-A', xid(1), { status: 'PAID', amountDue: 0, amountPaid: 110 }, clock - HOUR);
    await run();
    expect(callsFor('t-A')).toHaveLength(1);
    expect(store.getById('legacy')).toMatchObject({ xeroStatus: 'PAID', xeroTenantId: 't-A' });
  });

  test('with several companies it goes to the chosen default, and waits while none is chosen', async () => {
    connect('t-A'); connect('t-B');
    posted('legacy', xid(1), undefined); inXero('t-B', xid(1), { status: 'AUTHORISED' }, clock - HOUR);

    await expect(run()).resolves.toEqual({ checked: 0, updated: 0, failedTenants: 0 });
    expect(mockGetInvoices).not.toHaveBeenCalled();

    require('../utils/settings-store').forUser(user.id).set({ defaultTenantId: 't-B' });
    await run();
    expect(callsFor('t-B').map(c => c[4])).toEqual([[xid(1)]]);
    expect(store.getById('legacy')).toMatchObject({ xeroStatus: 'AUTHORISED', xeroTenantId: 't-B' });
  });

  test('a record whose company is no longer connected is not asked about', async () => {
    connect('t-A');
    posted('elsewhere', xid(1), 't-gone');
    await run();
    expect(mockGetInvoices).not.toHaveBeenCalled();
  });

  test("the daily limit stops that company for the run, the others carry on, and its read is not recorded", async () => {
    connect('t-A'); connect('t-B');
    for (let i = 1; i <= 60; i++) { posted(`a${i}`, xid(i), 't-A'); inXero('t-A', xid(i), {}, clock - HOUR); }
    posted('b1', xid(100), 't-B'); inXero('t-B', xid(100), { status: 'PAID', amountDue: 0, amountPaid: 110 }, clock - HOUR);
    mockGetInvoices.mockImplementation((tenantId, ...rest) => (tenantId === 't-A'
      ? Promise.reject(dailyLimitRejection('t-A'))
      : fakeXero(tenantId, ...rest)));

    const result = await run();

    // One call for A: the refusal is not retried and its second batch never goes.
    expect(callsFor('t-A')).toHaveLength(1);
    expect(callsFor('t-B')).toHaveLength(1);
    expect(result).toEqual({ checked: 1, updated: 1, failedTenants: 1 });
    expect(store.getById('a1').xeroStatus).toBeNull();
    expect(store.getById('b1').xeroStatus).toBe('PAID');
    const reads = db.prepare('SELECT tenant_id FROM xero_status_sync WHERE user_id = ?').all(user.id).map(r => r.tenant_id);
    expect(reads).toEqual(['t-B']);

    // Until Xero's reset time, A is not asked again at all.
    mockGetInvoices.mockClear();
    clock += 10 * 60 * 1000;
    await expect(run()).resolves.toMatchObject({ failedTenants: 1 });
    expect(callsFor('t-A')).toHaveLength(0);
    expect(callsFor('t-B')).toHaveLength(1);
  });

  test('a connection Xero refuses stops the run for every company', async () => {
    const { XeroReconnectError } = require('./xero-utils');
    connect('t-A'); connect('t-B');
    posted('a', xid(1), 't-A'); posted('b', xid(2), 't-B');
    mockGetInvoices.mockImplementation(() => Promise.reject(new XeroReconnectError('revoked')));

    await expect(run()).resolves.toEqual({ checked: 0, updated: 0, failedTenants: 2 });
    expect(mockGetInvoices).toHaveBeenCalledTimes(1);
  });

  test('one run per user at a time: a second call gets the run in progress', async () => {
    connect('t-A');
    posted('r1', xid(1), 't-A'); inXero('t-A', xid(1), {}, clock - HOUR);
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toBe(b);
    expect(mockGetInvoices).toHaveBeenCalledTimes(1);
  });

  test('nothing posted, or nothing connected, costs no call', async () => {
    connect('t-A');
    await expect(run()).resolves.toEqual({ checked: 0, updated: 0, failedTenants: 0 });
    tokenCache.forUser(user.id).removeTenant('t-A');
    posted('r1', xid(1), 't-A');
    await expect(run()).resolves.toEqual({ checked: 0, updated: 0, failedTenants: 0 });
    expect(mockGetInvoices).not.toHaveBeenCalled();
  });

  test('never writes to Xero: getInvoices is the only SDK call in the module', () => {
    const src = fs.readFileSync(path.join(__dirname, 'status-sync.js'), 'utf8');
    expect([...new Set([...src.matchAll(/\bapi\.(\w+)\(/g)].map(m => m[1]))]).toEqual(['getInvoices']);
    expect(src).not.toMatch(/require\(['"]axios['"]\)/);
  });
});

describe('xero/status-sync — repostRefusal', () => {
  const { repostRefusal } = require('./status-sync');
  const inv = extra => ({ xeroInvoiceId: 'x-1', ...extra });

  test('a draft, a status not read yet, or a record not in Xero can still be re-posted', () => {
    expect(repostRefusal(inv({ xeroStatus: 'DRAFT' }))).toBeNull();
    expect(repostRefusal(inv({ xeroStatus: null }))).toBeNull();
    expect(repostRefusal({ xeroStatus: 'AUTHORISED' })).toBeNull();
  });

  test('anything past DRAFT is refused with the reason', () => {
    expect(repostRefusal(inv({ xeroStatus: 'AUTHORISED' }))).toBe('Approved in Xero, so it can no longer be changed from here');
    expect(repostRefusal(inv({ xeroStatus: 'AUTHORISED', xeroAmountPaid: 10 }))).toBe('Part-paid in Xero, so it can no longer be changed from here');
    expect(repostRefusal(inv({ xeroStatus: 'SUBMITTED' }))).toMatch(/^Awaiting approval in Xero/);
    expect(repostRefusal(inv({ xeroStatus: 'PAID' }))).toMatch(/^Paid in Xero/);
    expect(repostRefusal(inv({ xeroStatus: 'VOIDED' }))).toMatch(/^Voided in Xero/);
    expect(repostRefusal(inv({ xeroStatus: 'DELETED' }))).toMatch(/^Deleted in Xero/);
  });
});
