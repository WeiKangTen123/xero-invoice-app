const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');
const ExcelJS = require('exceljs');

// Invoices typed in or read from a spreadsheet. No file to parse, no model to
// mock: what is tested is validation, grouping rows into invoices, dedup, and
// the profile rule that a hand-made invoice waits for review.
describe('invoices composed by hand', () => {
  let app, users, jwtSecret, testUser, invoiceStore, jobs, settingsStore;
  const created = [];
  const b64 = buf => Buffer.from(buf).toString('base64');

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    invoiceStore = require('../utils/invoice-store');
    settingsStore = require('../utils/settings-store');
    jobs = require('../jobs');
    testUser = await users.createUser(`i${Date.now()}@test.com`, 'password123', 'user');
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
  const compose = body => request(serverFor(app)).post('/api/invoices/compose').set('Authorization', auth()).send(body);
  const imp     = body => request(serverFor(app)).post('/api/invoices/import').set('Authorization', auth()).send(body);
  const waitJob = async (jobId) => {
    for (let i = 0; i < 100; i++) {
      const r = await request(serverFor(app)).get(`/api/invoices/import/${jobId}`).set('Authorization', auth());
      if (['done', 'failed', 'cancelled'].includes(r.body.stage)) return r.body;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('import did not finish');
  };

  const good = () => ({
    contactName: 'PereOcean Demo', contactEmail: 'ops@pereocean.example', invoiceNumber: 'PO-2026-014',
    invoiceDate: '10/08/2026', termsDays: 30, currency: 'sgd',
    lineItems: [{ description: 'Water cartons', unitAmount: 1000 }, { description: 'Delivery', unitAmount: 250, discountRate: 10, taxPercent: 9 }],
  });

  describe('POST /api/invoices/compose', () => {
    test('requires authentication', async () => {
      await request(serverFor(app)).post('/api/invoices/compose').send(good()).expect(401);
    });

    test('a valid invoice is stored as a customer invoice, waiting for review, with its lines and totals', async () => {
      const res = await compose(good()).expect(201);
      const row = invoiceStore.forUser(testUser.id).getById(res.body.id);
      expect(row.invoiceType).toBe('ACCREC');
      expect(row.source).toBe('form');
      expect(row.status).toBe('review-needed');
      expect(row.contactName).toBe('PereOcean Demo');
      expect(row.invoiceNumber).toBe('PO-2026-014');
      expect(row.invoiceDate).toBe('2026-08-10');
      expect(row.dueDate).toBe('2026-09-09');          // 30 days from the invoice date, not from today
      expect(row.currency).toBe('SGD');
      expect(row.lineItems).toHaveLength(2);
      // 1000 + (250 less 10%) = 1225; 9% tax on the 225 = 20.25
      expect(row.subTotal).toBe(1225);
      expect(row.taxAmount).toBe(20.25);
      expect(row.totalAmount).toBe(1245.25);
    });

    test('never auto-posts, even with auto-process on', async () => {
      settingsStore.forUser(testUser.id).set({ autoProcess: true });
      const res = await compose(good()).expect(201);
      expect(invoiceStore.forUser(testUser.id).getById(res.body.id).status).toBe('review-needed');
    });

    test.each([
      ['no customer',        { ...good(), contactName: '' },                          /Customer is required/],
      ['no line items',      { ...good(), lineItems: [] },                            /At least one line item/],
      ['a line without an amount', { ...good(), lineItems: [{ description: 'x' }] }, /Line 1 has no amount/],
      ['a negative amount',  { ...good(), lineItems: [{ description: 'x', unitAmount: -5 }] }, /negative/],
      ['a bad currency',     { ...good(), currency: 'dollars' },                      /3-letter code/],
      ['an unreadable date', { ...good(), invoiceDate: 'sometime' },                  /Invoice date could not be read/],
    ])('%s is refused, naming the field', async (_, body, msg) => {
      const res = await compose(body).expect(400);
      expect(res.body.error).toMatch(msg);
      expect(res.body.errors[0].field).toBeTruthy();
    });

    test('missing number and dates get the same fallbacks the email template does', async () => {
      const res = await compose({ contactName: 'X', lineItems: [{ description: 'y', unitAmount: 10 }] }).expect(201);
      const row = invoiceStore.forUser(testUser.id).getById(res.body.id);
      expect(row.invoiceNumber).toMatch(/^INV-\d{12,}$/);
      expect(row.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.dueDate > row.invoiceDate).toBe(true);
    });

    test('the same invoice twice is refused and points at the first', async () => {
      const first = await compose(good()).expect(201);
      const again = await compose(good()).expect(409);
      expect(again.body.duplicateOf).toBe(first.body.id);
      expect(invoiceStore.forUser(testUser.id).getAll()).toHaveLength(1);
    });
  });

  describe('POST /api/invoices/import — a spreadsheet', () => {
    async function xlsx(rows, headers = ['Invoice Number', 'Customer', 'Email', 'Invoice Date', 'Due Date', 'Currency', 'Description', 'Amount', 'Discount', 'Tax']) {
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Invoices');
      ws.addRow(['Sales invoices — September']); ws.addRow([]);   // a title above the header, as real sheets have
      ws.addRow(headers);
      for (const r of rows) ws.addRow(r);
      return Buffer.from(await wb.xlsx.writeBuffer());
    }

    test('rows sharing an invoice number become one invoice with several lines', async () => {
      const buf = await xlsx([
        ['S-001', 'Acme Ltd', 'a@acme.example', '2026-08-01', '2026-08-31', 'SGD', 'Consulting', 2000, null, null],
        ['',      '',         '',               '',           '',           '',    'Expenses',   150,  null, null],
        ['S-002', 'Beta Co',  '',               '2026-08-02', '',           'USD', 'Licence',    500,  10,   null],
      ]);
      const res = await imp({ sheets: [{ name: 'sept.xlsx', data: b64(buf) }] }).expect(202);
      const done = await waitJob(res.body.jobId);
      expect(done.stage).toBe('done');
      expect(done.result.created).toHaveLength(2);
      const rows = invoiceStore.forUser(testUser.id).getAll();
      const s1 = rows.find(r => r.invoiceNumber === 'S-001');
      expect(s1.lineItems).toHaveLength(2);
      expect(s1.totalAmount).toBe(2150);
      expect(s1.dueDate).toBe('2026-08-31');
      const s2 = rows.find(r => r.invoiceNumber === 'S-002');
      expect(s2.totalAmount).toBe(450);
      expect(rows.every(r => r.invoiceType === 'ACCREC' && r.source === 'spreadsheet' && r.status === 'review-needed')).toBe(true);
    });

    test('a CSV works the same way, with quoted commas', async () => {
      const csv = 'Customer,Invoice Number,Description,Amount,Currency\n"Gamma, Inc",G-1,"Design, phase 1",1200,SGD\n,,"Phase 2",800,\n';
      const res = await imp({ sheets: [{ name: 'inv.csv', data: b64(Buffer.from(csv)) }] }).expect(202);
      const done = await waitJob(res.body.jobId);
      expect(done.result.created).toHaveLength(1);
      const row = invoiceStore.forUser(testUser.id).getAll()[0];
      expect(row.contactName).toBe('Gamma, Inc');
      expect(row.lineItems.map(l => l.description)).toEqual(['Design, phase 1', 'Phase 2']);
      expect(row.totalAmount).toBe(2000);
    });

    test('a row that cannot become an invoice is reported by row, and the rest still import', async () => {
      const buf = await xlsx([
        ['S-001', 'Acme Ltd', '', '2026-08-01', '', 'SGD', 'Consulting', 2000, null, null],
        ['S-002', '',         '', '2026-08-02', '', 'SGD', 'No customer', 500,  null, null],
      ]);
      const res = await imp({ sheets: [{ name: 'sept.xlsx', data: b64(buf) }] }).expect(202);
      const done = await waitJob(res.body.jobId);
      expect(done.result.created).toHaveLength(1);
      expect(done.result.rejected).toEqual([expect.objectContaining({ row: 5, error: expect.stringMatching(/Customer is required/) })]);
    });

    test('a sheet with no recognisable header is rejected with a hint', async () => {
      const buf = await xlsx([[1, 2, 3]], ['Foo', 'Bar', 'Baz']);
      const res = await imp({ sheets: [{ name: 'odd.xlsx', data: b64(buf) }] }).expect(202);
      const done = await waitJob(res.body.jobId);
      expect(done.result.created).toHaveLength(0);
      expect(done.result.rejected[0].error).toMatch(/no header row found/);
    });

    test('bills and invoices are not imported in one request', async () => {
      const res = await imp({ sheets: [{ name: 'a.csv', data: b64(Buffer.from('Customer,Amount\nX,1')) }], pdfs: [{ name: 'b.pdf', data: b64(Buffer.from('%PDF-1.4 x')) }] }).expect(400);
      expect(res.body.error).toMatch(/separately/);
    });
  });
});
