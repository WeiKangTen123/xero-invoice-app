const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

// GET /api/xero-reports/ageing: which side, the user's timezone, force, and the
// same envelope as every other report. The report itself is mocked here; its
// figures and its Xero calls are tested in xero/ageing.test.js.
jest.mock('../xero/reports');
jest.mock('../utils/token-cache');

describe('GET /api/xero-reports/ageing', () => {
  let app, users, jwtSecret, testUser, reports, tokenCache;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    reports    = require('../xero/reports');
    tokenCache = require('../utils/token-cache');
    const routes = require('./xero-reports');

    testUser = await users.createUser(`ageing-${Date.now()}-${Math.random()}@test.com`, 'password123', 'user');
    app = express();
    app.use(express.json());
    app.use('/api/xero-reports', routes);
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }, { tenantId: 't2', tenantName: 'Org Two' }]);
    reports.getAgeing.mockResolvedValue({ side: 'receivables', total: 10, contacts: [], notes: [] });
  });

  const get = path => request(serverFor(app)).get(path)
    .set('Authorization', `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`);

  test('requires authentication', async () => {
    await request(serverFor(app)).get('/api/xero-reports/ageing?side=receivables').expect(401);
    expect(reports.getAgeing).not.toHaveBeenCalled();
  });

  test.each(['receivables', 'payables'])('side=%s is passed through with the user\'s timezone, unforced', async side => {
    users.saveUserConfig(testUser.id, { TIMEZONE: 'Asia/Singapore' });
    const res = await get(`/api/xero-reports/ageing?side=${side}`).expect(200);
    expect(reports.getAgeing).toHaveBeenCalledWith(testUser.id, 't1', { side, timezone: 'Asia/Singapore', force: false });
    expect(res.body).toMatchObject({ connected: true, activeTenantId: 't1', total: 10 });
    expect(res.body.tenants).toHaveLength(2);
  });

  test('?force=true and ?tenantId= are honoured like every other report', async () => {
    await get('/api/xero-reports/ageing?side=payables&force=true&tenantId=t2').expect(200);
    expect(reports.getAgeing).toHaveBeenCalledWith(testUser.id, 't2', expect.objectContaining({ side: 'payables', force: true }));
  });

  test.each([
    ['no side', ''],
    ['an unknown side', '?side=both'],
    ['the wrong case', '?side=Receivables'],
    ['a repeated side', '?side=receivables&side=payables'],
  ])('%s is a 400, and Xero is never asked', async (_, query) => {
    const res = await get(`/api/xero-reports/ageing${query}`).expect(400);
    expect(res.body.error).toMatch(/side must be receivables or payables/);
    expect(reports.getAgeing).not.toHaveBeenCalled();
  });

  test('no connection answers connected:false without calling the report', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([]);
    const res = await get('/api/xero-reports/ageing?side=receivables').expect(200);
    expect(res.body).toEqual({ connected: false, tenants: [] });
    expect(reports.getAgeing).not.toHaveBeenCalled();
  });

  test('a Xero failure is a readable 500, and a missing scope a reconnect prompt', async () => {
    reports.getAgeing.mockRejectedValueOnce(new Error('Xero is down'));
    const res = await get('/api/xero-reports/ageing?side=receivables').expect(500);
    expect(res.body.error).toBeTruthy();

    const scopeErr = new Error(JSON.stringify({ response: { statusCode: 403 }, body: { Detail: 'Forbidden resource' } }));
    reports.getAgeing.mockRejectedValueOnce(scopeErr);
    const r2 = await get('/api/xero-reports/ageing?side=receivables').expect(403);
    expect(r2.body.error).toMatch(/reconnect/i);
  });
});
