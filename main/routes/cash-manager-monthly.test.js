const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

// GET /api/cash-manager/monthly: who may ask, for which organisation, and
// which spans. The forecast itself (xero/cash-monthly.js) is replaced, so
// nothing here reaches Xero; its bounds are the real module's.
jest.mock('../utils/token-cache');
jest.mock('../xero/cash-monthly', () => ({
  ...jest.requireActual('../xero/cash-monthly'),
  getCashMonthly: jest.fn(),
}));

describe('GET /api/cash-manager/monthly', () => {
  let app, users, jwtSecret, testUser, otherUser, tokenCache, cashMonthly;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    tokenCache  = require('../utils/token-cache');
    cashMonthly = require('../xero/cash-monthly');
    cashMonthly.getCashMonthly.mockResolvedValue({ months: [{ key: '2026-10', label: 'Oct 2026', kind: 'current' }], rows: [], notes: [], calls: 0, cached: true });

    testUser  = await users.createUser(`cmm-route-${Date.now()}@test.com`, 'password123', 'user');
    otherUser = await users.createUser(`cmm-other-${Date.now()}@test.com`, 'password123', 'user');
    tokenCache.getPersistedTenants.mockImplementation(id => (id === testUser.id
      ? [{ tenantId: 't1', tenantName: 'Org One' }, { tenantId: 't2', tenantName: 'Org Two' }]
      : [{ tenantId: 't1', tenantName: 'Org One' }]));

    app = express();
    app.use(express.json());
    app.use('/api/cash-manager', require('./cash-manager'));
  });

  const tokenFor = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  const get = (qs, user = testUser) => request(serverFor(app)).get(`/api/cash-manager/monthly${qs}`).set('Authorization', `Bearer ${tokenFor(user)}`);

  test('the forecast is the mock: nothing here reaches Xero', () => {
    expect(jest.isMockFunction(cashMonthly.getCashMonthly)).toBe(true);
  });

  test('requires authentication', async () => {
    await request(serverFor(app)).get('/api/cash-manager/monthly?tenantId=t1').expect(401);
    expect(cashMonthly.getCashMonthly).not.toHaveBeenCalled();
  });

  test('a tenant is required, and must be one this person has connected', async () => {
    expect((await get('').expect(400)).body).toEqual({ error: 'tenantId is required' });
    expect((await get('?tenantId=t9').expect(403)).body.error).toMatch(/not connected/);
    // Connected for one person is not connected for another.
    expect((await get('?tenantId=t2', otherUser).expect(403)).body.error).toMatch(/not connected/);
    expect(cashMonthly.getCashMonthly).not.toHaveBeenCalled();
  });

  test('a span or fill outside what is offered is a 400 before any Xero call', async () => {
    const cases = [
      ['past=13',     /past must be a whole number from 0 to 12/],
      ['past=-1',     /past must be a whole number from 0 to 12/],
      ['past=1.5',    /past must be a whole number from 0 to 12/],
      ['past=abc',    /past must be a whole number from 0 to 12/],
      ['past=1&past=2', /past must be a whole number from 0 to 12/],
      ['future=0',    /future must be a whole number from 1 to 12/],
      ['future=13',   /future must be a whole number from 1 to 12/],
      ['future=100',  /future must be a whole number from 1 to 12/],
      ['fill=forecast', /fill must be one of budget, none/],
    ];
    for (const [qs, re] of cases) {
      const res = await get(`?tenantId=t1&${qs}`);
      expect({ qs, status: res.status }).toEqual({ qs, status: 400 });
      expect(res.body.error).toMatch(re);
    }
    expect(cashMonthly.getCashMonthly).not.toHaveBeenCalled();
  });

  test('nothing asked for is six months back and six ahead, filled from the budget, in the user\'s timezone', async () => {
    const res = await get('?tenantId=t2').expect(200);
    expect(cashMonthly.getCashMonthly).toHaveBeenCalledWith(testUser.id, 't2', {
      past: 6, future: 6, fill: 'budget', timezone: expect.any(String), force: false,
    });
    expect(res.body).toMatchObject({ tenantId: 't2', months: [{ key: '2026-10', kind: 'current' }] });
  });

  test('the bounds themselves are allowed, and force reaches the forecast', async () => {
    await get('?tenantId=t1&past=0&future=12&fill=none&force=true').expect(200);
    expect(cashMonthly.getCashMonthly).toHaveBeenLastCalledWith(testUser.id, 't1', expect.objectContaining({ past: 0, future: 12, fill: 'none', force: true }));
    await get('?tenantId=t1&past=12&future=1&past=').expect(400);
    await get('?tenantId=t1&past=12&future=1').expect(200);
    expect(cashMonthly.getCashMonthly).toHaveBeenLastCalledWith(testUser.id, 't1', expect.objectContaining({ past: 12, future: 1, fill: 'budget' }));
  });

  test('a missing scope is a reconnect prompt; any other failure a 500 with what went wrong', async () => {
    const scope = JSON.stringify({ response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' }, body: {} } });
    cashMonthly.getCashMonthly.mockRejectedValueOnce(scope);
    expect((await get('?tenantId=t1').expect(403)).body.error).toMatch(/reconnect in Setup/);
    cashMonthly.getCashMonthly.mockRejectedValueOnce(new Error('Xero is down'));
    expect((await get('?tenantId=t1').expect(500)).body.error).toMatch(/Xero is down/);
  });
});
