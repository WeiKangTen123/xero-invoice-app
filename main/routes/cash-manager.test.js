const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// The Cash Flow Manager's routes: /api/cash-manager (the entries, changes and
// bank options kept in this app, against the real store and test database)
// and, on /api/xero-reports, the projection, its check and its export. The
// report layer and the document module are mocked, so nothing here reaches
// Xero or builds a real file.
jest.mock('../xero/reports');
jest.mock('../utils/token-cache');
jest.mock('../reports/cash-manager-doc', () => ({
  cashManagerDefinition: jest.fn(() => ({ content: ['cash manager'] })),
  cashManagerWorkbook:   jest.fn(() => ({ xlsx: { write: jest.fn(async res => { res.write('xlsx-bytes'); }) } })),
  cashManagerFilename:   jest.fn((payload, format, days) => `Cash Flow Manager - ${payload.organisation.name} - ${days} days.${format}`),
}), { virtual: true });
jest.mock('../reports/budget-render', () => ({
  streamPdf: jest.fn((definition, res) => { res.end('pdf-bytes'); }),
  budgetVsActualWorkbook: jest.fn(), budgetVarianceWorkbook: jest.fn(),
}));

describe('routes/cash-manager and the cash manager report routes', () => {
  let app, users, jwtSecret, testUser, otherUser, reports, tokenCache, doc, budgetRender, reportCache;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    reports      = require('../xero/reports');
    tokenCache   = require('../utils/token-cache');
    doc          = require('../reports/cash-manager-doc');
    budgetRender = require('../reports/budget-render');
    reportCache  = require('../xero/report-cache');

    testUser  = await users.createUser(`cm-route-${Date.now()}@test.com`, 'password123', 'user');
    otherUser = await users.createUser(`cm-other-${Date.now()}@test.com`, 'password123', 'user');
    tokenCache.getPersistedTenants.mockImplementation(id => (id === testUser.id
      ? [{ tenantId: 't1', tenantName: 'Org One' }, { tenantId: 't2', tenantName: 'Org Two' }]
      : [{ tenantId: 't1', tenantName: 'Org One' }]));

    app = express();
    app.use(express.json());
    app.use('/api/cash-manager', require('./cash-manager'));
    app.use('/api/xero-reports', require('./xero-reports'));
  });

  const tokenFor = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  const as = (user, req) => req.set('Authorization', `Bearer ${tokenFor(user)}`);
  const api = (method, path, user = testUser) => as(user, request(serverFor(app))[method](`/api/cash-manager${path}`));

  const ENTRY = { tenantId: 't1', direction: 'in', description: 'Grant', amount: 1200.5, date: '2026-11-03', frequency: 'once' };

  test('the report layer is the mock: nothing here reaches Xero', () => {
    expect(jest.isMockFunction(reports.getCashManager)).toBe(true);
  });

  describe('/api/cash-manager', () => {
    test('every route requires authentication', async () => {
      const server = serverFor(app);
      await request(server).get('/api/cash-manager/entries?tenantId=t1').expect(401);
      await request(server).post('/api/cash-manager/entries').send(ENTRY).expect(401);
      await request(server).patch('/api/cash-manager/entries/x').send({ tenantId: 't1' }).expect(401);
      await request(server).delete('/api/cash-manager/entries/x?tenantId=t1').expect(401);
      await request(server).put('/api/cash-manager/overrides').send({ tenantId: 't1', key: 'invoice:a', excluded: true }).expect(401);
      await request(server).delete('/api/cash-manager/overrides?tenantId=t1&key=invoice:a').expect(401);
      await request(server).get('/api/cash-manager/bank-options?tenantId=t1').expect(401);
      await request(server).put('/api/cash-manager/bank-options').send({ tenantId: 't1', accounts: {} }).expect(401);
    });

    test('a tenant is required, and must be one this person has connected', async () => {
      expect((await api('get', '/entries').expect(400)).body).toEqual({ error: 'tenantId is required' });
      expect((await api('post', '/entries').send({ ...ENTRY, tenantId: undefined }).expect(400)).body.error).toMatch(/tenantId is required/);
      expect((await api('post', '/entries').send({ ...ENTRY, tenantId: 't9' }).expect(403)).body.error).toMatch(/not connected/);
      // Connected for one person is not connected for another.
      expect((await api('post', '/entries', otherUser).send({ ...ENTRY, tenantId: 't2' }).expect(403)).body.error).toMatch(/not connected/);
      await api('put', '/overrides').send({ tenantId: 't9', key: 'invoice:a', excluded: true }).expect(403);
      await api('put', '/bank-options').send({ tenantId: 't9', accounts: { a: { included: false } } }).expect(403);
      await api('get', '/bank-options?tenantId=t9').expect(403);
      expect((await api('get', '/entries?tenantId=t1').expect(200)).body).toEqual({ entries: [] });
    });

    test('entries: create, list, change, delete', async () => {
      const created = (await api('post', '/entries').send({ ...ENTRY, frequency: 'monthly', endDate: '2027-03-03' }).expect(201)).body.entry;
      expect(created).toMatchObject({ direction: 'in', description: 'Grant', amount: 1200.5, date: '2026-11-03', frequency: 'monthly', endDate: '2027-03-03', createdBy: testUser.email });

      expect((await api('get', '/entries?tenantId=t1').expect(200)).body.entries).toEqual([created]);
      expect((await api('get', '/entries?tenantId=t2').expect(200)).body.entries).toEqual([]);

      const changed = (await api('patch', `/entries/${created.id}`).send({ tenantId: 't1', amount: 99, description: 'Grant (part)' }).expect(200)).body.entry;
      expect(changed).toMatchObject({ amount: 99, description: 'Grant (part)', frequency: 'monthly' });

      await api('delete', `/entries/${created.id}?tenantId=t1`).expect(200, { ok: true });
      await api('delete', `/entries/${created.id}?tenantId=t1`).expect(404);
      await api('patch', `/entries/${created.id}`).send({ tenantId: 't1', amount: 1 }).expect(404);
    });

    test('bad entries are a 400 that says what was wrong, and nothing is saved', async () => {
      const cases = [
        [{ direction: 'up' },            /direction/],
        [{ description: '' },            /description is required/],
        [{ description: 'x'.repeat(121) }, /120 characters/],
        [{ amount: 0 },                  /more than 0/],
        [{ amount: 2e9 },                /1,000,000,000/],
        [{ amount: 1.001 },              /two decimal places/],
        [{ date: '2026-11-31' },         /date must be a date/],
        [{ frequency: 'quarterly' },     /frequency must be one of/],
        [{ frequency: 'weekly', endDate: '2026-01-01' }, /endDate cannot be before date/],
      ];
      for (const [bad, re] of cases) {
        const res = await api('post', '/entries').send({ ...ENTRY, ...bad });
        expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
        expect(res.body.error).toMatch(re);
      }
      const ok = (await api('post', '/entries').send(ENTRY).expect(201)).body.entry;
      expect((await api('patch', `/entries/${ok.id}`).send({ tenantId: 't1', amount: -1 }).expect(400)).body.error).toMatch(/negative/);
      expect((await api('get', '/entries?tenantId=t1')).body.entries).toHaveLength(1);
    });

    test('another person\'s entry cannot be changed or deleted, even in an organisation both have', async () => {
      const mine = (await api('post', '/entries').send(ENTRY).expect(201)).body.entry;
      await api('patch', `/entries/${mine.id}`, otherUser).send({ tenantId: 't1', amount: 1 }).expect(404);
      await api('delete', `/entries/${mine.id}?tenantId=t1`, otherUser).expect(404);
      expect((await api('get', '/entries?tenantId=t1', otherUser)).body.entries).toEqual([]);
      expect((await api('get', '/entries?tenantId=t1')).body.entries).toHaveLength(1);
    });

    test('overrides: set, merged, cleared, deleted; bad ones refused', async () => {
      const key = 'invoice:0e1f-22';
      expect((await api('put', '/overrides').send({ tenantId: 't1', key, date: '2026-12-01' }).expect(200)).body.override)
        .toMatchObject({ key, date: '2026-12-01', amount: null, excluded: false, updatedBy: testUser.email });
      expect((await api('put', '/overrides').send({ tenantId: 't1', key, amount: 50, excluded: true }).expect(200)).body.override)
        .toMatchObject({ date: '2026-12-01', amount: 50, excluded: true });
      expect((await api('put', '/overrides').send({ tenantId: 't1', key, date: null, amount: null, excluded: false }).expect(200)).body)
        .toEqual({ override: null });

      await api('put', '/overrides').send({ tenantId: 't1', key, excluded: true }).expect(200);
      await api('delete', `/overrides?tenantId=t1&key=${encodeURIComponent(key)}`).expect(200, { ok: true });

      expect((await api('put', '/overrides').send({ tenantId: 't1', key: 'invoice:a b', excluded: true }).expect(400)).body.error).toMatch(/key/);
      expect((await api('put', '/overrides').send({ tenantId: 't1', key: 'manual:e1:2026-02-30', excluded: true }).expect(400)).body.error).toMatch(/date that does not exist/);
      expect((await api('put', '/overrides').send({ tenantId: 't1', key, date: 'tomorrow' }).expect(400)).body.error).toMatch(/date must be/);
      expect((await api('put', '/overrides').send({ tenantId: 't1', key }).expect(400)).body.error).toMatch(/Give a date, an amount or excluded/);
      expect((await api('delete', '/overrides?tenantId=t1&key=nonsense').expect(400)).body.error).toMatch(/key/);
    });

    test('bank options: read and saved per account, in the units the screen speaks', async () => {
      expect((await api('get', '/bank-options?tenantId=t1').expect(200)).body).toEqual({ accounts: {} });
      const saved = (await api('put', '/bank-options').send({ tenantId: 't1', accounts: {
        'a-op': { openingAdjustment: -250.75, overdraft: 10000 },
        'a-sav': { included: false },
      } }).expect(200)).body;
      expect(saved).toEqual({ accounts: {
        'a-op':  { included: true,  openingAdjustment: -250.75, overdraft: 10000 },
        'a-sav': { included: false, openingAdjustment: 0,       overdraft: 0 },
      } });
      expect((await api('get', '/bank-options?tenantId=t1').expect(200)).body).toEqual(saved);
      expect((await api('get', '/bank-options?tenantId=t2').expect(200)).body).toEqual({ accounts: {} });

      expect((await api('put', '/bank-options').send({ tenantId: 't1', accounts: { 'a-op': { overdraft: -1 } } }).expect(400)).body.error).toMatch(/negative/);
      expect((await api('put', '/bank-options').send({ tenantId: 't1' }).expect(400)).body.error).toMatch(/accounts must be an object/);
      expect((await api('get', '/bank-options?tenantId=t1')).body).toEqual(saved);
    });

    test('a write leaves the cached Xero reads alone: the projection is rebuilt from them and the database', async () => {
      reportCache._cacheSet(`outstanding:${testUser.id}:t1`, { invoices: [] });
      reportCache._cacheSet(`repeating:${testUser.id}:t1`, { templates: [] });
      await api('post', '/entries').send(ENTRY).expect(201);
      await api('put', '/overrides').send({ tenantId: 't1', key: 'invoice:a', excluded: true }).expect(200);
      await api('put', '/bank-options').send({ tenantId: 't1', accounts: { a: { included: false } } }).expect(200);
      expect(reportCache._cacheGet(`outstanding:${testUser.id}:t1`, false)).toMatchObject({ invoices: [], cached: true });
      expect(reportCache._cacheGet(`repeating:${testUser.id}:t1`, false)).toMatchObject({ templates: [] });
      expect(reports.getCashManager).not.toHaveBeenCalled();
    });
  });

  describe('/api/xero-reports/cash-manager and /cash-manager-check', () => {
    const get = (route, qs) => as(testUser, request(serverFor(app)).get(`/api/xero-reports/${route}${qs ? `?${qs}` : ''}`));
    const PAYLOAD = { organisation: { name: 'Org One', currency: 'SGD' }, today: '2026-10-12', horizonDays: 90, items: [], series: [], notes: [], cached: true, fetchedAt: 1 };
    const VERDICT = { ok: true, checkedAt: '2026-10-12T04:00:00.000Z', calls: 0, checks: [{ key: 'balance' }, { key: 'receivables' }, { key: 'payables' }], notes: [], period: null };

    for (const [route, fn, answer] of [['cash-manager', 'getCashManager', PAYLOAD], ['cash-manager-check', 'getCashManagerCheck', VERDICT]]) {
      describe(`GET /${route}`, () => {
        test('requires authentication', async () => {
          await request(serverFor(app)).get(`/api/xero-reports/${route}`).expect(401);
        });

        test('answers connected:false without a tenant, and asks for nothing', async () => {
          tokenCache.getPersistedTenants.mockReturnValue([]);
          expect((await get(route).expect(200)).body).toEqual({ connected: false, tenants: [] });
          expect(reports[fn]).not.toHaveBeenCalled();
        });

        test('passes the user, the organisation, the timezone and force, and answers in the envelope', async () => {
          reports[fn].mockResolvedValue(answer);
          const res = await get(route, 'tenantId=t2&force=true').expect(200);
          expect(reports[fn]).toHaveBeenCalledWith(testUser.id, 't2', { timezone: expect.any(String), force: true });
          expect(res.body).toMatchObject({ connected: true, activeTenantId: 't2', ...answer });
          await get(route).expect(200);
          expect(reports[fn]).toHaveBeenLastCalledWith(testUser.id, 't1', { timezone: expect.any(String), force: false });
        });

        test('a scope error is a 403 reconnect prompt', async () => {
          reports[fn].mockRejectedValue({ response: { statusCode: 403, body: {} } });
          expect((await get(route).expect(403)).body.error).toMatch(/reconnect in Setup/);
        });
      });
    }
  });

  describe('the cashmanager export', () => {
    const exportUrl = qs => as(testUser, request(serverFor(app)).get(`/api/xero-reports/budget/export-url?${qs}`));
    const PAYLOAD = { organisation: { name: 'Org One', currency: 'SGD' }, today: '2026-10-12', items: [], series: [] };
    const tokenIn = url => jwt.verify(decodeURIComponent(url.split('token=')[1]), jwtSecret());

    test('the link carries the organisation, the format and the days, and is signed without reading the report', async () => {
      const res = await exportUrl('kind=cashmanager&format=xlsx&days=30&tenantId=t2').expect(200);
      expect(tokenIn(res.body.url)).toMatchObject({ userId: testUser.id, tenantId: 't2', kind: 'cashmanager', format: 'xlsx', days: 30, purpose: 'budget-export' });
      expect(reports.getCashManager).not.toHaveBeenCalled();
      expect(tokenIn((await exportUrl('kind=cashmanager&format=pdf').expect(200)).body.url)).toMatchObject({ days: 90, tenantId: 't1' });
    });

    test('any other number of days is refused', async () => {
      for (const days of ['45', '0', 'all', '90.5']) {
        expect((await exportUrl(`kind=cashmanager&format=pdf&days=${days}`).expect(400)).body.error).toBe('days must be 30, 60 or 90');
      }
    });

    test('a PDF reads the payload the tab shows and streams the document module\'s definition', async () => {
      reports.getCashManager.mockResolvedValue(PAYLOAD);
      const { url } = (await exportUrl('kind=cashmanager&format=pdf&days=60').expect(200)).body;
      const res = await request(serverFor(app)).get(url).expect(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toContain('filename="Cash Flow Manager - Org One - 60 days.pdf"');
      expect(reports.getCashManager).toHaveBeenCalledWith(testUser.id, 't1', { timezone: expect.any(String) });
      expect(doc.cashManagerDefinition).toHaveBeenCalledWith(PAYLOAD, { timezone: expect.any(String), days: 60 });
      expect(doc.cashManagerFilename).toHaveBeenCalledWith(PAYLOAD, 'pdf', 60);
      expect(budgetRender.streamPdf).toHaveBeenCalledWith({ content: ['cash manager'] }, expect.anything());
    });

    test('an xlsx writes the document module\'s workbook', async () => {
      reports.getCashManager.mockResolvedValue(PAYLOAD);
      const { url } = (await exportUrl('kind=cashmanager&format=xlsx&days=90').expect(200)).body;
      const res = await request(serverFor(app)).get(url).expect(200);
      expect(res.headers['content-type']).toMatch(/spreadsheetml/);
      expect(res.headers['content-disposition']).toContain('filename="Cash Flow Manager - Org One - 90 days.xlsx"');
      expect(doc.cashManagerWorkbook).toHaveBeenCalledWith(PAYLOAD, { timezone: expect.any(String), days: 90 });
    });

    test('a failure building it is a 500 for that export, said plainly', async () => {
      reports.getCashManager.mockResolvedValue(PAYLOAD);
      doc.cashManagerDefinition.mockImplementationOnce(() => { throw new Error('no font'); });
      const { url } = (await exportUrl('kind=cashmanager&format=pdf').expect(200)).body;
      const res = await request(serverFor(app)).get(url).expect(500);
      expect(res.text).toBe('Could not build the export.');
    });
  });
});
