// GET /api/xero-reports/version, what the page polls for live updates, and
// the view every report route notes on the way through. The reports and the
// token cache are mocked as in xero-reports.test.js; the SDK is mocked so
// nothing here can reach Xero; the database behind the version is real.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

jest.mock('xero-node', () => ({ AccountingApi: jest.fn() }));
jest.mock('../xero/reports');
jest.mock('../utils/token-cache');

describe('routes/xero-reports /version', () => {
  let app, users, jwtSecret, testUser, reports, tokenCache, detector, db, logger;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    reports    = require('../xero/reports');
    tokenCache = require('../utils/token-cache');
    detector   = require('../xero/change-detector');
    db         = require('../db');
    logger     = require('../utils/logger');
    const xeroReportsRoutes = require('./xero-reports');

    testUser = await users.createUser('version@test.com', 'password123', 'user');

    app = express();
    app.use(express.json());
    app.use('/api/xero-reports', xeroReportsRoutes);
  });

  const tokenFor = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  const get = path => request(serverFor(app)).get(path).set('Authorization', `Bearer ${tokenFor(testUser)}`);
  const row = tenantId => db.prepare('SELECT * FROM xero_change_cursor WHERE user_id = ? AND tenant_id = ?').get(testUser.id, tenantId);

  test('the SDK is the mock, so nothing here can reach Xero', () => {
    expect(jest.isMockFunction(require('xero-node').AccountingApi)).toBe(true);
  });

  test('requires authentication', async () => {
    await request(serverFor(app)).get('/api/xero-reports/version').expect(401);
  });

  test('connected:false without a tenant, in the same shape', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([]);
    const res = await get('/api/xero-reports/version').expect(200);
    expect(res.body).toEqual({ connected: false, tenantId: null, changedAt: null, changeReason: null, checkedAt: null, live: false, liveReason: null });
  });

  test('the shape before any look, then what the cursor says, from one read and no report call', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }, { tenantId: 't2', tenantName: 'Org Two' }]);

    let res = await get('/api/xero-reports/version').expect(200);
    expect(res.body).toEqual({ connected: true, tenantId: 't1', changedAt: null, changeReason: null, checkedAt: null, live: false, liveReason: 'Not checked yet' });

    db.prepare(`
      INSERT INTO xero_change_cursor (user_id, tenant_id, last_journal_number, last_poll_at, changed_at, change_reason, live, live_reason)
      VALUES (?, 't2', 41, '2026-10-10T09:02:00.000Z', '2026-10-10T09:00:00.000Z', '3 new journals', 1, NULL)
    `).run(testUser.id);
    res = await get('/api/xero-reports/version?tenantId=t2').expect(200);
    expect(res.body).toEqual({
      connected: true, tenantId: 't2', changedAt: '2026-10-10T09:00:00.000Z', changeReason: '3 new journals',
      checkedAt: '2026-10-10T09:02:00.000Z', live: true, liveReason: null,
    });

    db.prepare('UPDATE xero_change_cursor SET live = 0, live_reason = ? WHERE user_id = ? AND tenant_id = ?')
      .run('daily allowance low', testUser.id, 't2');
    res = await get('/api/xero-reports/version?tenantId=t2').expect(200);
    expect(res.body).toMatchObject({ live: false, liveReason: 'daily allowance low', changedAt: '2026-10-10T09:00:00.000Z' });

    for (const fn of Object.values(reports)) if (jest.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
  });

  test('a tenant the user does not have falls back to their first, as every report does', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }]);
    const res = await get('/api/xero-reports/version?tenantId=someone-elses').expect(200);
    expect(res.body.tenantId).toBe('t1');
  });

  describe('a report request notes the view', () => {
    beforeEach(() => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }, { tenantId: 't2', tenantName: 'Org Two' }]);
      reports.getSummary.mockResolvedValue({ organisation: {}, kpis: {}, invoices: [] });
    });

    test('for the company the report was of', async () => {
      await get('/api/xero-reports/summary?tenantId=t2').expect(200);
      expect(row('t2')).toMatchObject({ last_viewed_at: expect.any(String), last_poll_at: null });
      expect(Date.now() - Date.parse(row('t2').last_viewed_at)).toBeLessThan(10_000);
      expect(row('t1')).toBeUndefined();
      expect(reports.getSummary).toHaveBeenCalledWith(testUser.id, 't2', { force: false });
    });

    test('not when there is no company to view', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([]);
      const spy = jest.spyOn(detector, 'noteViewed');
      await get('/api/xero-reports/summary').expect(200);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    test('a failure to note it is a warning, and the report is still served', async () => {
      const spy  = jest.spyOn(detector, 'noteViewed').mockImplementation(() => { throw new Error('database is locked'); });
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const res = await get('/api/xero-reports/summary').expect(200);
      expect(res.body).toMatchObject({ connected: true, activeTenantId: 't1' });
      expect(warn).toHaveBeenCalledWith('Could not note a report view', { error: 'database is locked', userId: testUser.id });
      spy.mockRestore();
      warn.mockRestore();
    });
  });
});
