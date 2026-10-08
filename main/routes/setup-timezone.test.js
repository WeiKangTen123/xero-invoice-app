// Setup's timezone box is free text, and every report dates itself in it
// through Intl, which throws on a name it does not know — so one typo there
// was a 500 on every Insights tab until it was corrected. The route refuses
// such a value now; and a value already stored that would not pass (saved
// before the check, or by hand) is read as the default by the report routes
// and as UTC by the date arithmetic, each said once in the log.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

jest.mock('../xero/reports');
jest.mock('../utils/token-cache');

describe('routes/setup — timezone', () => {
  let app, users, jwtSecret, user;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/setup', require('./setup'));
    user = await users.createUser(`tz${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.com`, 'password123', 'user');
  });

  const auth = () => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;
  const save = body => request(serverFor(app)).post('/api/setup').set('Authorization', auth()).send(body);
  const load = () => request(serverFor(app)).get('/api/setup').set('Authorization', auth()).expect(200).then(r => r.body);

  test('a name Intl knows is kept, trimmed, whatever region it is in', async () => {
    for (const tz of ['Asia/Tokyo', 'Europe/London', 'America/New_York', 'UTC', 'Australia/Sydney']) {
      await save({ TIMEZONE: tz }).expect(200);
      expect(users.getUserConfig(user.id).TIMEZONE).toBe(tz);
    }
    await save({ TIMEZONE: '  Pacific/Auckland  ' }).expect(200);
    expect(users.getUserConfig(user.id).TIMEZONE).toBe('Pacific/Auckland');
    expect((await load()).preferences.TIMEZONE).toMatchObject({ value: 'Pacific/Auckland', isSet: true });
  });

  test('a name it does not know is refused with 400, saying what one looks like, and nothing in that save is kept', async () => {
    await save({ TIMEZONE: 'Asia/Tokyo' }).expect(200);
    for (const bad of ['Asia/Singapor', 'Singapore time', 'Not/AZone', 'nonsense', 'Asia/', 'SGT+8']) {
      const res = await save({ TIMEZONE: bad, DEFAULT_CURRENCY: 'USD' }).expect(400);
      expect(res.body).toEqual({
        error:  'Not a known timezone (e.g. Asia/Singapore)',
        errors: [{ field: 'TIMEZONE', error: 'Not a known timezone (e.g. Asia/Singapore)' }],
      });
    }
    expect(users.getUserConfig(user.id).TIMEZONE).toBe('Asia/Tokyo');
    expect(users.getUserConfig(user.id).DEFAULT_CURRENCY).toBeUndefined();
  });

  test('blank clears it, back to the default', async () => {
    await save({ TIMEZONE: 'Asia/Tokyo' }).expect(200);
    await save({ TIMEZONE: '' }).expect(200);
    expect(users.getUserConfig(user.id).TIMEZONE || '').toBe('');
    expect(users.getUserDefaults(user.id).timezone).toBe(users.DEFAULT_TIMEZONE);
  });

  test('the check is the one the reports apply: Intl\'s', () => {
    expect(users.timezoneProblem('Asia/Singapore')).toBeNull();
    expect(users.timezoneProblem('')).toBeNull();
    expect(users.timezoneProblem(undefined)).toBeNull();
    expect(users.timezoneProblem('Mars/Olympus_Mons')).toBe('Not a known timezone (e.g. Asia/Singapore)');
    expect(users.isKnownTimezone('Europe/Berlin')).toBe(true);
    expect(users.isKnownTimezone('Europe/Berlin ')).toBe(false);
    expect(users.isKnownTimezone(null)).toBe(false);
  });
});

describe('routes/xero-reports — a stored timezone Intl does not know', () => {
  let app, users, jwtSecret, testUser, reports, tokenCache, logger;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users      = require('../utils/users');
    logger     = require('../utils/logger');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    reports    = require('../xero/reports');
    tokenCache = require('../utils/token-cache');
    app = express();
    app.use(express.json());
    app.use('/api/xero-reports', require('./xero-reports'));
    testUser = await users.createUser(`rep${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.com`, 'password123', 'user');
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org' }]);
    reports.getBudgetVariance.mockResolvedValue({ rows: [], months: [], kpis: {} });
  });

  const get = () => request(serverFor(app)).get('/api/xero-reports/budget-variance')
    .set('Authorization', `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`);

  test('the report runs in the default timezone rather than failing, and the log says so once', async () => {
    users.saveUserConfig(testUser.id, { TIMEZONE: 'Not/AZone' });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await get().expect(200);
    await get().expect(200);
    expect(reports.getBudgetVariance).toHaveBeenCalledTimes(2);
    for (const call of reports.getBudgetVariance.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ timezone: users.DEFAULT_TIMEZONE }));
    }
    const said = warn.mock.calls.filter(c => /timezone/i.test(c[0]));
    expect(said).toHaveLength(1);
    expect(said[0][1]).toEqual(expect.objectContaining({ timeZone: 'Not/AZone', fallback: users.DEFAULT_TIMEZONE }));
  });

  test('a known one is passed through as it is', async () => {
    users.saveUserConfig(testUser.id, { TIMEZONE: 'Asia/Tokyo' });
    await get().expect(200);
    expect(reports.getBudgetVariance.mock.calls[0][2]).toEqual(expect.objectContaining({ timezone: 'Asia/Tokyo' }));
  });
});

// Only Date is faked, so nothing below waits on a timer and the test server
// stays usable; the clock is fixed so "today" is known on both sides.
describe('xero/periods — today in a timezone Intl does not know', () => {
  const REAL_TIMERS = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-07T03:00:00Z'), doNotFake: REAL_TIMERS }));
  afterEach(() => jest.useRealTimers());

  test('is read as UTC, said once in the log, and a known one as itself', () => {
    jest.resetModules();
    const logger = require('../utils/logger');
    const warn   = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const { _todayPartsInTz } = require('../xero/periods');
    expect(_todayPartsInTz('Not/AZone')).toEqual({ year: 2026, month: 10, day: 7 });
    expect(_todayPartsInTz('Not/AZone')).toEqual({ year: 2026, month: 10, day: 7 });
    expect(_todayPartsInTz('UTC')).toEqual({ year: 2026, month: 10, day: 7 });
    expect(_todayPartsInTz('Asia/Tokyo')).toEqual({ year: 2026, month: 10, day: 7 });            // 12:00 JST
    expect(_todayPartsInTz('America/Los_Angeles')).toEqual({ year: 2026, month: 10, day: 6 });   // 20:00 PDT, the day before
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ timeZone: 'Not/AZone' });
  });
});
