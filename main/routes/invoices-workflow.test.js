const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/invoices workflow & batching', () => {
  let app, users, jwtSecret, testUser, invoiceStore;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    invoiceStore = require('../utils/invoice-store');
    const invoiceRoutes = require('./invoices');

    testUser = await users.createUser(`inv${Date.now()}@test.com`, 'password123', 'user');

    app = express();
    app.use(express.json());
    app.use('/api/invoices', invoiceRoutes);
  });

  const auth = () => `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`;

  describe('GET /api/invoices', () => {
    test('the list carries the claim and duplicate fields the Invoices page reads', async () => {
      invoiceStore.forUser(testUser.id).add({
        id: `l1_${Date.now()}`, status: 'review-needed', invoiceType: 'EXPENSE', source: 'phone', vendorName: 'Grab',
        totalAmount: 5, description: '[Local Travel] ride', receiptFile: 'x.jpg', receiptGroup: 'g1', receiptPage: 2,
        receivedAt: '2026-09-10T00:00:00.000Z', processedAt: new Date().toISOString(),
      });
      const res = await request(serverFor(app)).get('/api/invoices').set('Authorization', auth()).expect(200);
      const row = res.body.invoices[0];
      expect(row).toMatchObject({ receiptFile: 'x.jpg', receiptGroup: 'g1', receiptPage: 2, description: '[Local Travel] ride', receivedAt: '2026-09-10T00:00:00.000Z' });
      expect(row).toHaveProperty('duplicateOf');
    });

    // The Automation page polls this every 15 s for the ten rows it shows.
    describe('?recent=N', () => {
      const addMany = n => {
        const store = invoiceStore.forUser(testUser.id);
        for (let i = 0; i < n; i++) store.add({ id: `r${i}_${Date.now()}`, status: 'posted', vendorName: `V${i}`, totalAmount: i });
      };
      const get = q => request(serverFor(app)).get(`/api/invoices${q}`).set('Authorization', auth());

      test('returns the newest N with the same rows as the full list, and the total', async () => {
        addMany(12);
        const all    = (await get('').expect(200)).body;
        const recent = (await get('?recent=10').expect(200)).body;
        expect(all).toEqual({ invoices: expect.any(Array) });    // the default shape is unchanged
        expect(all.invoices).toHaveLength(12);
        expect(recent.total).toBe(12);
        expect(recent.invoices).toEqual(all.invoices.slice(0, 10));
        expect(recent.invoices[0].vendorName).toBe('V11');
        // Fewer than asked for is all of them.
        expect((await get('?recent=20').expect(200)).body.invoices).toEqual(all.invoices);
      });

      test('is capped at 100', async () => {
        addMany(101);
        const { body } = await get('?recent=5000').expect(200);
        expect(body.invoices).toHaveLength(100);
        expect(body.total).toBe(101);
      });

      // One test, not one per value: each test here pays for a fresh user.
      test('rejects anything but a whole number of at least 1', async () => {
        for (const q of ['0', '-1', '2.5', 'ten', '']) {
          const { body } = await get(`?recent=${q}`).expect(400);
          expect(body.error).toMatch(/recent/);
        }
      });

      test('only the caller\'s own invoices', async () => {
        addMany(2);
        const other = await users.createUser(`other${Date.now()}@test.com`, 'password123', 'user');
        invoiceStore.forUser(other.id).add({ id: `o_${Date.now()}`, status: 'posted', vendorName: 'Theirs', totalAmount: 1 });
        const { body } = await get('?recent=10').expect(200);
        expect(body.invoices.map(r => r.vendorName)).not.toContain('Theirs');
        expect(body.total).toBe(2);
      });
    });
  });

  describe('POST /api/invoices/batch-status', () => {
    test('requires authentication', async () => {
      await request(serverFor(app))
        .post('/api/invoices/batch-status')
        .send({ ids: ['123'], status: 'reviewed' })
        .expect(401);
    });

    test('validates ids and status arguments', async () => {
      await request(serverFor(app))
        .post('/api/invoices/batch-status')
        .set('Authorization', auth())
        .send({ ids: [], status: 'reviewed' })
        .expect(400);

      await request(serverFor(app))
        .post('/api/invoices/batch-status')
        .set('Authorization', auth())
        .send({ ids: ['123'], status: 'invalid-status' })
        .expect(400);
    });

    test('batch approves verified claims while protecting locked records', async () => {
      const store = invoiceStore.forUser(testUser.id);
      const inv1 = store.add({
        id: `c1_${Date.now()}`,
        status: 'review-needed',
        invoiceType: 'EXPENSE',
        vendorName: 'Grab',
        totalAmount: 23.50,
      });
      const inv2 = store.add({
        id: `c2_${Date.now()}`,
        status: 'review-needed',
        invoiceType: 'EXPENSE',
        vendorName: 'Starbucks',
        totalAmount: 14.80,
      });
      const locked = store.add({
        id: `c3_${Date.now()}`,
        status: 'posted',
        invoiceType: 'EXPENSE',
        vendorName: 'Hotel',
        totalAmount: 200.00,
      });

      const res = await request(serverFor(app))
        .post('/api/invoices/batch-status')
        .set('Authorization', auth())
        .send({ ids: [inv1.id, inv2.id, locked.id], status: 'reviewed' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(2); // inv1 and inv2 updated, locked skipped

      expect(store.getById(inv1.id).status).toBe('reviewed');
      expect(store.getById(inv2.id).status).toBe('reviewed');
      expect(store.getById(locked.id).status).toBe('posted');
    });
  });

  describe('PATCH /api/invoices/:id for expense claims & discrepancy resolution', () => {
    test('allows updating invoiceType to EXPENSE, subTotal, taxAmount, and description', async () => {
      const store = invoiceStore.forUser(testUser.id);
      const inv = store.add({
        id: `inv_${Date.now()}`,
        status: 'review-needed',
        invoiceType: 'ACCPAY',
        vendorName: 'Grab',
        totalAmount: 25.00,
      });

      const patchRes = await request(serverFor(app))
        .patch(`/api/invoices/${inv.id}`)
        .set('Authorization', auth())
        .send({
          invoiceType: 'EXPENSE',
          description: 'Client meeting transport [Transport]',
          totalAmount: 23.50,
          subTotal: 21.56,
          taxAmount: 1.94,
        })
        .expect(200);

      expect(patchRes.body.invoice.invoiceType).toBe('EXPENSE');
      expect(patchRes.body.invoice.description).toBe('Client meeting transport [Transport]');
      expect(patchRes.body.invoice.totalAmount).toBe(23.50);
      expect(patchRes.body.invoice.subTotal).toBe(21.56);
      expect(patchRes.body.invoice.taxAmount).toBe(1.94);
    });

    test('1-click discrepancy resolver: updates total amount and clears errorMsg', async () => {
      const store = invoiceStore.forUser(testUser.id);
      const inv = store.add({
        id: `disc_${Date.now()}`,
        status: 'review-needed',
        invoiceType: 'EXPENSE',
        vendorName: 'Grab',
        totalAmount: 25.00,
        errorMsg: 'Claimed 25.00 but the receipt says 23.50',
      });

      // Simulates clicking "[✓ Use Receipt Total (SGD 23.50)]"
      const res = await request(serverFor(app))
        .patch(`/api/invoices/${inv.id}`)
        .set('Authorization', auth())
        .send({
          totalAmount: 23.50,
          errorMsg: null,
        })
        .expect(200);

      expect(res.body.invoice.totalAmount).toBe(23.50);
      expect(res.body.invoice.errorMsg).toBeNull();

      const updated = store.getById(inv.id);
      expect(updated.totalAmount).toBe(23.50);
      expect(updated.errorMsg).toBeNull();
    });
  });
});
