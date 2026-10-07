const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// The Xero status read back onto records: the fields on every payload, the
// "Refresh from Xero" endpoint and its one-a-minute guard, and the submit
// route refusing a correction Xero would refuse. The read itself
// (xero/status-sync.js syncUser) and the Xero send are replaced, so nothing
// here reaches Xero; the re-post rule is the real one.
jest.mock('../utils/invoice-handler', () => ({
  submitInvoiceToXero: jest.fn(async () => null),
  postedDuplicateOf:   jest.fn(() => null),
}));
jest.mock('../xero/status-sync', () => ({
  ...jest.requireActual('../xero/status-sync'),
  syncUser: jest.fn(),
}));

describe('invoice routes and the Xero status', () => {
  let app, users, jwtSecret, testUser, store, handler, statusSync;
  let n = 0;

  beforeEach(async () => {
    jest.resetModules();
    jest.restoreAllMocks();
    require('../db/migrate').run();
    users        = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    handler      = require('../utils/invoice-handler');
    statusSync   = require('../xero/status-sync');
    handler.submitInvoiceToXero.mockReset().mockResolvedValue(null);
    statusSync.syncUser.mockReset().mockResolvedValue({ checked: 5, updated: 2, failedTenants: 1 });

    testUser = await users.createUser(`xst${++n}-${Date.now()}@test.com`, 'password123', 'user');
    store    = require('../utils/invoice-store').forUser(testUser.id);

    app = express();
    app.use(express.json());
    app.use('/api/invoices', require('./invoices'));
  });

  const tokenFor = u => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const auth = () => tokenFor(testUser);
  const posted = (id, xeroInvoiceId, extra = {}) => store.add({
    id, status: 'posted', vendorName: 'Acme', invoiceNumber: `N-${id}`, invoiceDate: '2026-09-01', totalAmount: 110,
    currency: 'SGD', xeroInvoiceId, xeroTenantId: 't-1', processedAt: new Date().toISOString(), ...extra,
  });
  const read = (id, xeroInvoiceId, status, extra = {}) =>
    store.recordXeroStatus(id, xeroInvoiceId, { status, amountDue: 110, amountPaid: 0, ...extra }, '2026-10-08T09:00:00.000Z');

  describe('POST /api/invoices/sync-xero-status', () => {
    test('needs a signed-in user', async () => {
      await request(serverFor(app)).post('/api/invoices/sync-xero-status').expect(401);
      expect(statusSync.syncUser).not.toHaveBeenCalled();
    });

    test("runs the read for the signed-in account and answers with the counts, and nothing else", async () => {
      const res = await request(serverFor(app)).post('/api/invoices/sync-xero-status').set('Authorization', auth()).expect(200);
      expect(res.body).toEqual({ checked: 5, updated: 2, failedTenants: 1 });
      expect(statusSync.syncUser).toHaveBeenCalledTimes(1);
      expect(String(statusSync.syncUser.mock.calls[0][0])).toBe(String(testUser.id));
    });

    test('a second run within 60 seconds is refused with 429 and says when to try again', async () => {
      const t0 = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const srv = serverFor(app);
      await request(srv).post('/api/invoices/sync-xero-status').set('Authorization', auth()).expect(200);

      clock.mockReturnValue(t0 + 45_000);
      const refused = await request(srv).post('/api/invoices/sync-xero-status').set('Authorization', auth()).expect(429);
      expect(refused.body.error).toBe('Statuses were refreshed from Xero less than a minute ago. Try again in 15 seconds.');
      expect(refused.headers['retry-after']).toBe('15');
      expect(statusSync.syncUser).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(t0 + 60_000);
      await request(srv).post('/api/invoices/sync-xero-status').set('Authorization', auth()).expect(200);
      expect(statusSync.syncUser).toHaveBeenCalledTimes(2);
    });

    test("one account's run does not hold up another's", async () => {
      const other = await users.createUser(`xso${++n}-${Date.now()}@test.com`, 'password123', 'user');
      const srv = serverFor(app);
      await request(srv).post('/api/invoices/sync-xero-status').set('Authorization', auth()).expect(200);
      await request(srv).post('/api/invoices/sync-xero-status').set('Authorization', tokenFor(other)).expect(200);
      expect(statusSync.syncUser).toHaveBeenCalledTimes(2);
    });
  });

  describe('the status on invoice payloads', () => {
    test('every list row and the single record carry the five fields; null until the first read', async () => {
      posted('fresh', 'x-1');
      posted('paid', 'x-2');
      read('paid', 'x-2', 'PAID', { amountDue: 0, amountPaid: 110, paidOn: '2026-09-15' });
      const srv = serverFor(app);

      const list = await request(srv).get('/api/invoices').set('Authorization', auth()).expect(200);
      const byId = Object.fromEntries(list.body.invoices.map(i => [i.id, i]));
      expect(byId.fresh).toMatchObject({ xeroStatus: null, xeroAmountDue: null, xeroAmountPaid: null, xeroPaidOn: null, xeroSyncedAt: null });
      expect(byId.paid).toMatchObject({
        xeroStatus: 'PAID', xeroAmountDue: 0, xeroAmountPaid: 110, xeroPaidOn: '2026-09-15', xeroSyncedAt: '2026-10-08T09:00:00.000Z',
      });

      const recent = await request(srv).get('/api/invoices?recent=5').set('Authorization', auth()).expect(200);
      expect(recent.body.invoices.find(i => i.id === 'paid')).toMatchObject({ xeroStatus: 'PAID', xeroAmountPaid: 110 });

      const one = await request(srv).get('/api/invoices/paid').set('Authorization', auth()).expect(200);
      expect(one.body.invoice).toMatchObject({ xeroStatus: 'PAID', xeroAmountDue: 0, xeroAmountPaid: 110, xeroPaidOn: '2026-09-15' });
    });
  });

  describe('POST /api/invoices/:id/submit once Xero has moved on', () => {
    test('a correction to a record approved in Xero is refused with the reason, and nothing is sent', async () => {
      posted('approved', 'x-1');
      read('approved', 'x-1', 'AUTHORISED');
      const res = await request(serverFor(app)).post('/api/invoices/approved/submit').set('Authorization', auth()).send({}).expect(409);
      expect(res.body.error).toMatch(/^Approved in Xero, so it can no longer be changed from here\./);
      expect(res.body.xeroStatus).toBe('AUTHORISED');
      expect(handler.submitInvoiceToXero).not.toHaveBeenCalled();
    });

    test('paid, part-paid, voided and deleted are refused too', async () => {
      const cases = [['PAID', {}, /^Paid in Xero/], ['AUTHORISED', { amountPaid: 50, amountDue: 60 }, /^Part-paid in Xero/],
        ['VOIDED', {}, /^Voided in Xero/], ['DELETED', {}, /^Deleted in Xero/], ['SUBMITTED', {}, /^Awaiting approval in Xero/]];
      const srv = serverFor(app);
      for (const [i, [status, extra, reason]] of cases.entries()) {
        posted(`r${i}`, `x-${i}`);
        read(`r${i}`, `x-${i}`, status, extra);
        const res = await request(srv).post(`/api/invoices/r${i}/submit`).set('Authorization', auth()).send({}).expect(409);
        expect(res.body.error).toMatch(reason);
      }
      expect(handler.submitInvoiceToXero).not.toHaveBeenCalled();
    });

    test('a draft in Xero, or a status not read yet, is sent as before', async () => {
      posted('draft', 'x-1');
      read('draft', 'x-1', 'DRAFT');
      posted('unknown', 'x-2');
      const srv = serverFor(app);
      await request(srv).post('/api/invoices/draft/submit').set('Authorization', auth()).send({}).expect(202);
      await request(srv).post('/api/invoices/unknown/submit').set('Authorization', auth()).send({}).expect(202);
      expect(handler.submitInvoiceToXero).toHaveBeenCalledTimes(2);
    });
  });
});
