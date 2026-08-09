const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

jest.mock('../xero/reports');
jest.mock('../utils/token-cache');

describe('routes/xero-reports', () => {
  let app, users, jwtSecret, testUser, reports, tokenCache;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    reports    = require('../xero/reports');
    tokenCache = require('../utils/token-cache');
    const xeroReportsRoutes = require('./xero-reports');

    testUser = await users.createUser('user@test.com', 'password123', 'user');

    app = express();
    app.use(express.json());
    app.use('/api/xero-reports', xeroReportsRoutes);
  });

  function tokenFor(user) {
    return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  }

  test('requires authentication', async () => {
    await request(app).get('/api/xero-reports/summary').expect(401);
  });

  test('returns connected:false when the user has no persisted tenant, without calling reports.getSummary', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([]);
    const res = await request(app)
      .get('/api/xero-reports/summary')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);
    expect(res.body).toEqual({ connected: false, tenants: [] });
    expect(reports.getSummary).not.toHaveBeenCalled();
  });

  test('defaults to the first persisted tenant when none is requested', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([
      { tenantId: 't1', tenantName: 'Org One' },
      { tenantId: 't2', tenantName: 'Org Two' },
    ]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    const res = await request(app)
      .get('/api/xero-reports/summary')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't1', { force: false });
    expect(res.body.activeTenantId).toBe('t1');
    expect(res.body.tenants).toHaveLength(2);
  });

  test('?tenantId picks a specific connected tenant', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([
      { tenantId: 't1', tenantName: 'Org One' },
      { tenantId: 't2', tenantName: 'Org Two' },
    ]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    await request(app)
      .get('/api/xero-reports/summary?tenantId=t2')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't2', { force: false });
  });

  test('a ?tenantId the user does not actually have falls back to their first tenant, not an arbitrary org', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    await request(app)
      .get('/api/xero-reports/summary?tenantId=someone-elses-tenant')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't1', { force: false });
  });

  test('?force=true is threaded through to reports.getSummary', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    await request(app)
      .get('/api/xero-reports/summary?force=true')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't1', { force: true });
  });

  test('surfaces a Xero API failure as 500 with a readable message, not a crash', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
    reports.getSummary.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));

    const res = await request(app)
      .get('/api/xero-reports/summary')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(500);
    expect(res.body.error).toMatch(/rate limit/i);
  });
});
