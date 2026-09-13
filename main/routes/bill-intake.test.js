const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');

// A bill added by hand goes through exactly the email pipeline — so the model
// and the PDF text extraction are mocked the same way the email tests mock
// them, and what is tested is the two ways in and the profile rules.
jest.mock('pdf-parse', () => jest.fn(async (buf) => ({ text: buf.toString('latin1').includes('EMPTY') ? '' : 'TAX INVOICE — Acme Supplies Pte Ltd — Invoice ACME-001 dated 10 Aug 2026 — Widgets — Subtotal SGD 1,000.00 GST 90.00 Total SGD 1,090.00', numpages: 1 })));
jest.mock('../email/llm-parser', () => ({ extractWithRetry: jest.fn() }));
jest.mock('../email/template-verifier', () => ({ verifyTemplateExtraction: jest.fn(async (t, p) => ({ parsed: p, disagreements: [], reviewReason: null, verified: false })) }));

const PDF = (tag = 'A') => Buffer.from(`%PDF-1.4 ${tag} some content`);
const b64 = buf => buf.toString('base64');

describe('bills added by hand', () => {
  let app, users, jwtSecret, testUser, invoiceStore, llm, jobs, settingsStore;
  const created = [];

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    invoiceStore = require('../utils/invoice-store');
    settingsStore = require('../utils/settings-store');
    llm = require('../email/llm-parser');
    llm.extractWithRetry.mockReset();
    llm.extractWithRetry.mockResolvedValue({
      vendorName: 'Acme Supplies', invoiceNumber: 'ACME-001', invoiceDate: '2026-08-10', dueDate: '2026-09-09',
      currency: 'SGD', totalAmount: 1090, subTotal: 1000, taxAmount: 90, lineItems: [{ description: 'Widgets', amount: 1000 }],
    });
    jobs = require('../jobs');
    testUser = await users.createUser(`b${Date.now()}@test.com`, 'password123', 'user');
    created.push(testUser.id);
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/invoices', require('./invoices'));
  });
  afterEach(() => { jobs._worker._reset(); });
  afterAll(() => {
    for (const id of created) { try { fs.rmSync(path.join(__dirname, '../data/users', String(id)), { recursive: true, force: true }); } catch {} }
  });

  const auth = () => `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`;
  const add  = body => request(serverFor(app)).post('/api/invoices').set('Authorization', auth()).send(body);
  const imp  = body => request(serverFor(app)).post('/api/invoices/import').set('Authorization', auth()).send(body);
  const waitJob = async (jobId) => {
    for (let i = 0; i < 100; i++) {
      const r = await request(serverFor(app)).get(`/api/invoices/import/${jobId}`).set('Authorization', auth());
      if (['done', 'failed', 'cancelled'].includes(r.body.stage)) return r.body;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('import did not finish');
  };

  describe('POST /api/invoices — one PDF', () => {
    test('requires authentication', async () => {
      await request(serverFor(app)).post('/api/invoices').send({}).expect(401);
    });

    test('stores the bill as a bill, waiting for review, through the same parser as email', async () => {
      const res = await add({ name: 'acme.pdf', data: b64(PDF()) }).expect(201);
      expect(res.body.records).toHaveLength(1);
      const row = invoiceStore.forUser(testUser.id).getById(res.body.records[0].id);
      expect(row.invoiceType).toBe('ACCPAY');
      expect(row.source).toBe('upload');
      expect(row.status).toBe('review-needed');
      expect(row.vendorName).toBe('Acme Supplies');
      expect(row.totalAmount).toBe(1090);
      expect(row.hasPdf).toBe(true);
      expect(llm.extractWithRetry).toHaveBeenCalledTimes(1);
    });

    test('never auto-posts, even with auto-process switched on', async () => {
      settingsStore.forUser(testUser.id).set({ autoProcess: true });
      const res = await add({ name: 'acme.pdf', data: b64(PDF()) }).expect(201);
      const row = invoiceStore.forUser(testUser.id).getById(res.body.records[0].id);
      expect(row.status).toBe('review-needed');   // an emailed bill would be 'pending' here
    });

    test('the same bill twice is refused and points at the first', async () => {
      const first = await add({ name: 'acme.pdf', data: b64(PDF()) }).expect(201);
      const again = await add({ name: 'acme-copy.pdf', data: b64(PDF('B')) }).expect(409);
      expect(again.body.duplicateOf).toBe(first.body.records[0].id);
      expect(invoiceStore.forUser(testUser.id).getAll()).toHaveLength(1);
    });

    test('a file that is not a PDF is refused with a reason', async () => {
      const res = await add({ name: 'photo.jpg', data: b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])) }).expect(400);
      expect(res.body.error).toMatch(/not a PDF/);
    });

    test('an empty or corrupt payload is refused, naming the file', async () => {
      const res = await add({ name: 'x.pdf', data: 'not base64 !!' }).expect(400);
      expect(res.body.error).toMatch(/x\.pdf/);
    });

    test('over 3MB is refused before any parsing', async () => {
      const big = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(3 * 1024 * 1024 + 1, 'x')]);
      await add({ name: 'huge.pdf', data: b64(big) }).expect(413);
      expect(llm.extractWithRetry).not.toHaveBeenCalled();
    });

    test('a PDF the model cannot read is still stored, for a person to type in', async () => {
      llm.extractWithRetry.mockRejectedValue(new Error('model down'));
      const res = await add({ name: 'blurry.pdf', data: b64(PDF()) }).expect(201);
      const row = invoiceStore.forUser(testUser.id).getById(res.body.records[0].id);
      expect(row.status).toBe('review-needed');
    });
  });

  describe('POST /api/invoices/import — a batch, as a job', () => {
    test('accepts several PDFs, runs them in the background, and reports each outcome', async () => {
      let n = 0;
      llm.extractWithRetry.mockImplementation(async () => ({
        vendorName: `Vendor ${++n}`, invoiceNumber: `V-${n}`, invoiceDate: '2026-08-10', currency: 'SGD', totalAmount: 100 * n,
      }));
      const res = await imp({ pdfs: [{ name: 'a.pdf', data: b64(PDF('A')) }, { name: 'b.pdf', data: b64(PDF('B')) }, { name: 'c.pdf', data: b64(PDF('C')) }] }).expect(202);
      const done = await waitJob(res.body.jobId);
      expect(done.stage).toBe('done');
      expect(done.filesTotal).toBe(3);
      expect(done.filesRead).toBe(3);
      expect(done.result.created).toHaveLength(3);
      const rows = invoiceStore.forUser(testUser.id).getAll();
      expect(rows).toHaveLength(3);
      expect(rows.every(r => r.status === 'review-needed' && r.source === 'upload' && r.invoiceType === 'ACCPAY')).toBe(true);
    });

    test('a zip of PDFs is expanded; anything in it that is not a PDF is ignored', async () => {
      const JSZip = require('jszip');
      const zip = new JSZip();
      zip.file('one.pdf', PDF('Z1')); zip.file('two.pdf', PDF('Z2')); zip.file('notes.txt', 'hi'); zip.file('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
      const archive = await zip.generateAsync({ type: 'nodebuffer' });
      let n = 0;
      llm.extractWithRetry.mockImplementation(async () => ({ vendorName: `Z ${++n}`, invoiceNumber: `Z-${n}`, invoiceDate: '2026-08-10', currency: 'SGD', totalAmount: 10 * n }));
      const res = await imp({ archives: [{ name: 'bills.zip', data: b64(archive) }] }).expect(202);
      const done = await waitJob(res.body.jobId);
      expect(done.stage).toBe('done');
      expect(done.result.created).toHaveLength(2);
      expect(llm.extractWithRetry).toHaveBeenCalledTimes(2);
    });

    test('a duplicate inside the batch is reported, not stored twice', async () => {
      const res = await imp({ pdfs: [{ name: 'a.pdf', data: b64(PDF('A')) }, { name: 'a-again.pdf', data: b64(PDF('A2')) }] }).expect(202);
      const done = await waitJob(res.body.jobId);
      expect(done.result.created).toHaveLength(1);
      expect(done.result.duplicates).toHaveLength(1);
      expect(invoiceStore.forUser(testUser.id).getAll()).toHaveLength(1);
    });

    test('nothing attached is a 400, not an empty job', async () => {
      await imp({ pdfs: [], archives: [] }).expect(400);
    });

    test('a bad file in the batch refuses the whole request, naming it', async () => {
      const res = await imp({ pdfs: [{ name: 'ok.pdf', data: b64(PDF()) }, { name: 'bad.pdf', data: 'zzz!!' }] }).expect(400);
      expect(res.body.error).toMatch(/bad\.pdf/);
    });

    test('GET /import/active shows the running bill import and nothing else', async () => {
      const res = await imp({ pdfs: [{ name: 'a.pdf', data: b64(PDF()) }] }).expect(202);
      await waitJob(res.body.jobId);
      const after = await request(serverFor(app)).get('/api/invoices/import/active').set('Authorization', auth()).expect(200);
      expect(after.body.job).toBeNull();
    });

    test('an unknown job id is a 404, and a claim job is not visible here', async () => {
      await request(serverFor(app)).get('/api/invoices/import/nope').set('Authorization', auth()).expect(404);
      const { job } = jobs.enqueue(testUser.id, { archives: [], forms: [] }); // a claim import
      await request(serverFor(app)).get(`/api/invoices/import/${job.id}`).set('Authorization', auth()).expect(404);
    });
  });
});
