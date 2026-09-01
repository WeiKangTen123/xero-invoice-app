const request = require('supertest');
const express = require('express');

// Parsing is mocked everywhere in this file. Left real it would make a live
// Gemini call from the test suite, and the routes' job is to store the receipt
// correctly whatever the parser does.
jest.mock('../utils/receipt-parser', () => ({ parseReceiptImage: jest.fn().mockResolvedValue(null) }));
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');

describe('routes/receipts', () => {
  let app, users, jwtSecret, testUser, receiptStore, invoiceStore, pairing;
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
    pairing = require('../utils/pairing');
    pairing._reset();
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

// ── Phone pairing ───────────────────────────────────────────────────────────
// The token in a capture URL is the phone's ONLY credential. These tests pin
// what it can and cannot do, because it is displayed on screen as a QR code and
// travels in a URL where it will end up in browser history.
describe('routes/receipts — phone pairing', () => {
  let app, users, jwtSecret, testUser, otherUser, pairing, invoiceStore;
  const created = [];
  const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    pairing = require('../utils/pairing');
    pairing._reset();
    invoiceStore = require('../utils/invoice-store');
    const receiptRoutes = require('./receipts');

    testUser  = await users.createUser(`p${Date.now()}a@test.com`, 'password123', 'user');
    otherUser = await users.createUser(`p${Date.now()}b@test.com`, 'password123', 'user');
    created.push(testUser.id, otherUser.id);

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/receipts', receiptRoutes);
  });

  afterAll(() => {
    for (const id of created) {
      try { fs.rmSync(path.join(__dirname, '../data/users', String(id)), { recursive: true, force: true }); } catch {}
    }
  });

  const tokenFor = u => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const pair = (u = testUser) => request(app).post('/api/receipts/pair').set('Authorization', tokenFor(u));

  describe('POST /pair', () => {
    test('requires authentication', async () => {
      await request(app).post('/api/receipts/pair').expect(401);
    });

    test('returns a scannable QR and the URL it encodes', async () => {
      const res = await pair().expect(201);
      expect(res.body.token).toBeTruthy();
      expect(res.body.qrSvg).toMatch(/^<\?xml|^<svg/);
      expect(res.body.url).toContain(`/capture/${res.body.token}`);
      expect(res.body.expiresInMs).toBeGreaterThan(0);
    });
  });

  describe('GET /capture/:token — what the phone sees', () => {
    test('a live token validates without spending an upload', async () => {
      const { body } = await pair();
      const a = await request(app).get(`/api/receipts/capture/${body.token}`).expect(200);
      const b = await request(app).get(`/api/receipts/capture/${body.token}`).expect(200);
      expect(a.body.ok).toBe(true);
      expect(b.body.usesLeft).toBe(a.body.usesLeft);   // checking is free
    });

    test('an unknown or revoked token is refused with instructions, not a stack trace', async () => {
      const { body } = await pair();
      await request(app).delete(`/api/receipts/pair/${body.token}`).set('Authorization', tokenFor(testUser)).expect(200);
      const res = await request(app).get(`/api/receipts/capture/${body.token}`).expect(401);
      expect(res.body.error).toMatch(/new QR code/i);
      await request(app).get('/api/receipts/capture/garbage').expect(401);
    });

    test('reveals nothing about who the pairing belongs to', async () => {
      const { body } = await pair();
      const res = await request(app).get(`/api/receipts/capture/${body.token}`).expect(200);
      expect(JSON.stringify(res.body)).not.toContain(String(testUser.id));
      expect(JSON.stringify(res.body)).not.toContain(testUser.email);
    });
  });

  describe('POST /capture/:token — the phone uploads', () => {
    test('stores against the pairing owner and marks the source as phone', async () => {
      const { body } = await pair();
      const res = await request(app).post(`/api/receipts/capture/${body.token}`)
        .send({ mime: 'image/jpeg', data: JPEG_B64 }).expect(201);
      expect(res.body.receipt.source).toBe('phone');
      expect(res.body.receipt.invoiceType).toBe('EXPENSE');
      // It landed in the OWNER's account, not nobody's.
      expect(invoiceStore.forUser(testUser.id).getById(res.body.receipt.id)).toBeTruthy();
      expect(invoiceStore.forUser(otherUser.id).getById(res.body.receipt.id)).toBeFalsy();
    });

    test('the phone is never handed a token that can read the image back', async () => {
      // Upload-only is the whole basis for putting this credential in a URL.
      const { body } = await pair();
      const res = await request(app).post(`/api/receipts/capture/${body.token}`)
        .send({ mime: 'image/jpeg', data: JPEG_B64 }).expect(201);
      expect(res.body.imageToken).toBeUndefined();
    });

    test('one scan covers a stack of receipts', async () => {
      const { body } = await pair();
      for (let i = 0; i < 4; i++) {
        await request(app).post(`/api/receipts/capture/${body.token}`)
          .send({ mime: 'image/jpeg', data: JPEG_B64 }).expect(201);
      }
      expect(invoiceStore.forUser(testUser.id).getAll().length).toBe(4);
    });

    test('a rejected file does not burn one of the allowed uploads', async () => {
      const { body } = await pair();
      await request(app).post(`/api/receipts/capture/${body.token}`)
        .send({ mime: 'image/heic', data: JPEG_B64 }).expect(400);
      const status = await request(app).get(`/api/receipts/pair/${body.token}`).set('Authorization', tokenFor(testUser)).expect(200);
      expect(status.body.uploads).toBe(0);
    });

    test('the token stops working once its upload budget is spent', async () => {
      const { body } = await pair();
      for (let i = 0; i < pairing.MAX_USES; i++) {
        await request(app).post(`/api/receipts/capture/${body.token}`).send({ mime: 'image/jpeg', data: JPEG_B64 }).expect(201);
      }
      await request(app).post(`/api/receipts/capture/${body.token}`).send({ mime: 'image/jpeg', data: JPEG_B64 }).expect(401);
    });

    test('an expired or revoked token cannot upload', async () => {
      const { body } = await pair();
      pairing.revoke(body.token);
      await request(app).post(`/api/receipts/capture/${body.token}`).send({ mime: 'image/jpeg', data: JPEG_B64 }).expect(401);
    });

    test('the capture token grants ONLY upload — not listing, reading or deleting', async () => {
      const { body } = await pair();
      const up = await request(app).post(`/api/receipts/capture/${body.token}`).send({ mime: 'image/jpeg', data: JPEG_B64 }).expect(201);
      const id = up.body.receipt.id;
      // No route accepts it as a bearer credential for anything else.
      await request(app).get(`/api/receipts/${id}/token`).set('Authorization', `Bearer ${body.token}`).expect(401);
      await request(app).delete(`/api/receipts/${id}`).set('Authorization', `Bearer ${body.token}`).expect(401);
      await request(app).get(`/api/receipts/${id}/image?token=${body.token}`).expect(401);
    });
  });

  describe('pairing ownership', () => {
    test('another user cannot poll or revoke a pairing that is not theirs', async () => {
      const { body } = await pair(testUser);
      await request(app).get(`/api/receipts/pair/${body.token}`).set('Authorization', tokenFor(otherUser)).expect(404);
      await request(app).delete(`/api/receipts/pair/${body.token}`).set('Authorization', tokenFor(otherUser)).expect(404);
      // Still alive for its owner.
      await request(app).get(`/api/receipts/pair/${body.token}`).set('Authorization', tokenFor(testUser)).expect(200);
    });

    test('the owner sees arrivals, which is how the desktop knows to refresh', async () => {
      const { body } = await pair();
      await request(app).post(`/api/receipts/capture/${body.token}`).send({ mime: 'image/jpeg', data: JPEG_B64 }).expect(201);
      const res = await request(app).get(`/api/receipts/pair/${body.token}`).set('Authorization', tokenFor(testUser)).expect(200);
      expect(res.body.alive).toBe(true);
      expect(res.body.uploads).toBe(1);
    });
  });
});

// ── Reading the receipt ─────────────────────────────────────────────────────
// The rule the whole feature rests on: the image is stored first, and parsing
// only fills it in. A parse failure must leave a usable receipt behind.
describe('routes/receipts — parsing fills in a stored receipt', () => {
  let app, users, jwtSecret, testUser, invoiceStore, parser;
  const created = [];
  const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');

  // The parse runs in setImmediate so the upload response is not held open;
  // let the queue drain before asserting on the row.
  const settle = () => new Promise(r => setImmediate(() => setImmediate(r)));

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    invoiceStore = require('../utils/invoice-store');
    parser = require('../utils/receipt-parser');
    parser.parseReceiptImage.mockReset();
    parser.parseReceiptImage.mockResolvedValue(null);
    require('../utils/pairing')._reset();
    const receiptRoutes = require('./receipts');

    testUser = await users.createUser(`x${Date.now()}@test.com`, 'password123', 'user');
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
  const upload = () => request(app).post('/api/receipts').set('Authorization', auth()).send({ mime: 'image/jpeg', data: JPEG_B64 });

  test('a successful read populates the row the user reviews', async () => {
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{
      merchant: 'Grab', date: '2026-08-24', currency: 'SGD',
      total: 18.4, tax: 1.51, subTotal: 16.89, description: 'Airport ride', confidence: 'high', box: null,
    }] });
    const { body } = await upload().expect(201);
    await settle();

    const row = invoiceStore.forUser(testUser.id).getById(body.receipt.id);
    expect(row.vendorName).toBe('Grab');
    expect(row.invoiceDate).toBe('2026-08-24');
    expect(row.currency).toBe('SGD');
    expect(row.totalAmount).toBe(18.4);
    expect(row.taxAmount).toBe(1.51);
  });

  test('the response does not wait for the parse — the row appears immediately', async () => {
    // A phone on mobile data must not hold a request open for a vision call.
    let resolveParse;
    parser.parseReceiptImage.mockReturnValue(new Promise(r => { resolveParse = r; }));
    const { body } = await upload().expect(201);
    expect(body.receipt.id).toBeTruthy();       // returned while the parse is still pending
    resolveParse(null);
  });

  test('a parse failure leaves the receipt intact for manual entry', async () => {
    parser.parseReceiptImage.mockRejectedValue(new Error('quota exceeded'));
    const { body } = await upload().expect(201);
    await settle();

    const row = invoiceStore.forUser(testUser.id).getById(body.receipt.id);
    expect(row).toBeTruthy();                   // the receipt survived
    expect(row.status).toBe('review-needed');
    expect(row.receiptFile).toBeTruthy();
  });

  test('an unreadable receipt stays at review-needed with nothing invented', async () => {
    parser.parseReceiptImage.mockResolvedValue(null);
    const { body } = await upload().expect(201);
    await settle();

    const row = invoiceStore.forUser(testUser.id).getById(body.receipt.id);
    expect(row.status).toBe('review-needed');
    expect(row.vendorName).toBeFalsy();
    expect(row.totalAmount).toBeFalsy();
  });

  test('fields the parser could not read are left blank, not overwritten with null', async () => {
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{
      merchant: 'Cafe', date: null, currency: null, total: 12.5,
      tax: null, subTotal: null, description: null, confidence: 'low', box: null,
    }] });
    const { body } = await upload().expect(201);
    await settle();

    const row = invoiceStore.forUser(testUser.id).getById(body.receipt.id);
    expect(row.vendorName).toBe('Cafe');
    expect(row.totalAmount).toBe(12.5);
    expect(row.invoiceDate).toBeFalsy();
  });

  test('a read receipt still requires review — it never jumps to ready-to-post', async () => {
    // High confidence is not the user's sign-off, and nothing may look ready to
    // go to Xero without a person having looked at it.
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{
      merchant: 'Grab', date: '2026-08-24', currency: 'SGD',
      total: 18.4, tax: 1.51, subTotal: 16.89, description: 'Ride', confidence: 'high', box: null,
    }] });
    const { body } = await upload().expect(201);
    await settle();
    expect(invoiceStore.forUser(testUser.id).getById(body.receipt.id).status).toBe('review-needed');
  });
});

// ── What the phone may read back ────────────────────────────────────────────
// The phone token was upload-only. Showing "Grab · SGD 18.40" instead of
// "IMG_2841.jpg" widens it, so these tests pin exactly how far.
describe('routes/receipts — phone read-back is narrowly scoped', () => {
  let app, users, jwtSecret, testUser, otherUser, pairing, invoiceStore, parser;
  const created = [];
  const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
  const settle = () => new Promise(r => setImmediate(() => setImmediate(r)));

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    pairing = require('../utils/pairing');
    pairing._reset();
    invoiceStore = require('../utils/invoice-store');
    parser = require('../utils/receipt-parser');
    parser.parseReceiptImage.mockReset();
    parser.parseReceiptImage.mockResolvedValue(null);
    const receiptRoutes = require('./receipts');

    testUser  = await users.createUser(`s${Date.now()}a@test.com`, 'password123', 'user');
    otherUser = await users.createUser(`s${Date.now()}b@test.com`, 'password123', 'user');
    created.push(testUser.id, otherUser.id);

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/receipts', receiptRoutes);
  });

  afterAll(() => {
    for (const id of created) {
      try { fs.rmSync(path.join(__dirname, '../data/users', String(id)), { recursive: true, force: true }); } catch {}
    }
  });

  const tokenFor = u => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const pair = (u = testUser) => request(app).post('/api/receipts/pair').set('Authorization', tokenFor(u));
  const send = tok => request(app).post(`/api/receipts/capture/${tok}`).send({ mime: 'image/jpeg', data: JPEG_B64 });

  test('returns the parsed fields for what this token uploaded', async () => {
    parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [{
      merchant: 'Grab', date: '2026-08-24', currency: 'SGD',
      total: 18.4, tax: null, subTotal: null, description: 'Ride', confidence: 'high', box: null,
    }] });
    const { body } = await pair();
    await send(body.token).expect(201);
    await settle();

    const res = await request(app).get(`/api/receipts/capture/${body.token}/status`).expect(200);
    expect(res.body.receipts).toHaveLength(1);
    expect(res.body.receipts[0]).toMatchObject({ vendorName: 'Grab', totalAmount: 18.4, currency: 'SGD', parsed: true });
  });

  test('an unread receipt reports parsed:false so the phone can stop spinning', async () => {
    parser.parseReceiptImage.mockResolvedValue(null);
    const { body } = await pair();
    await send(body.token).expect(201);
    await settle();

    const res = await request(app).get(`/api/receipts/capture/${body.token}/status`).expect(200);
    expect(res.body.receipts[0].parsed).toBe(false);
    expect(res.body.receipts[0].vendorName).toBeNull();
  });

  test('NO image is served through the phone token — it has its own copy', async () => {
    // The whole reason the widening stays small: the phone took the photo.
    const { body } = await pair();
    const up = await send(body.token).expect(201);
    const res = await request(app).get(`/api/receipts/capture/${body.token}/status`).expect(200);

    expect(JSON.stringify(res.body)).not.toMatch(/imageToken/);
    expect(JSON.stringify(res.body)).not.toMatch(/receiptFile/);
    // And the image route still refuses the pairing token outright.
    await request(app).get(`/api/receipts/${up.body.receipt.id}/image?token=${body.token}`).expect(401);
  });

  test('it cannot reach a receipt from a different pairing', async () => {
    const a = (await pair()).body;
    const b = (await pair()).body;
    await send(a.token).expect(201);

    // b uploaded nothing, so b sees nothing — even for the same owner.
    const res = await request(app).get(`/api/receipts/capture/${b.token}/status`).expect(200);
    expect(res.body.receipts).toEqual([]);
  });

  test('it cannot reach another user\'s receipts at all', async () => {
    const mine = (await pair(testUser)).body;
    await send(mine.token).expect(201);
    // A pairing belonging to someone else lists only its own, which is nothing.
    const theirs = (await pair(otherUser)).body;
    const res = await request(app).get(`/api/receipts/capture/${theirs.token}/status`).expect(200);
    expect(res.body.receipts).toEqual([]);
  });

  test('it reveals nothing identifying about the account', async () => {
    const { body } = await pair();
    await send(body.token).expect(201);
    const res = await request(app).get(`/api/receipts/capture/${body.token}/status`).expect(200);
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain(testUser.email);
    expect(dump).not.toContain(String(testUser.id));
  });

  test('an expired or revoked token reads nothing back', async () => {
    const { body } = await pair();
    await send(body.token).expect(201);
    pairing.revoke(body.token);
    await request(app).get(`/api/receipts/capture/${body.token}/status`).expect(401);
    await request(app).get('/api/receipts/capture/garbage/status').expect(401);
  });

  test('reading back does not spend an upload', async () => {
    const { body } = await pair();
    await send(body.token).expect(201);
    for (let i = 0; i < 5; i++) await request(app).get(`/api/receipts/capture/${body.token}/status`).expect(200);
    const st = await request(app).get(`/api/receipts/pair/${body.token}`).set('Authorization', tokenFor(testUser)).expect(200);
    expect(st.body.uploads).toBe(1);
  });
});

// ── Turning one upload into several receipts ────────────────────────────────
// The design that makes auto-splitting safe: the FILE IS NEVER CUT UP. Siblings
// share one stored file and carry the region they own, so the original is always
// intact and merging back is just deleting rows.
describe('routes/receipts — one upload, several records', () => {
  let app, users, jwtSecret, testUser, invoiceStore, receiptStore, parser, pdfPages;
  const created = [];
  const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
  const PDF_B64  = Buffer.from('%PDF-1.4 fake').toString('base64');
  const settle = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

  const TWO = [
    { merchant: 'Grab',      date: '2026-08-24', currency: 'SGD', total: 18.4, tax: null, subTotal: null, description: 'Ride', confidence: 'high', box: [100, 20, 900, 460] },
    { merchant: 'FairPrice', date: '2026-08-23', currency: 'SGD', total: 62.1, tax: null, subTotal: null, description: 'Groceries', confidence: 'high', box: [100, 540, 900, 980] },
  ];

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    invoiceStore = require('../utils/invoice-store');
    receiptStore = require('../utils/receipt-store');
    parser  = require('../utils/receipt-parser');
    pdfPages = require('../utils/pdf-pages');
    parser.parseReceiptImage.mockReset();
    parser.parseReceiptImage.mockResolvedValue(null);
    require('../utils/pairing')._reset();
    const receiptRoutes = require('./receipts');

    testUser = await users.createUser(`sp${Date.now()}@test.com`, 'password123', 'user');
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
  const upload = (data = JPEG_B64, mime = 'image/jpeg') =>
    request(app).post('/api/receipts').set('Authorization', auth()).send({ mime, data });
  const rows = () => invoiceStore.forUser(testUser.id).getAll();

  describe('a photo of two receipts', () => {
    test('becomes two records, each owning its own region of the same file', async () => {
      parser.parseReceiptImage.mockResolvedValue({ split: true, receipts: TWO });
      await upload().expect(201);
      await settle();

      const all = rows();
      expect(all).toHaveLength(2);
      expect(all.map(r => r.vendorName).sort()).toEqual(['FairPrice', 'Grab']);
      // Same file, different boxes — nothing was cut up.
      expect(new Set(all.map(r => r.receiptFile)).size).toBe(1);
      expect(new Set(all.map(r => r.receiptBox)).size).toBe(2);
      // And they are tied together so a merge knows what to collapse.
      expect(new Set(all.map(r => r.receiptGroup)).size).toBe(1);
    });

    test('each record carries its OWN amount, not the combined total', async () => {
      parser.parseReceiptImage.mockResolvedValue({ split: true, receipts: TWO });
      await upload().expect(201);
      await settle();
      expect(rows().map(r => r.totalAmount).sort((a, b) => a - b)).toEqual([18.4, 62.1]);
    });

    test('both land at review-needed — a split is not a sign-off', async () => {
      parser.parseReceiptImage.mockResolvedValue({ split: true, receipts: TWO });
      await upload().expect(201);
      await settle();
      expect(rows().every(r => r.status === 'review-needed')).toBe(true);
    });

    test('a weak detection stays as ONE record holding the whole photo', async () => {
      // The guard that stops a phantom second receipt being invented.
      parser.parseReceiptImage.mockResolvedValue({ split: false, reason: 'boxes overlap', receipts: TWO });
      await upload().expect(201);
      await settle();

      const all = rows();
      expect(all).toHaveLength(1);
      expect(all[0].receiptBox).toBeFalsy();
      expect(all[0].vendorName).toBe('Grab');   // the first read is still applied
    });

    test('an unreadable photo leaves the single record intact', async () => {
      parser.parseReceiptImage.mockResolvedValue(null);
      await upload().expect(201);
      await settle();
      expect(rows()).toHaveLength(1);
    });
  });

  describe('a PDF with a receipt on each page', () => {
    test('becomes one record per page, sharing the file', async () => {
      jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)], numPages: 3, hasText: true, textPageCount: 3 });
      await upload(PDF_B64, 'application/pdf').expect(201);
      await settle();

      const all = rows();
      expect(all).toHaveLength(3);
      expect(all.map(r => r.receiptPage).sort()).toEqual([1, 2, 3]);
      expect(new Set(all.map(r => r.receiptFile)).size).toBe(1);
      pdfPages.extractPages.mockRestore();
    });

    test('a scanned PDF with no text layer stays as one record', async () => {
      // Splitting it would need a PDF renderer, which is a deliberate non-goal.
      jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: ['', ''], numPages: 2, hasText: false, textPageCount: 0 });
      await upload(PDF_B64, 'application/pdf').expect(201);
      await settle();
      expect(rows()).toHaveLength(1);
      pdfPages.extractPages.mockRestore();
    });

    test('a single-page PDF is an ordinary receipt', async () => {
      jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: ['a'.repeat(80)], numPages: 1, hasText: true, textPageCount: 1 });
      await upload(PDF_B64, 'application/pdf').expect(201);
      await settle();
      const all = rows();
      expect(all).toHaveLength(1);
      expect(all[0].receiptPage).toBeFalsy();
      pdfPages.extractPages.mockRestore();
    });

    test('a PDF is never sent to the vision parser', async () => {
      jest.spyOn(pdfPages, 'extractPages').mockResolvedValue({ pages: ['a'.repeat(80)], numPages: 1, hasText: true, textPageCount: 1 });
      await upload(PDF_B64, 'application/pdf').expect(201);
      await settle();
      expect(parser.parseReceiptImage).not.toHaveBeenCalled();
      pdfPages.extractPages.mockRestore();
    });
  });

  describe('undoing a split', () => {
    test('merge removes the siblings and restores the whole image', async () => {
      parser.parseReceiptImage.mockResolvedValue({ split: true, receipts: TWO });
      await upload().expect(201);
      await settle();
      const keep = rows()[0];

      const res = await request(app).post(`/api/receipts/${keep.id}/merge`).set('Authorization', auth()).expect(200);
      expect(res.body.removed).toBe(1);

      const all = rows();
      expect(all).toHaveLength(1);
      expect(all[0].receiptBox).toBeFalsy();
      expect(all[0].receiptGroup).toBeFalsy();
      // The file was never cut up, so the whole photo is still there.
      expect(receiptStore.forUser(testUser.id).exists(all[0].receiptFile)).toBe(true);
    });

    test('merging a receipt that was never split is refused', async () => {
      parser.parseReceiptImage.mockResolvedValue({ split: false, receipts: [TWO[0]] });
      const { body } = await upload().expect(201);
      await settle();
      await request(app).post(`/api/receipts/${body.receipt.id}/merge`).set('Authorization', auth()).expect(400);
    });
  });

  describe('deleting a split sibling', () => {
    test('the shared file survives while another record still uses it', async () => {
      parser.parseReceiptImage.mockResolvedValue({ split: true, receipts: TWO });
      await upload().expect(201);
      await settle();
      const [a, b] = rows();

      await request(app).delete(`/api/receipts/${a.id}`).set('Authorization', auth()).expect(200);
      // Deleting the file here would leave the other record pointing at nothing.
      expect(receiptStore.forUser(testUser.id).exists(b.receiptFile)).toBe(true);

      await request(app).delete(`/api/receipts/${b.id}`).set('Authorization', auth()).expect(200);
      expect(receiptStore.forUser(testUser.id).exists(b.receiptFile)).toBe(false);
    });
  });
});
