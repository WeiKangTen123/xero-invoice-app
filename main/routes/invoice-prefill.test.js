const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

// Supplier memory as the review page sees it: the record it reads says which
// fields were filled from the contact's last settled document and from which
// one, and which Setup account posting falls back to. Saving the review form
// keeps a note while its field is unchanged and drops it once the field is
// edited. No Xero call is made: nothing here sends.
describe('prefilled fields through the invoice routes', () => {
  let app, users, jwtSecret, testUser, store;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    testUser = await users.createUser(`prefill${Date.now()}@test.com`, 'password123', 'user');
    store = require('../utils/invoice-store').forUser(testUser.id);
    app = express();
    app.use(express.json());
    app.use('/api/invoices', require('./invoices'));
  });

  const auth = () => `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`;
  const api  = () => request(serverFor(app));
  const compose = body => api().post('/api/invoices/compose').set('Authorization', auth()).send({
    contactName: 'Harbour Foods Pte Ltd', invoiceDate: '2026-09-21', lineItems: [{ description: 'Catering', unitAmount: 800 }], ...body,
  });

  async function settledThenNew() {
    const last = await compose({ invoiceNumber: 'S-100', invoiceDate: '2026-09-03', accountCode: '201', currency: 'USD' });
    expect(last.status).toBe(201);
    store.update(last.body.id, { status: 'reviewed' });
    const next = await compose({ invoiceNumber: 'S-101' });
    expect(next.status).toBe(201);
    return { lastId: last.body.id, id: next.body.id };
  }

  test('GET /:id carries the provenance and the Setup fallback account', async () => {
    const { lastId, id } = await settledThenNew();
    const res = await api().get(`/api/invoices/${id}`).set('Authorization', auth());
    expect(res.status).toBe(200);
    const from = { fromId: lastId, fromNumber: 'S-100', fromDate: '2026-09-03' };
    expect(res.body.invoice).toMatchObject({
      accountCode: '201', currency: 'USD', setupAccountCode: '200',
      prefilledFrom: { accountCode: from, currency: from },
    });
  });

  test('saving the whole form unchanged keeps the notes; changing the account drops only its note', async () => {
    const { id } = await settledThenNew();
    const before = (await api().get(`/api/invoices/${id}`).set('Authorization', auth())).body.invoice;
    // What the review page sends on Save: every field, most of them as they were.
    const form = {
      vendorName: before.vendorName, contactEmail: before.contactEmail || '', contactAddress: before.contactAddress || '',
      invoiceNumber: before.invoiceNumber, invoiceDate: before.invoiceDate, dueDate: before.dueDate,
      totalAmount: before.totalAmount, subTotal: before.subTotal, taxAmount: before.taxAmount, currency: before.currency,
      description: before.description || '', invoiceType: before.invoiceType, accountCode: before.accountCode,
      paymentReference: before.paymentReference || '', lineItems: before.lineItems,
    };
    let res = await api().patch(`/api/invoices/${id}`).set('Authorization', auth()).send(form);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.invoice.prefilledFrom).sort()).toEqual(['accountCode', 'currency']);

    res = await api().patch(`/api/invoices/${id}`).set('Authorization', auth()).send({ ...form, accountCode: '260' });
    expect(res.status).toBe(200);
    expect(res.body.invoice.accountCode).toBe('260');
    expect(Object.keys(res.body.invoice.prefilledFrom)).toEqual(['currency']);
  });

  test('provenance cannot be written through the edit route', async () => {
    const { id } = await settledThenNew();
    const res = await api().patch(`/api/invoices/${id}`).set('Authorization', auth())
      .send({ description: 'x', prefilledFrom: { accountCode: { fromId: 'forged' } } });
    expect(res.status).toBe(200);
    expect(res.body.invoice.prefilledFrom.accountCode.fromId).not.toBe('forged');
  });
});
