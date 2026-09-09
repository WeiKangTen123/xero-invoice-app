const request = require('supertest');
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

  describe('POST /api/invoices/batch-status', () => {
    test('requires authentication', async () => {
      await request(app)
        .post('/api/invoices/batch-status')
        .send({ ids: ['123'], status: 'reviewed' })
        .expect(401);
    });

    test('validates ids and status arguments', async () => {
      await request(app)
        .post('/api/invoices/batch-status')
        .set('Authorization', auth())
        .send({ ids: [], status: 'reviewed' })
        .expect(400);

      await request(app)
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

      const res = await request(app)
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

      const patchRes = await request(app)
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
      const res = await request(app)
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
