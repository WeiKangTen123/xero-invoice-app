const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

// What an upload is allowed to be, and how much the pairing dialog may ask of
// the server. Kept apart from receipts.test.js because nothing here touches
// sharp (no ?w= thumbnails are requested), so this file runs on any machine.
//
// The reader is mocked: the routes' job is to decide what is stored, whatever
// the model makes of it, and a live Gemini call has no place in a test.
jest.mock('../utils/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null),
  parseReceiptText:  jest.fn().mockResolvedValue(null),
}));
jest.mock('../claims/category-account', () => ({ resolveAccountCode: jest.fn().mockResolvedValue(null) }));

const _srv = { current: null };
afterEach(() => new Promise(resolve => {
  jest.restoreAllMocks();
  const s = _srv.current; _srv.current = null;
  if (s && s.listening) s.close(() => resolve()); else resolve();
}));

// Real first bytes of each format; distinct tails, because identical bytes are
// refused as a duplicate upload.
let _n = 0;
const tail = () => Buffer.from([++_n & 0xff, (_n >> 8) & 0xff]);
const b64 = buf => buf.toString('base64');
const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), tail()]);
const PNG  = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), Buffer.from('IHDR'), tail()]);
const PDF  = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), tail()]);
const HEIC = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(4), tail()]);
// What a renamed file really is: a Windows program, a script, plain text.
const EXE  = () => Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0, 3, 0, 0, 0, 4, 0]), Buffer.alloc(40), tail()]);
const TEXT = () => Buffer.concat([Buffer.from('#!/bin/sh\necho receipt\n'), tail()]);

describe('routes/receipts — upload safety and the pairing dialog', () => {
  let app, server, users, jwtSecret, testUser, invoiceStore, receiptStore, pairing;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    invoiceStore = require('../utils/invoice-store');
    receiptStore = require('../utils/receipt-store');
    pairing = require('../utils/pairing');
    pairing._reset();
    const receiptRoutes = require('./receipts');

    testUser = await users.createUser(`safe${Date.now()}${_n}@test.com`, 'password123', 'user');

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/receipts', receiptRoutes);
    server = _srv.current = app.listen(0);
  });

  const auth = () => `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`;
  const upload = (mime, buf) => request(server).post('/api/receipts').set('Authorization', auth()).send({ mime, data: b64(buf) });
  const pair = () => request(server).post('/api/receipts/pair').set('Authorization', auth()).expect(201);
  const capture = (token, mime, buf) => request(server).post(`/api/receipts/capture/${token}`).send({ mime, data: b64(buf) });
  const poll = token => request(server).get(`/api/receipts/pair/${token}`).set('Authorization', auth()).expect(200);
  const stored = () => invoiceStore.forUser(testUser.id).getAll();

  // Moves the clock the routes and jsonwebtoken read, without fake timers,
  // which would stall the HTTP server the requests go through.
  function clockAhead(ms) {
    const real = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => real() + ms);
  }

  // ── What a file is ────────────────────────────────────────────────────────
  describe('the contents decide, not the declared type', () => {
    test('real JPEG, PNG and PDF headers are accepted from the desktop', async () => {
      for (const [mime, buf] of [['image/jpeg', JPEG()], ['image/png', PNG()], ['application/pdf', PDF()]]) {
        const res = await upload(mime, buf).expect(201);
        expect(res.body.receipt.receiptMime).toBe(mime);
      }
      expect(stored()).toHaveLength(3);
    });

    test('a renamed text file or program is refused from the desktop, with a clear reason, and nothing is stored', async () => {
      for (const [mime, buf] of [['image/jpeg', TEXT()], ['application/pdf', EXE()], ['image/png', EXE()]]) {
        const res = await upload(mime, buf).expect(415);
        expect(res.body.error).toMatch(/not a JPEG, PNG or PDF/);
        expect(res.body.error).toMatch(/whatever its name or type says/);
      }
      expect(stored()).toHaveLength(0);
      const dir = receiptStore.forUser(testUser.id).dir;
      expect(require('fs').existsSync(dir) ? require('fs').readdirSync(dir) : []).toEqual([]);
    });

    test('a HEIC photo sent as a JPEG is named in the refusal', async () => {
      const res = await upload('image/jpeg', HEIC()).expect(415);
      expect(res.body.error).toMatch(/HEIC image, which Xero does not accept/);
    });

    test('a real receipt that was mislabelled is stored, and served back, as what it is', async () => {
      const res = await upload('image/jpeg', PNG()).expect(201);
      expect(res.body.receipt.receiptMime).toBe('image/png');
      expect(res.body.receipt.receiptFile).toMatch(/\.png$/);
      await request(server).get(`/api/receipts/${res.body.receipt.id}/image?token=${res.body.imageToken}`)
        .expect(200).expect('Content-Type', /image\/png/);
    });

    test('the declared type must still be one Xero takes, as before', async () => {
      await upload('image/heic', JPEG()).expect(400);
      await upload('text/html', JPEG()).expect(400);
    });

    test('a renamed file from a phone link is refused, says why, and does not spend an upload', async () => {
      const { body } = await pair();
      const res = await capture(body.token, 'image/jpeg', TEXT()).expect(415);
      expect(res.body.error).toMatch(/not a JPEG, PNG or PDF/);
      await capture(body.token, 'application/pdf', EXE()).expect(415);
      const state = (await poll(body.token)).body;
      expect(state.uploads).toBe(0);
      expect(state.usesLeft).toBe(pairing.MAX_USES);
      expect(stored()).toHaveLength(0);
      // A real photo through the same link still goes in.
      await capture(body.token, 'image/jpeg', JPEG()).expect(201);
    });
  });

  // ── The pairing dialog's thumbnails ───────────────────────────────────────
  // It polls every three seconds. A fresh token per receipt per poll changed
  // every thumbnail URL every time, so the browser fetched every image again,
  // and all of it counted against the office's shared IP limit.
  describe('image tokens in the pairing poll', () => {
    async function pairWithReceipts(count) {
      const { body } = await pair();
      const ids = [];
      for (let i = 0; i < count; i++) ids.push((await capture(body.token, 'image/jpeg', JPEG()).expect(201)).body.receipt.id);
      return { token: body.token, ids };
    }
    const tokensOf = res => Object.fromEntries(res.body.receipts.map(r => [r.id, r.imageToken]));

    test('stay the same poll after poll, one per receipt, and open the image', async () => {
      const { token, ids } = await pairWithReceipts(2);
      const first = tokensOf(await poll(token));
      clockAhead(5000);   // a second later, so a re-minted token could not come out identical
      const second = tokensOf(await poll(token));
      expect(second).toEqual(first);
      expect(first[ids[0]]).not.toBe(first[ids[1]]);
      await request(server).get(`/api/receipts/${ids[0]}/image?token=${first[ids[0]]}`).expect(200);
    });

    test('are still reused with well over a minute left', async () => {
      const { token, ids } = await pairWithReceipts(1);
      const before = tokensOf(await poll(token))[ids[0]];
      clockAhead(3.5 * 60 * 1000);
      expect(tokensOf(await poll(token))[ids[0]]).toBe(before);
    });

    test('are replaced once less than a minute is left, and the new one works', async () => {
      const { token, ids } = await pairWithReceipts(1);
      const before = tokensOf(await poll(token))[ids[0]];
      clockAhead(4.5 * 60 * 1000);
      const after = tokensOf(await poll(token))[ids[0]];
      expect(after).not.toBe(before);
      expect(jwt.decode(after).exp * 1000).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
      await request(server).get(`/api/receipts/${ids[0]}/image?token=${after}`).expect(200);
      // And it is then the one handed out.
      expect(tokensOf(await poll(token))[ids[0]]).toBe(after);
    });

    test('the review page still gets a token with its whole five minutes', async () => {
      // InvoiceReview refreshes on a four-minute timer, so GET /:id/token must
      // not hand it a reused token that is part-way through its life.
      const { token, ids } = await pairWithReceipts(1);
      await poll(token);
      clockAhead(3 * 60 * 1000);
      const res = await request(server).get(`/api/receipts/${ids[0]}/token`).set('Authorization', auth()).expect(200);
      expect(jwt.decode(res.body.token).exp * 1000).toBeGreaterThan(Date.now() + 4.9 * 60 * 1000);
    });
  });

  // ── How many codes an account holds ───────────────────────────────────────
  test('a fourth pairing code revokes the oldest, and the other three keep working', async () => {
    const tokens = [];
    for (let i = 0; i < 4; i++) tokens.push((await pair()).body.token);
    await request(server).get(`/api/receipts/capture/${tokens[0]}`).expect(401);
    for (const t of tokens.slice(1)) await request(server).get(`/api/receipts/capture/${t}`).expect(200);
  });
});
