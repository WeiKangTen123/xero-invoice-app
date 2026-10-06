const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// What the invoice routes may and may not do to a record that is in Xero, and
// what Submit all sends. The Xero send itself is replaced so that nothing here
// reaches Xero; the duplicate check the submit route uses stays real.
jest.mock('../utils/invoice-handler', () => ({
  submitInvoiceToXero: jest.fn(async () => null),
  postedDuplicateOf:   jest.requireActual('../utils/invoice-handler').postedDuplicateOf,
}));

describe('invoice routes and records in Xero', () => {
  let app, users, jwtSecret, testUser, invoiceStore, handler, store;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users        = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    invoiceStore = require('../utils/invoice-store');
    handler      = require('../utils/invoice-handler');
    handler.submitInvoiceToXero.mockReset().mockResolvedValue(null);
    const invoiceRoutes = require('./invoices');

    testUser = await users.createUser(`xs${Date.now()}@test.com`, 'password123', 'user');
    store    = invoiceStore.forUser(testUser.id);

    app = express();
    app.use(express.json());
    app.use('/api/invoices', invoiceRoutes);
  });

  const auth = () => `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`;
  const add = (id, extra = {}) => store.add({
    id, status: 'pending', vendorName: 'Acme', invoiceNumber: `N-${id}`, invoiceDate: '2026-09-01',
    totalAmount: 10, processedAt: new Date().toISOString(), ...extra,
  });
  const waitFor = async (check, ms = 5000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise(r => setTimeout(r, 25));
    }
  };

  describe('POST /api/invoices/submit-all', () => {
    test('ids are required and must be a non-empty list', async () => {
      for (const body of [{}, { ids: [] }, { ids: 'a' }, { ids: [1] }, { ids: [''] }]) {
        await request(serverFor(app)).post('/api/invoices/submit-all').set('Authorization', auth()).send(body).expect(400);
      }
      expect(handler.submitInvoiceToXero).not.toHaveBeenCalled();
    });

    // It used to send every pending record of every kind, while the banner
    // that offered it counted only the open tab.
    test('sends only the given ids that are this user\'s and pending, and says how many it skipped', async () => {
      add('p1'); add('p2');
      add('posted', { status: 'posted', xeroInvoiceId: 'xero-1' });
      add('review', { status: 'review-needed' });
      add('not-asked');                       // pending, but not in the list
      const other = await users.createUser(`xo${Date.now()}@test.com`, 'password123', 'user');
      invoiceStore.forUser(other.id).add({ id: 'theirs', status: 'pending', vendorName: 'B', totalAmount: 5, processedAt: new Date().toISOString() });

      const res = await request(serverFor(app)).post('/api/invoices/submit-all').set('Authorization', auth())
        .send({ ids: ['p1', 'posted', 'review', 'theirs', 'missing', 'p2', 'p1'] }).expect(200);
      expect(res.body).toEqual({ submitted: 2, skipped: 4 });

      await waitFor(() => handler.submitInvoiceToXero.mock.calls.length >= 2);
      const sent = handler.submitInvoiceToXero.mock.calls.map(([userId, id]) => [userId, id]);
      expect(sent).toEqual([[testUser.id, 'p1'], [testUser.id, 'p2']]);
    });

    test('nothing pending among the ids: nothing sent', async () => {
      add('posted', { status: 'posted', xeroInvoiceId: 'xero-1' });
      const res = await request(serverFor(app)).post('/api/invoices/submit-all').set('Authorization', auth())
        .send({ ids: ['posted'] }).expect(200);
      expect(res.body).toEqual({ submitted: 0, skipped: 1 });
      expect(handler.submitInvoiceToXero).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/invoices/:id/submit', () => {
    test('a match for a bill already in Xero is a 409 unless forced', async () => {
      add('orig', { status: 'posted', xeroInvoiceId: 'xero-o', invoiceNumber: 'SAME' });
      add('copy', { invoiceNumber: 'SAME' });
      const res = await request(serverFor(app)).post('/api/invoices/copy/submit').set('Authorization', auth()).send({}).expect(409);
      expect(res.body.duplicateOf).toBe('orig');
      expect(res.body.error).toMatch(/already in Xero/);
      expect(handler.submitInvoiceToXero).not.toHaveBeenCalled();

      await request(serverFor(app)).post('/api/invoices/copy/submit').set('Authorization', auth()).send({ force: true }).expect(202);
      expect(handler.submitInvoiceToXero).toHaveBeenCalledWith(testUser.id, 'copy', { allowDuplicate: true });
    });

    // The route's own catch wrote 'error' over the row, taking a posted row
    // off 'posted' after a failed correction.
    test('a failed correction leaves the row as the send recorded it, not error', async () => {
      add('fix', { status: 'posted', xeroInvoiceId: 'xero-f' });
      handler.submitInvoiceToXero.mockRejectedValueOnce(new Error('Xero refused'));
      await request(serverFor(app)).post('/api/invoices/fix/submit').set('Authorization', auth()).send({}).expect(202);
      await waitFor(() => handler.submitInvoiceToXero.mock.results.length > 0);
      await new Promise(r => setTimeout(r, 20));
      expect(store.getById('fix').status).toBe('posted');
    });
  });

  describe('deleting', () => {
    test('a row in Xero cannot be deleted', async () => {
      add('in-xero', { status: 'error', xeroInvoiceId: 'xero-d' });
      const res = await request(serverFor(app)).delete('/api/invoices/in-xero').set('Authorization', auth()).expect(409);
      expect(res.body.error).toBe('This was posted to Xero. Void or delete it in Xero first.');
      expect(store.getById('in-xero')).not.toBeNull();
    });

    test('a row only here still deletes', async () => {
      add('local');
      await request(serverFor(app)).delete('/api/invoices/local').set('Authorization', auth()).expect(200);
      expect(store.getById('local')).toBeNull();
    });

    test('Clear all keeps rows in Xero and their PDFs, removes the rest, and says how many it kept', async () => {
      const pdfs = require('../utils/pdf-store').forUser(testUser.id);
      add('gone', { hasPdf: true });
      add('kept', { status: 'posted', xeroInvoiceId: 'xero-k', hasPdf: true });
      pdfs.save('gone', Buffer.from('%PDF-1.4 a'));
      pdfs.save('kept', Buffer.from('%PDF-1.4 b'));

      const res = await request(serverFor(app)).delete('/api/invoices').set('Authorization', auth()).expect(200);
      expect(res.body).toMatchObject({ success: true, removed: 1, kept: 1 });
      expect(res.body.message).toMatch(/Kept 1/);
      expect(store.getAll().map(r => r.id)).toEqual(['kept']);
      expect(pdfs.exists('kept')).toBe(true);
      expect(pdfs.exists('gone')).toBe(false);
    });
  });

  test('reporting an issue on a posted row keeps it posted', async () => {
    add('rep', { status: 'posted', xeroInvoiceId: 'xero-r' });
    await request(serverFor(app)).post('/api/invoices/rep/report').set('Authorization', auth()).send({ note: 'wrong amount' }).expect(200);
    const row = store.getById('rep');
    expect(row.status).toBe('posted');
    expect(row.reports).toHaveLength(1);
  });

  test('the status of a row in Xero cannot be changed by hand, whatever its status says', async () => {
    add('legacy', { status: 'reported', xeroInvoiceId: 'xero-l' });
    await request(serverFor(app)).patch('/api/invoices/legacy/status').set('Authorization', auth()).send({ status: 'pending' }).expect(409);
    expect(store.getById('legacy').status).toBe('reported');
  });

  test('the list and the single record carry xeroTenantId', async () => {
    add('t', { status: 'posted', xeroInvoiceId: 'xero-t', xeroTenantId: 'tenant-9' });
    const list = await request(serverFor(app)).get('/api/invoices').set('Authorization', auth()).expect(200);
    expect(list.body.invoices[0].xeroTenantId).toBe('tenant-9');
    const one = await request(serverFor(app)).get('/api/invoices/t').set('Authorization', auth()).expect(200);
    expect(one.body.invoice.xeroTenantId).toBe('tenant-9');
  });
});
