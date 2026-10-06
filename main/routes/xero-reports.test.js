const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
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
    await request(serverFor(app)).get('/api/xero-reports/summary').expect(401);
  });

  test('returns connected:false when the user has no persisted tenant, without calling reports.getSummary', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([]);
    const res = await request(serverFor(app))
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

    const res = await request(serverFor(app))
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

    await request(serverFor(app))
      .get('/api/xero-reports/summary?tenantId=t2')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't2', { force: false });
  });

  test('a ?tenantId the user does not actually have falls back to their first tenant, not an arbitrary org', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    await request(serverFor(app))
      .get('/api/xero-reports/summary?tenantId=someone-elses-tenant')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't1', { force: false });
  });

  test('?force=true is threaded through to reports.getSummary', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
    reports.getSummary.mockResolvedValue({ connected: true, organisation: {}, kpis: {}, invoices: [] });

    await request(serverFor(app))
      .get('/api/xero-reports/summary?force=true')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(200);

    expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't1', { force: true });
  });

  test('surfaces a Xero API failure as 500 with a readable message, not a crash', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
    reports.getSummary.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));

    const res = await request(serverFor(app))
      .get('/api/xero-reports/summary')
      .set('Authorization', `Bearer ${tokenFor(testUser)}`)
      .expect(500);
    expect(res.body.error).toMatch(/rate limit/i);
  });

  describe('GET /accounts, /bank-accounts', () => {
    test('both require authentication', async () => {
      await request(serverFor(app)).get('/api/xero-reports/accounts').expect(401);
      await request(serverFor(app)).get('/api/xero-reports/bank-accounts').expect(401);
    });

    test('both return connected:false with no tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([]);
      for (const path of ['accounts', 'bank-accounts']) {
        const res = await request(serverFor(app))
          .get(`/api/xero-reports/${path}`)
          .set('Authorization', `Bearer ${tokenFor(testUser)}`)
          .expect(200);
        expect(res.body).toEqual({ connected: false, tenants: [] });
      }
    });

    test('GET /accounts calls reports.getAccounts for the resolved tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getAccounts.mockResolvedValue({ accounts: [{ code: '200', name: 'Sales' }] });

      const res = await request(serverFor(app))
        .get('/api/xero-reports/accounts')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getAccounts).toHaveBeenCalledWith(testUser.id, 't1', { force: false });
      expect(res.body.accounts).toHaveLength(1);
    });

    test('GET /bank-accounts calls reports.getBankAccounts for the resolved tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getBankAccounts.mockResolvedValue({ bankAccounts: [] });

      await request(serverFor(app))
        .get('/api/xero-reports/bank-accounts?force=true')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getBankAccounts).toHaveBeenCalledWith(testUser.id, 't1', { force: true });
    });

    test('a failure surfaces as 500, not a crash', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getAccounts.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));

      const res = await request(serverFor(app))
        .get('/api/xero-reports/accounts')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(500);
      expect(res.body.error).toMatch(/rate limit/i);
    });
  });

  describe('GET /bank-transactions', () => {
    test('all three require authentication', async () => {
      await request(serverFor(app)).get('/api/xero-reports/bank-transactions?accountId=a1').expect(401);
      await request(serverFor(app)).get('/api/xero-reports/bank-transactions?accountId=acc-1').expect(401);
      await request(serverFor(app)).get('/api/xero-reports/bank-transactions?accountId=acc-1').expect(401);
    });

    test('/bank-transactions requires accountId', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      const res = await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(400);
      expect(res.body.error).toMatch(/accountId/i);
      expect(reports.getBankTransactions).not.toHaveBeenCalled();
    });

    test('/bank-transactions calls reports.getBankTransactions with the account and resolved tenant', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getBankTransactions.mockResolvedValue({ transactions: [] });

      await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions?accountId=acct-1')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(reports.getBankTransactions).toHaveBeenCalledWith(testUser.id, 't1', 'acct-1', { force: false });
    });

    test('a Xero 403 (insufficient scope) surfaces as a clear reconnect prompt, not a generic error', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      const scopeErr = new Error(JSON.stringify({ response: { statusCode: 403 }, body: { Detail: 'Forbidden resource' } }));
      reports.getBankTransactions.mockRejectedValue(scopeErr);

      const res = await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions?accountId=acc-1')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(403);
      expect(res.body.error).toMatch(/reconnect/i);
    });

    // Xero's actual shape for a missing scope, confirmed live: a 401 with a
    // WWW-Authenticate: insufficient_scope header, not always a 403 — this
    // is the realistic case the 403 test above wouldn't have caught.
    test('a Xero 401 with WWW-Authenticate: insufficient_scope also surfaces as a clear reconnect prompt', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      const scopeErr = new Error(JSON.stringify({ response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' } }, body: {} }));
      reports.getBankTransactions.mockRejectedValue(scopeErr);

      const res = await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions?accountId=acc-1')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(403);
      expect(res.body.error).toMatch(/reconnect/i);
    });

    test('a non-scope Xero failure still surfaces as 500', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1' }]);
      reports.getBankTransactions.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));

      const res = await request(serverFor(app))
        .get('/api/xero-reports/bank-transactions?accountId=acc-1')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(500);
      expect(res.body.error).toMatch(/rate limit/i);
    });
  });

  describe('one handler shape', () => {
    // /contacts went with the Dashboard's Contacts tab, its only caller.
    test('the report routes nothing calls are gone', async () => {
      for (const path of ['/api/xero-reports/period', '/api/xero-reports/profit-loss?from=2026-01-01&to=2026-01-31', '/api/xero-reports/bank-summary?from=2026-01-01&to=2026-01-31', '/api/xero-reports/contacts']) {
        const res = await request(serverFor(app)).get(path).set('Authorization', `Bearer ${tokenFor(testUser)}`);
        if (res.status !== 404) console.log('UNEXPECTED', path, res.status, res.text.slice(0, 300));
        expect({ status: res.status, body: res.body }).toMatchObject({ status: 404 });   // body shown on failure
      }
    });

    test('every report route answers the same envelope', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org' }]);
      reports.getAccounts.mockResolvedValue({ accounts: [] });
      reports.getBankAccounts.mockResolvedValue({ bankAccounts: [] });
      for (const path of ['/api/xero-reports/accounts', '/api/xero-reports/bank-accounts']) {
        const res = await request(serverFor(app)).get(path).set('Authorization', `Bearer ${tokenFor(testUser)}`).expect(200);
        expect(res.body).toMatchObject({ connected: true, activeTenantId: 't1' });
        expect(res.body.tenants).toHaveLength(1);
      }
    });
  });

  // The budget tabs had no period: the route passed none, so they were fixed
  // to the current financial year, and the exports with them.
  describe('budget period', () => {
    const auth = req => req.set('Authorization', `Bearer ${tokenFor(testUser)}`);
    beforeEach(() => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org' }]);
      reports.getBudgetVariance.mockResolvedValue({ months: [], rows: [] });
    });

    test('GET /budget-variance passes a preset or a from/to range through', async () => {
      await auth(request(serverFor(app)).get('/api/xero-reports/budget-variance?preset=prev-fy')).expect(200);
      expect(reports.getBudgetVariance).toHaveBeenLastCalledWith(testUser.id, 't1',
        expect.objectContaining({ period: { preset: 'prev-fy' } }));

      await auth(request(serverFor(app)).get('/api/xero-reports/budget-variance?from=2025-07&to=2026-12')).expect(200);
      expect(reports.getBudgetVariance).toHaveBeenLastCalledWith(testUser.id, 't1',
        expect.objectContaining({ period: { from: '2025-07', to: '2026-12' } }));
    });

    test('GET /budget-variance with no period asks for none, which is the whole financial year — not year to date', async () => {
      await auth(request(serverFor(app)).get('/api/xero-reports/budget-variance')).expect(200);
      const opts = reports.getBudgetVariance.mock.calls.at(-1)[2];
      expect(opts.period).toBeUndefined();
    });

    test('the export link carries the period, and the export reads that period', async () => {
      const res = await auth(request(serverFor(app))
        .get('/api/xero-reports/budget/export-url?kind=grid&format=pdf&from=2025-01&to=2025-12')).expect(200);
      const token = decodeURIComponent(res.body.url.split('token=')[1]);
      expect(jwt.verify(token, jwtSecret()).period).toEqual({ from: '2025-01', to: '2025-12' });

      // Rejected so no file is rendered; only which report was asked for matters here.
      reports.getBudgetVariance.mockRejectedValueOnce(new Error('stop'));
      await request(serverFor(app)).get(`/api/xero-reports/budget/export?token=${encodeURIComponent(token)}`).expect(500);
      expect(reports.getBudgetVariance).toHaveBeenLastCalledWith(testUser.id, 't1',
        expect.objectContaining({ period: { from: '2025-01', to: '2025-12' } }));
    });
  });
});
