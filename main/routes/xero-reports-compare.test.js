const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// GET /performance?compare=prior-year — the comparison with the same months
// last year. The flag is checked like a period: the one value it takes is
// passed through, anything else is a 400 before the report runs, and leaving
// it out (or empty) asks for exactly what the route asked for before.

jest.mock('../xero/reports');
jest.mock('../utils/token-cache');

describe('routes/xero-reports — ?compare=', () => {
  let app, testUser, reports, jwtSecret;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    const users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    reports = require('../xero/reports');
    require('../utils/token-cache').getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org' }]);
    reports.getPerformance.mockResolvedValue({ months: [], totals: {} });

    testUser = await users.createUser('compare@test.com', 'password123', 'user');
    app = express();
    app.use(express.json());
    app.use('/api/xero-reports', require('./xero-reports'));
  });

  const get = qs => request(serverFor(app))
    .get(`/api/xero-reports/performance${qs ? `?${qs}` : ''}`)
    .set('Authorization', `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`);
  const lastOpts = () => reports.getPerformance.mock.calls.at(-1)[2];

  test('compare=prior-year is passed to the report, alongside the period and the other options', async () => {
    await get('compare=prior-year&preset=fy&force=true').expect(200);
    expect(lastOpts()).toEqual(expect.objectContaining({
      compare: 'prior-year', period: { preset: 'fy' }, force: true, cashFlow: false, customers: false,
    }));
  });

  test('without it, or with it empty, the report is asked for exactly as before — no compare option at all', async () => {
    for (const qs of ['', 'preset=fy-ytd', 'compare=']) {
      await get(qs).expect(200);
      expect(lastOpts()).not.toHaveProperty('compare');
    }
  });

  test('anything else is a 400 with a reason, and the report never runs', async () => {
    for (const qs of ['compare=garbage', 'compare=PRIOR-YEAR', 'compare=prior_year', 'compare=prior-year&compare=prior-year', 'compare[x]=1']) {
      const res = await get(qs);
      expect({ qs, status: res.status }).toEqual({ qs, status: 400 });
      expect(res.body.error).toMatch(/compare=prior-year/);
    }
    expect(reports.getPerformance).not.toHaveBeenCalled();
  });

  test('a valid comparison does not excuse an invalid period: the period checks still apply', async () => {
    const long = await get('compare=prior-year&from=2015-12&to=2026-12').expect(400);
    expect(long.body.error).toMatch(/at most 132 months/);
    await get('compare=prior-year&preset=garbage').expect(400);
    await get('compare=prior-year&from=2026-01').expect(400);
    expect(reports.getPerformance).not.toHaveBeenCalled();
    await get('compare=prior-year&from=2016-01&to=2026-12').expect(200);   // 132 months, the most there is
  });

  test('the comparison is passed to /performance only; the other report routes take no such flag', async () => {
    reports.getCashFlow.mockResolvedValue({});
    reports.getBudgetVariance.mockResolvedValue({ months: [], rows: [] });
    const auth = r => r.set('Authorization', `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`);
    await auth(request(serverFor(app)).get('/api/xero-reports/cash-flow?preset=fy&compare=prior-year')).expect(200);
    await auth(request(serverFor(app)).get('/api/xero-reports/budget-variance?preset=fy&compare=prior-year')).expect(200);
    expect(reports.getCashFlow.mock.calls[0][2]).not.toHaveProperty('compare');
    expect(reports.getBudgetVariance.mock.calls[0][2]).not.toHaveProperty('compare');
  });
});
