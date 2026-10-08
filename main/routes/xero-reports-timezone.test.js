// Which day it is depends on where the reader is, and Budget vs Actual decides
// from that day which months have closed. The route reads the user's own
// timezone and hands it to the report; one that forgot would date every
// user's grid in the server's zone (UTC on the VM), so a reader in Singapore
// would wait until 08:00 on the 1st for the month before to close.
//
// xero-reports.test.js mocks the whole reports module, so it can only show the
// option being passed along. Here the real resolver runs, on a fixed clock,
// against a mocked SDK, and the difference a timezone makes is read off the
// answer.

const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

jest.mock('xero-node', () => {
  const api = {
    getOrganisations:       jest.fn(),
    getBudgets:             jest.fn(),
    getReportProfitAndLoss: jest.fn(),
    getReportBudgetSummary: jest.fn(),
  };
  return { AccountingApi: jest.fn(() => api), __api: api };
});
// The route asks which organisations the user has; the report asks for a token.
jest.mock('../utils/token-cache', () => ({
  forUser: () => ({ getValidToken: jest.fn().mockResolvedValue('fake-token') }),
  getPersistedTenants: jest.fn(() => [{ tenantId: 't1', tenantName: 'Org' }]),
  getHealth: jest.fn(() => null), markNeedsReconnect: jest.fn(), markRefreshed: jest.fn(), clearHealth: jest.fn(),
}));
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn().mockRejectedValue(new Error('no model in tests')), GEMINI_MODELS: [] }));

// 16:30 UTC on 31 October: still the 31st in UTC, already 00:30 on 1 November
// in Singapore. Only Date is faked; supertest needs real sockets and timers.
const CLOCK = '2026-10-31T16:30:00Z';
const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
const emptyReport = { body: { reports: [{ rows: [] }] } };

describe('routes/xero-reports — the user\'s timezone reaches Budget vs Actual', () => {
  let app, users, jwtSecret, reports, api;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers({ now: new Date(CLOCK), doNotFake: REAL_TIMERS });
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));

    // The registry was reset, so the SDK mock is fresh: fetched again, and
    // checked to be the mock before anything can call it.
    const xeroNode = require('xero-node');
    api = xeroNode.__api;
    expect(jest.isMockFunction(xeroNode.AccountingApi)).toBe(true);
    expect(new xeroNode.AccountingApi()).toBe(api);
    // A March year end, so the financial year is Apr 2026 – Mar 2027 and
    // October is its seventh month.
    api.getOrganisations.mockResolvedValue({ body: { organisations: [
      { name: 'Test Org', baseCurrency: 'SGD', financialYearEndDay: 31, financialYearEndMonth: 3 },
    ] } });
    api.getBudgets.mockResolvedValue({ body: { budgets: [] } });
    api.getReportProfitAndLoss.mockResolvedValue(emptyReport);
    api.getReportBudgetSummary.mockResolvedValue(emptyReport);

    reports = require('../xero/reports');
    const xeroReportsRoutes = require('./xero-reports');
    app = express();
    app.use(express.json());
    app.use('/api/xero-reports', xeroReportsRoutes);
  });
  afterEach(() => jest.useRealTimers());

  const tokenFor = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  const userIn = async (email, timezone) => {
    const user = await users.createUser(email, 'password123', 'user');
    if (timezone) users.saveUserConfig(user.id, { TIMEZONE: timezone });
    return user;
  };
  const budgetFor = async user => {
    const res = await request(serverFor(app))
      .get('/api/xero-reports/budget-variance?preset=fy')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .expect(200);
    return res.body;
  };
  const month = (body, key) => body.months.find(m => m.key === key);

  test('at one instant, a Singapore reader has October closed and a UTC reader still has it in progress', async () => {
    const sg  = await userIn('sg@test.com',  'Asia/Singapore');
    const utc = await userIn('utc@test.com', 'UTC');

    const inSg = await budgetFor(sg);
    expect(inSg.connected).toBe(true);
    expect(month(inSg, '2026-10')).toMatchObject({ source: 'actual', current: false });
    expect(month(inSg, '2026-11')).toMatchObject({ source: 'budget', current: true });
    expect(inSg.kpis.monthsElapsed).toBe(7);                                       // Apr–Oct
    expect(inSg.kpis.currentMonth).toMatchObject({ key: '2026-11', asOf: '2026-11-01' });

    const inUtc = await budgetFor(utc);
    expect(month(inUtc, '2026-10')).toMatchObject({ source: 'budget', current: true });
    expect(month(inUtc, '2026-11')).toMatchObject({ source: 'budget', current: false });
    expect(inUtc.kpis.monthsElapsed).toBe(6);                                      // Apr–Sep
    expect(inUtc.kpis.currentMonth).toMatchObject({ key: '2026-10', asOf: '2026-10-31' });

    // Two readers, two reports: neither was served the other's.
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(2);
  });

  test('the timezone handed to the report is the user\'s own, and the default for one who never chose', async () => {
    const spy = jest.spyOn(reports, 'getBudgetVariance');

    const sg = await userIn('sg2@test.com', 'Asia/Singapore');
    await budgetFor(sg);
    expect(spy).toHaveBeenLastCalledWith(sg.id, 't1', expect.objectContaining({ timezone: 'Asia/Singapore', period: { preset: 'fy' } }));

    // No TIMEZONE saved at all: the default zone is Singapore's, so October
    // has closed for this reader too — not the server's UTC.
    const none = await userIn('none@test.com', null);
    const body = await budgetFor(none);
    expect(spy).toHaveBeenLastCalledWith(none.id, 't1', expect.objectContaining({ timezone: users.DEFAULT_TIMEZONE }));
    expect(users.DEFAULT_TIMEZONE).toBe('Asia/Singapore');
    expect(month(body, '2026-10')).toMatchObject({ source: 'actual', current: false });
  });

  test('the same reader asking again is served from the cache, dated the same way', async () => {
    const sg = await userIn('sg3@test.com', 'Asia/Singapore');
    const first = await budgetFor(sg);
    const again = await budgetFor(sg);
    expect(first.cached).toBe(false);
    expect(again.cached).toBe(true);
    expect(again.months).toEqual(first.months);
    expect(api.getReportBudgetSummary).toHaveBeenCalledTimes(1);
  });
});
