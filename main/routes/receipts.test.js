const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');

describe('routes/receipts', () => {
  let app, users, jwtSecret, testUser, receiptStore, invoiceStore;
  const created = [];

  // A 6-byte buffer is a perfectly good stand-in: nothing here inspects pixels.
  const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    receiptStore = require('../utils/receipt-store');
    invoiceStore = require('../utils/invoice-store');
    const receiptRoutes = require('./receipts');

    testUser = await users.createUser(`r${Date.now()}@test.com`, 'password123', 'user');
    created.push(testUser.id);

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/receipts', receiptRoutes);
  });

  afterAll(() => {
    for (const id of created) {
      try { fs.rmSync(path.join(__dirname, '../data/users', String(id)), { recursive: true, force: true }); } catch {}
    }
  });

  const auth = () => `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`;
  const upload = (body) => request(app).post('/api/receipts').set('Authorization', auth()).send(body);

  describe('POST /', () => {
    test('requires authentication', async () => {
      await request(app).post('/api/receipts').send({ mime: 'image/jpeg', data: JPEG_B64 }).expect(401);
    });

    test('stores the file and creates an EXPENSE row awaiting review', async () => {
      const res = await upload({ mime: 'image/jpeg', data: JPEG_B64, filename: 'grab.jpg' }).expect(201);
      expect(res.body.receipt.invoiceType).toBe('EXPENSE');
      // Nothing is known about the receipt until it is read or typed, so it
      // must not land in a state that looks ready to post.
      expect(res.body.receipt.status).toBe('review-needed');
      expect(res.body.receipt.receiptFile).toMatch(/\.jpg$/);
      expect(res.body.imageToken).toBeTruthy();
      expect(receiptStore.forUser(testUser.id).exists(res.body.receipt.receiptFile)).toBe(true);
    });

    test('records how the receipt arrived, defaulting to upload', async () => {
      expect((await upload({ mime: 'image/jpeg', data: JPEG_B64, source: 'phone' })).body.receipt.source).toBe('phone');
      expect((await upload({ mime: 'image/jpeg', data: JPEG_B64 })).body.receipt.source).toBe('upload');
      // An unrecognised source must not be stored verbatim.
      expect((await upload({ mime: 'image/jpeg', data: JPEG_B64, source: 'x' })).body.receipt.source).toBe('upload');
    });

    test('rejects a type Xero cannot attach, and names what is accepted', async () => {
      const res = await upload({ mime: 'image/heic', data: JPEG_B64 }).expect(400);
      expect(res.body.error).toMatch(/image\/jpeg/);
      expect(res.body.error).toMatch(/heic/);
    });

    test('rejects a file over the Xero attachment cap with both numbers', async () => {
      const tooBig = Buffer.alloc(receiptStore.MAX_BYTES + 1024, 1).toString('base64');
      const res = await upload({ mime: 'image/jpeg', data: tooBig }).expect(413);
      expect(res.body.error).toMatch(/3\.0MB/);
    });

    test('rejects missing or malformed base64 rather than storing a broken file', async () => {
      await upload({ mime: 'image/jpeg' }).expect(400);
      await upload({ mime: 'image/jpeg', data: '' }).expect(400);
      await upload({ mime: 'image/jpeg', data: 'not base64 !!!' }).expect(400);
    });

    test('accepts a data: URI prefix, which is what a canvas produces', async () => {
      await upload({ mime: 'image/jpeg', data: `data:image/jpeg;base64,${JPEG_B64}` }).expect(201);
    });

    test('no row is created when the file is rejected', async () => {
      const before = invoiceStore.forUser(testUser.id).getAll().length;
      await upload({ mime: 'image/heic', data: JPEG_B64 }).expect(400);
      expect(invoiceStore.forUser(testUser.id).getAll().length).toBe(before);
    });
  });

  describe('GET /:id/image', () => {
    test('serves the image to a valid scoped token', async () => {
      const { body } = await upload({ mime: 'image/jpeg', data: JPEG_B64 });
      await request(app).get(`/api/receipts/${body.receipt.id}/image?token=${body.imageToken}`)
        .expect(200).expect('Content-Type', /image\/jpeg/);
    });

    test('rejects a missing, garbage or expired token', async () => {
      const { body } = await upload({ mime: 'image/jpeg', data: JPEG_B64 });
      await request(app).get(`/api/receipts/${body.receipt.id}/image`).expect(401);
      await request(app).get(`/api/receipts/${body.receipt.id}/image?token=garbage`).expect(401);
      const expired = jwt.sign({ userId: testUser.id, invoiceId: body.receipt.id, purpose: 'receipt' }, jwtSecret(), { expiresIn: '-1s' });
      await request(app).get(`/api/receipts/${body.receipt.id}/image?token=${expired}`).expect(401);
    });

    test('a token for one receipt cannot open another', async () => {
      const a = (await upload({ mime: 'image/jpeg', data: JPEG_B64 })).body;
      const b = (await upload({ mime: 'image/jpeg', data: JPEG_B64 })).body;
      await request(app).get(`/api/receipts/${b.receipt.id}/image?token=${a.imageToken}`).expect(401);
    });

    test('a PDF token cannot be reused to open a receipt', async () => {
      // Both routes mint short-lived tokens against the same secret; only the
      // purpose claim keeps them apart.
      const { body } = await upload({ mime: 'image/jpeg', data: JPEG_B64 });
      const pdfToken = jwt.sign({ userId: testUser.id, invoiceId: body.receipt.id, purpose: 'pdf' }, jwtSecret(), { expiresIn: '5m' });
      await request(app).get(`/api/receipts/${body.receipt.id}/image?token=${pdfToken}`).expect(401);
    });
  });

  describe('DELETE /:id', () => {
    test('removes the row and the file together', async () => {
      const { body } = await upload({ mime: 'image/jpeg', data: JPEG_B64 });
      await request(app).delete(`/api/receipts/${body.receipt.id}`).set('Authorization', auth()).expect(200);
      expect(invoiceStore.forUser(testUser.id).getById(body.receipt.id)).toBeFalsy();
      expect(receiptStore.forUser(testUser.id).exists(body.receipt.receiptFile)).toBe(false);
    });

    test('refuses to delete a bill through the receipts route', async () => {
      const bill = invoiceStore.forUser(testUser.id).add({ id: 'bill-1', status: 'pending', invoiceType: 'ACCPAY', processedAt: new Date().toISOString() });
      expect(bill).toBeTruthy();
      await request(app).delete('/api/receipts/bill-1').set('Authorization', auth()).expect(400);
      expect(invoiceStore.forUser(testUser.id).getById('bill-1')).toBeTruthy();
    });

    test('404s for something that does not exist', async () => {
      await request(app).delete('/api/receipts/nope').set('Authorization', auth()).expect(404);
    });
  });
});
