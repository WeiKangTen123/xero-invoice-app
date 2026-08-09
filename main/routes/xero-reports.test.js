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

  describe('GET /period', () => {
    test('returns connected:false with no tenant, without calling reports.getPeriod', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([]);
      const res = await request(app)
        .get('/api/xero-reports/period')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);
      expect(res.body).toEqual({ connected: false, tenants: [] });
      expect(reports.getPeriod).not.toHaveBeenCalled();
    });

    test('threads preset/from/to/force through, and passes this user\'s timezone default', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getPeriod.mockResolvedValue({ range: {}, totals: {}, granularity: 'day', trend: [] });

      await request(app)
        .get('/api/xero-reports/period?preset=custom&from=2026-01-01&to=2026-01-31&force=true')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getPeriod).toHaveBeenCalledWith(testUser.id, 't1', {
        preset: 'custom', from: '2026-01-01', to: '2026-01-31', timezone: 'Asia/Singapore', force: true,
      });
    });

    test('uses this user\'s saved timezone preference when set', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getPeriod.mockResolvedValue({ range: {}, totals: {}, granularity: 'day', trend: [] });
      users.saveUserConfig(testUser.id, { TIMEZONE: 'America/New_York' });

      await request(app)
        .get('/api/xero-reports/period')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getPeriod).toHaveBeenCalledWith(testUser.id, 't1', expect.objectContaining({ timezone: 'America/New_York' }));
    });

    test('a bad custom range surfaces as 400, not 500', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getPeriod.mockRejectedValue(new Error('Custom range requires valid "from" and "to" dates (YYYY-MM-DD)'));

      const res = await request(app)
        .get('/api/xero-reports/period?preset=custom')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(400);
      expect(res.body.error).toMatch(/valid/i);
    });

    test('a real Xero failure still surfaces as 500', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getPeriod.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));

      await request(app)
        .get('/api/xero-reports/period')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(500);
    });
  });

  describe('GET /accounts, /bank-accounts, /contacts', () => {
    test('all three require authentication', async () => {
      await request(app).get('/api/xero-reports/accounts').expect(401);
      await request(app).get('/api/xero-reports/bank-accounts').expect(401);
      await request(app).get('/api/xero-reports/contacts').expect(401);
    });

    test('all three return connected:false with no tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([]);
      for (const path of ['accounts', 'bank-accounts', 'contacts']) {
        const res = await request(app)
          .get(`/api/xero-reports/${path}`)
          .set('Authorization', `Bearer ${tokenFor(testUser)}`)
          .expect(200);
        expect(res.body).toEqual({ connected: false, tenants: [] });
      }
    });

    test('GET /accounts calls reports.getAccounts for the resolved tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getAccounts.mockResolvedValue({ accounts: [{ code: '200', name: 'Sales' }] });

      const res = await request(app)
        .get('/api/xero-reports/accounts')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getAccounts).toHaveBeenCalledWith(testUser.id, 't1', { force: false });
      expect(res.body.accounts).toHaveLength(1);
    });

    test('GET /bank-accounts calls reports.getBankAccounts for the resolved tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getBankAccounts.mockResolvedValue({ bankAccounts: [] });

      await request(app)
        .get('/api/xero-reports/bank-accounts?force=true')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getBankAccounts).toHaveBeenCalledWith(testUser.id, 't1', { force: true });
    });

    test('GET /contacts calls reports.getContacts for the resolved tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getContacts.mockResolvedValue({ contacts: [] });

      await request(app)
        .get('/api/xero-reports/contacts')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getContacts).toHaveBeenCalledWith(testUser.id, 't1', { force: false });
    });

    test('a failure on any of the three surfaces as 500, not a crash', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getContacts.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));

      const res = await request(app)
        .get('/api/xero-reports/contacts')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(500);
      expect(res.body.error).toMatch(/rate limit/i);
    });
  });
});
