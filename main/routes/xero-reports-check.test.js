const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// GET /budget-check: the route in front of xero/budget-check.js. The report
// layer is mocked, so these are about the route alone — who may ask, which
// query it refuses before any Xero call, what it passes on, and the envelope
// it answers in, which is every report route's.
jest.mock('../xero/reports');
jest.mock('../utils/token-cache');

describe('routes/xero-reports — GET /budget-check', () => {
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

  const tokenFor = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  const auth = req => req.set('Authorization', `Bearer ${tokenFor(testUser)}`);
  const get  = qs => auth(request(serverFor(app)).get(`/api/xero-reports/budget-check${qs ? `?${qs}` : ''}`));

  const VERDICT = {
    ok: true, checkedAt: '2026-10-09T01:58:00.000Z', calls: 3,
    checks: [
      { key: 'span', label: 'closed span Jan – Sep 2026', skipped: false, lines: 34, matched: 34, differences: [], onlyInXero: [], onlyInApp: [], calls: 1, ok: true },
      { key: 'month', label: 'September alone', skipped: false, lines: 34, matched: 34, differences: [], onlyInXero: [], onlyInApp: [], calls: 1, ok: true },
      { key: 'quarters', label: 'budget by quarter', skipped: false, quarters: 3, lines: 34, matched: 34, differences: [], onlyInXero: [], onlyInApp: [], calls: 1, ok: true },
    ],
    notes: ['what the span proves'],
    period: { fromKey: '2026-01', toKey: '2026-12', closedThroughISO: '2026-09-30' },
  };

  test('requires authentication', async () => {
    await request(serverFor(app)).get('/api/xero-reports/budget-check').expect(401);
  });

  test('answers connected:false without a tenant, and asks for no check', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([]);
    const res = await get('').expect(200);
    expect(res.body).toEqual({ connected: false, tenants: [] });
    expect(reports.getBudgetCheck).not.toHaveBeenCalled();
  });

  describe('with a connected organisation', () => {
    beforeEach(() => {
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }, { tenantId: 't2', tenantName: 'Org Two' }]);
      reports.getBudgetCheck.mockResolvedValue(VERDICT);
    });

    test('passes the preset, the organisation and force through, as /budget-variance does', async () => {
      await get('preset=prev-fy&tenantId=t2&force=true').expect(200);
      expect(reports.getBudgetCheck).toHaveBeenCalledWith(testUser.id, 't2',
        { timezone: expect.any(String), force: true, period: { preset: 'prev-fy' } });
    });

    test('passes a from/to range through, and no period at all as none — the whole financial year', async () => {
      await get('from=2025-07&to=2026-12').expect(200);
      expect(reports.getBudgetCheck).toHaveBeenLastCalledWith(testUser.id, 't1',
        expect.objectContaining({ force: false, period: { from: '2025-07', to: '2026-12' } }));

      await get('').expect(200);
      expect(reports.getBudgetCheck.mock.calls.at(-1)[2].period).toBeUndefined();
    });

    test('answers the verdict in the report envelope', async () => {
      const res = await get('preset=fy').expect(200);
      expect(res.body).toMatchObject({ connected: true, activeTenantId: 't1', ...VERDICT });
      expect(res.body.tenants).toHaveLength(2);
      expect(res.body.checks.map(c => c.key)).toEqual(['span', 'month', 'quarters']);
    });

    test('a period the grid would refuse is a 400 before any check runs', async () => {
      const INVALID = {
        'far too long':                'from=1900-01&to=2100-12',
        'a month that does not exist': 'from=2026-13&to=2026-12',
        'half a range':                'from=2026-01',
        'an unknown preset':           'preset=garbage',
        'a repeated parameter':        'from=2026-01&from=2026-02&to=2026-03',
      };
      for (const [why, qs] of Object.entries(INVALID)) {
        const res = await get(qs);
        expect({ why, status: res.status }).toEqual({ why, status: 400 });
        expect(typeof res.body.error).toBe('string');
      }
      expect(reports.getBudgetCheck).not.toHaveBeenCalled();
    });

    test('a Xero failure is an error, never a verdict', async () => {
      reports.getBudgetCheck.mockRejectedValue(new Error('Xero rate limit exceeded — try again in a minute'));
      const res = await get('preset=fy').expect(500);
      expect(res.body.error).toMatch(/rate limit/i);
      expect(res.body.ok).toBeUndefined();
    });

    test('a missing scope is the reconnect prompt', async () => {
      reports.getBudgetCheck.mockRejectedValue(new Error(JSON.stringify({ response: { statusCode: 403 }, body: { Detail: 'Forbidden resource' } })));
      const res = await get('preset=fy').expect(403);
      expect(res.body.error).toMatch(/reconnect in Setup/);
    });
  });
});
