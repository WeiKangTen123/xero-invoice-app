const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

// Mileage and per diem claims in the AR & AP list and the generic edit route.
// The list names and badges them by kind, so its rows must carry the kind; and
// their figures are priced on the server from distance or days and the rate,
// so the generic PATCH must refuse to set those figures directly rather than
// let the amount drift from the quantity x rate its own line states. Nothing
// here reaches Xero: the send is replaced.
jest.mock('../utils/invoice-handler', () => ({
  ...jest.requireActual('../utils/invoice-handler'),
  submitInvoiceToXero: jest.fn(async () => null),
}));

describe('allowance claims through the invoice routes', () => {
  let app, store, testUser, jwtSecret;
  let n = 0;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    const users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    testUser = await users.createUser(`alw${++n}-${Date.now()}@test.com`, 'password123', 'user');
    store    = require('../utils/invoice-store').forUser(testUser.id);
    app = express();
    app.use(express.json());
    app.use('/api/invoices', require('./invoices'));
  });

  const auth = () => `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`;
  const mileage = (id, extra = {}) => store.add({
    id, status: 'review-needed', invoiceType: 'EXPENSE', vendorName: '', invoiceNumber: `EXP-${id}`,
    invoiceDate: '2026-10-03', totalAmount: 25.2, subTotal: 25.2, taxAmount: 0, currency: 'SGD',
    claimKind: 'mileage', claimQuantity: 42, claimRate: 0.6, claimUnit: 'km',
    claimDetails: { from: 'Office', to: 'Client A', purpose: 'site visit', distanceKm: 42, returnTrip: false },
    lineItems: [{ description: 'Mileage 2026-10-03: Office → Client A (site visit), 42.0 km × 0.60', unitAmount: 25.2 }],
    processedAt: new Date().toISOString(), ...extra,
  });

  test('list rows carry the claim kind, quantity, rate and unit', async () => {
    await mileage('m1');
    const res = await request(serverFor(app)).get('/api/invoices').set('Authorization', auth()).expect(200);
    const row = res.body.invoices.find(r => r.id === 'm1');
    expect(row).toMatchObject({ claimKind: 'mileage', claimQuantity: 42, claimRate: 0.6, claimUnit: 'km' });
  });

  test.each(['totalAmount', 'subTotal', 'taxAmount', 'lineItems', 'currency'])(
    'PATCH refuses to set %s on a priced claim, and nothing changes', async field => {
      await mileage('m2');
      const value = field === 'lineItems' ? [{ description: 'x', unitAmount: 999 }] : field === 'currency' ? 'USD' : 999;
      const res = await request(serverFor(app)).patch('/api/invoices/m2').set('Authorization', auth())
        .send({ [field]: value }).expect(409);
      expect(res.body.fields).toEqual([field]);
      const after = store.getById('m2');
      expect(after.totalAmount).toBe(25.2);
      expect(after.currency).toBe('SGD');
    });

  test('PATCH still edits other fields of a priced claim', async () => {
    await mileage('m3');
    await request(serverFor(app)).patch('/api/invoices/m3').set('Authorization', auth())
      .send({ description: 'Client visit' }).expect(200);
    expect(store.getById('m3').description).toBe('Client visit');
  });

  test('a receipt claim and a bill can still have their figures edited', async () => {
    await store.add({ id: 'b1', status: 'review-needed', invoiceType: 'ACCPAY', vendorName: 'Acme', invoiceNumber: 'A-1',
      invoiceDate: '2026-10-01', totalAmount: 10, currency: 'SGD', processedAt: new Date().toISOString() });
    await request(serverFor(app)).patch('/api/invoices/b1').set('Authorization', auth())
      .send({ totalAmount: 12 }).expect(200);
    expect(store.getById('b1').totalAmount).toBe(12);
  });
});
