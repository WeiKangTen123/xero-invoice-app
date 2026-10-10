// Noticing a change in Xero from the journal numbers and the budget list.
// The SDK class is replaced by two mocks, so nothing here reaches Xero; the
// database, the users, the token cache, the connection health, the report
// cache and withRetry are the real ones.
const mockGetJournals = jest.fn();
const mockGetBudgets  = jest.fn();
jest.mock('xero-node', () => ({
  AccountingApi: jest.fn().mockImplementation(() => ({ getJournals: mockGetJournals, getBudgets: mockGetBudgets })),
}));

const HOUR = 60 * 60 * 1000;
const MIN  = 60 * 1000;
let seq = 0;

const journals = (...numbers) => ({ body: { journals: numbers.map(n => ({ journalID: `j-${n}`, journalNumber: n })) } });
const budgets  = (...dates)   => ({ body: { budgets: dates.map((d, i) => ({ budgetID: `b-${i}`, updatedDateUTC: new Date(d) })) } });
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
// A company's journal as Xero answers it: numbered past the offset, 100 to a call.
const bookOf = numbers => (_t, _since, offset) =>
  Promise.resolve(journals(...numbers.filter(n => offset === undefined || n > offset).slice(0, 100)));

describe('xero/change-detector', () => {
  let detector, reportCache, users, tokenCache, xeroUtils, db, logger, user, clock;
  const T = 't-live';
  const now  = () => new Date(clock);
  const poll = (tenantId = T) => detector.pollTenant(user.id, tenantId, { now });
  const row  = (tenantId = T) => db.prepare('SELECT * FROM xero_change_cursor WHERE user_id = ? AND tenant_id = ?').get(user.id, tenantId);
  const seed = fields => {
    const cols = Object.keys(fields);
    db.prepare(`INSERT INTO xero_change_cursor (user_id, tenant_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
      .run(user.id, T, ...cols.map(c => fields[c]));
  };
  const iso = ms => new Date(ms).toISOString();
  const cachedKeys = () => [...reportCache._cache.keys()].sort();

  beforeEach(async () => {
    jest.resetModules();
    mockGetJournals.mockReset().mockResolvedValue(journals());
    mockGetBudgets.mockReset().mockResolvedValue(budgets());
    require('../db/migrate').run();
    db          = require('../db');
    users       = require('../utils/users');
    tokenCache  = require('../utils/token-cache');
    xeroUtils   = require('./xero-utils');
    reportCache = require('./report-cache');
    logger      = require('../utils/logger');
    detector    = require('./change-detector');
    user  = await users.createUser(`live${++seq}-${Date.now()}@test.com`, 'password123', 'user');
    clock = Date.parse('2026-10-10T09:00:00.000Z');
    // A Web app connection granted every scope, journals included, with a
    // live token so getValidToken never reconnects.
    users.saveUserConfig(user.id, {
      XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret', XERO_OAUTH_REFRESH_TOKEN: 'rt-live',
    });
    tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: `offline_access ${xeroUtils.OAUTH_SCOPES}`.split(' ') });
    tokenCache.forUser(user.id).cacheToken(T, 'Live Org', 'token-live', Date.now() + HOUR, 'oauth');
  });

  test('the SDK is the mock, so nothing here can reach Xero', () => {
    const { AccountingApi } = require('xero-node');
    expect(jest.isMockFunction(AccountingApi)).toBe(true);
    expect(new AccountingApi().getJournals).toBe(mockGetJournals);
    expect(new AccountingApi().getBudgets).toBe(mockGetBudgets);
  });

  describe('the first look', () => {
    test('asks from five minutes ago with no offset, and sets the baseline without calling it a change', async () => {
      mockGetJournals.mockResolvedValue(journals(3, 7, 5));
      mockGetBudgets.mockResolvedValue(budgets('2026-10-01T00:00:00Z'));
      reportCache._cacheSet(`summary:${user.id}:${T}`, { kpis: {} });

      const result = await poll();

      expect(mockGetJournals).toHaveBeenCalledTimes(1);
      const [tenant, since, offset, paymentsOnly] = mockGetJournals.mock.calls[0];
      expect(tenant).toBe(T);
      expect(since).toBeInstanceOf(Date);
      expect(since.getTime()).toBe(clock - 5 * MIN);
      expect(offset).toBeUndefined();
      expect(paymentsOnly).toBeUndefined();
      expect(mockGetBudgets).toHaveBeenCalledWith(T);
      expect(result).toEqual({ live: true, liveReason: null, changed: false, reason: null, calls: 2 });
      expect(row()).toMatchObject({
        last_journal_number: 7, last_poll_at: iso(clock), last_budget_updated: '2026-10-01T00:00:00.000Z',
        changed_at: null, change_reason: null, live: 1, live_reason: null,
      });
      // Nothing changed, so nothing was dropped.
      expect(reportCache._cacheGet(`summary:${user.id}:${T}`)).not.toBeNull();
    });

    test('with no journals in the window the baseline stays empty and the look is still recorded', async () => {
      await poll();
      expect(row()).toMatchObject({ last_journal_number: null, last_poll_at: iso(clock), live: 1 });
    });
  });

  describe('a later look', () => {
    beforeEach(async () => {
      mockGetJournals.mockResolvedValue(journals(5));
      mockGetBudgets.mockResolvedValue(budgets('2026-10-01T00:00:00Z'));
      await poll();
      mockGetJournals.mockClear();
      clock += 2 * MIN;
      reportCache._cacheSet(`summary:${user.id}:${T}`, { kpis: {} });
      reportCache._cacheSet(`budgetvar:${user.id}:${T}:fy:2026-01:2026-12:9:9`, { rows: [] });
      reportCache._cacheSet(`summary:${user.id}:t-other`, { kpis: {} });
      reportCache._cacheSet(`summary:someone-else:${T}`, { kpis: {} });
    });

    test('asks past the last journal number, from five minutes before the last look', async () => {
      await poll();
      const [, since, offset] = mockGetJournals.mock.calls[0];
      expect(since.getTime()).toBe(clock - 2 * MIN - 5 * MIN);
      expect(offset).toBe(5);
    });

    test('new journals are a change: the company\'s cache is dropped, the cursor moves, the reason says how many', async () => {
      mockGetJournals.mockResolvedValue(journals(6, 7, 8));

      const result = await poll();

      expect(result).toMatchObject({ live: true, changed: true, reason: '3 new journals' });
      expect(row()).toMatchObject({
        last_journal_number: 8, last_poll_at: iso(clock), changed_at: iso(clock), change_reason: '3 new journals', live: 1,
      });
      expect(cachedKeys()).toEqual([`summary:${user.id}:t-other`, `summary:someone-else:${T}`]);
    });

    test('one new journal reads as one', async () => {
      mockGetJournals.mockResolvedValue(journals(6));
      expect((await poll()).reason).toBe('1 new journal');
    });

    test('no journals and the same budgets: nothing dropped, the look recorded, the cursor kept', async () => {
      const result = await poll();

      expect(result).toMatchObject({ live: true, changed: false, reason: null });
      expect(row()).toMatchObject({ last_journal_number: 5, last_poll_at: iso(clock), changed_at: null, change_reason: null });
      expect(cachedKeys()).toHaveLength(4);
    });

    test('a budget edited since is a change, and the same budgets again are not', async () => {
      mockGetBudgets.mockResolvedValue(budgets('2026-10-01T00:00:00Z', '2026-10-10T08:50:00Z'));

      const result = await poll();

      expect(result).toMatchObject({ changed: true, reason: 'budget edited' });
      expect(row()).toMatchObject({ last_budget_updated: '2026-10-10T08:50:00.000Z', change_reason: 'budget edited' });
      expect(cachedKeys()).toEqual([`summary:${user.id}:t-other`, `summary:someone-else:${T}`]);

      clock += 2 * MIN;
      expect((await poll()).changed).toBe(false);
      expect(row().change_reason).toBe('budget edited'); // the last change stays on record
    });

    test('journals and a budget edit together name both', async () => {
      mockGetJournals.mockResolvedValue(journals(6, 7));
      mockGetBudgets.mockResolvedValue(budgets('2026-10-10T08:50:00Z'));
      expect((await poll()).reason).toBe('2 new journals, budget edited');
    });

    test('Xero\'s own date form for the budget is read the same way', async () => {
      mockGetBudgets.mockResolvedValue({ body: { budgets: [{ budgetID: 'b', updatedDateUTC: `/Date(${Date.UTC(2026, 9, 1)}+0000)/` }] } });
      await poll();
      expect(row().last_budget_updated).toBe('2026-10-01T00:00:00.000Z');
    });

    test('a 304 to the conditional read is no journals, not a failure', async () => {
      mockGetJournals.mockRejectedValue(JSON.stringify({ response: { statusCode: 304, headers: {} }, body: '' }));
      const result = await poll();
      expect(result).toMatchObject({ live: true, changed: false });
      expect(row().last_poll_at).toBe(iso(clock));
    });
  });

  describe('more than a page of journals', () => {
    beforeEach(() => {
      seed({ last_journal_number: 5, last_poll_at: iso(clock - 10 * MIN) });
    });

    test('is read page by page from the newest number seen until a short page', async () => {
      mockGetJournals.mockImplementation(bookOf(range(6, 245)));

      const result = await poll();

      expect(mockGetJournals.mock.calls.map(c => c[2])).toEqual([5, 105, 205]);
      expect(result).toMatchObject({ changed: true, reason: '240 new journals', calls: 4 });
      expect(row().last_journal_number).toBe(245);
    });

    test('stops after ten pages and carries on from there next time', async () => {
      mockGetJournals.mockImplementation(bookOf(range(6, 1500)));

      const result = await poll();

      expect(mockGetJournals).toHaveBeenCalledTimes(10);
      expect(result).toMatchObject({ changed: true, reason: '1000 new journals' });
      expect(row().last_journal_number).toBe(1005);

      mockGetJournals.mockClear();
      clock += 2 * MIN;
      await poll();
      expect(mockGetJournals.mock.calls[0][2]).toBe(1005);
      expect(row().last_journal_number).toBe(1500);
    });
  });

  describe('when no call should be made', () => {
    const noCall = () => {
      expect(require('xero-node').AccountingApi).not.toHaveBeenCalled();
      expect(mockGetJournals).not.toHaveBeenCalled();
      expect(mockGetBudgets).not.toHaveBeenCalled();
    };

    test('the journals scope was not granted: not live, says to reconnect, nothing asked', async () => {
      tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: `offline_access ${xeroUtils.SCOPES} accounting.attachments`.split(' ') });

      const result = await poll();

      expect(result).toEqual({ live: false, liveReason: detector.REASONS.scope, changed: false, reason: null, calls: 0 });
      expect(result.liveReason).toMatch(/accounting\.journals\.read/);
      expect(row()).toMatchObject({ live: 0, live_reason: detector.REASONS.scope, last_poll_at: null, last_journal_number: null });
      noCall();
    });

    test('the scopes are not known yet: not live, and no guess is made', async () => {
      tokenCache.clearHealth(user.id);
      const result = await poll();
      expect(result).toMatchObject({ live: false, liveReason: detector.REASONS.scopesUnknown });
      noCall();
    });

    test('a Custom Connection: not live, says why, nothing asked', async () => {
      users.saveUserConfig(user.id, { XERO_CONNECTION_TYPE: 'custom', XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cc-secret', XERO_OAUTH_REFRESH_TOKEN: '' });
      tokenCache.markRefreshed(user.id, { method: 'custom' });

      const result = await poll();

      expect(result).toMatchObject({ live: false, liveReason: expect.stringMatching(/Custom Connection/) });
      expect(row()).toMatchObject({ live: 0, live_reason: detector.REASONS.custom });
      noCall();
    });

    test('a connection Xero refused: not live with that reason, nothing asked', async () => {
      tokenCache.markNeedsReconnect(user.id, { method: 'oauth', reason: 'Xero no longer accepts this connection. Reconnect Xero in Setup.' });

      const result = await poll();

      expect(result).toMatchObject({ live: false, liveReason: 'Xero no longer accepts this connection. Reconnect Xero in Setup.' });
      noCall();
    });

    test('the daily allowance is low: skipped without a call; at the reserve it runs', async () => {
      xeroUtils._recordRateLimit(T, { 'x-daylimit-remaining': '49', 'x-minlimit-remaining': '59' });
      expect(await poll()).toMatchObject({ live: false, liveReason: 'daily allowance low' });
      expect(row()).toMatchObject({ live: 0, live_reason: 'daily allowance low', last_poll_at: null });
      noCall();

      xeroUtils._recordRateLimit(T, { 'x-daylimit-remaining': '50' });
      expect(await poll()).toMatchObject({ live: true });
      expect(mockGetJournals).toHaveBeenCalledTimes(1);
    });

    test('the daily limit was hit: skipped until Xero said it resets', async () => {
      xeroUtils._recordRateLimit(T, { 'x-rate-limit-problem': 'day', 'retry-after': '3600' }, clock);
      expect(await poll()).toMatchObject({ live: false, liveReason: 'daily allowance low' });
      noCall();

      clock += 2 * HOUR;
      expect(await poll()).toMatchObject({ live: true });
    });

    test('another company\'s allowance says nothing about this one', async () => {
      xeroUtils._recordRateLimit('t-other', { 'x-daylimit-remaining': '3' });
      expect(await poll()).toMatchObject({ live: true });
    });

    test('a skip is written once, not on every look', async () => {
      users.saveUserConfig(user.id, { XERO_CONNECTION_TYPE: 'custom', XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cc-secret', XERO_OAUTH_REFRESH_TOKEN: '' });
      await poll();
      const run = jest.spyOn(db, 'prepare');
      await poll();
      expect(run.mock.calls.map(([sql]) => sql).filter(sql => /INSERT INTO xero_change_cursor/.test(sql))).toHaveLength(0);
      run.mockRestore();
    });
  });

  describe('a failure', () => {
    beforeEach(async () => {
      mockGetJournals.mockResolvedValue(journals(5));
      mockGetBudgets.mockResolvedValue(budgets('2026-10-01T00:00:00Z'));
      await poll();
      clock += 2 * MIN;
    });

    test('is a warning, leaves the cursor as it was, never throws, and is not tried again at once', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      mockGetJournals.mockRejectedValue(new Error('Request failed with status code 502'));
      const before = row();

      const result = await poll();

      expect(result).toMatchObject({ live: false, liveReason: expect.stringMatching(/Could not check Xero: .*502/), changed: false });
      expect(warn).toHaveBeenCalledWith('Xero change check failed; the cursor is left as it was',
        expect.objectContaining({ userId: user.id, tenantId: T, error: expect.stringMatching(/502/) }));
      const after = row();
      for (const col of ['last_journal_number', 'last_poll_at', 'last_budget_updated', 'changed_at', 'change_reason']) {
        expect(after[col]).toEqual(before[col]);
      }
      expect(after).toMatchObject({ live: 0, live_reason: expect.stringMatching(/502/) });
      // Left alone for a while, then looked at again.
      expect(detector.due(user.id, T, clock)).toBe(false);
      expect(detector.due(user.id, T, clock + detector.FAIL_BACKOFF_MS)).toBe(true);
      warn.mockRestore();
    });

    test('Xero saying the scope is missing is recorded as the scope, whatever the health record says', async () => {
      jest.spyOn(logger, 'warn').mockImplementation(() => {});
      mockGetJournals.mockRejectedValue(JSON.stringify({
        response: { statusCode: 401, headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' } }, body: '',
      }));
      expect(await poll()).toMatchObject({ live: false, liveReason: detector.REASONS.scope });
      logger.warn.mockRestore();
    });

    test('a budget failure is a failure too: the journal cursor does not move past what the budgets were not read for', async () => {
      jest.spyOn(logger, 'warn').mockImplementation(() => {});
      mockGetJournals.mockResolvedValue(journals(6, 7));
      mockGetBudgets.mockRejectedValue(new Error('boom'));
      await poll();
      expect(row()).toMatchObject({ last_journal_number: 5, changed_at: null });
      logger.warn.mockRestore();
    });
  });

  describe('due()', () => {
    test('a company never looked at is due', () => {
      expect(detector.due(user.id, T, clock)).toBe(true);
    });

    test.each([
      ['viewed just now, looked at 1 min ago',        1,  0,     false],
      ['viewed just now, looked at 2 min ago',        2,  0,     true],
      ['viewed 9 min ago, looked at 2 min ago',       2,  9,     true],
      ['viewed 11 min ago, looked at 5 min ago',      5,  11,    false],
      ['viewed 11 min ago, looked at 15 min ago',     15, 11,    true],
      ['never viewed, looked at 14 min ago',          14, null,  false],
      ['never viewed, looked at 16 min ago',          16, null,  true],
    ])('%s', (_name, polledMinAgo, viewedMinAgo, expected) => {
      seed({ last_poll_at: iso(clock - polledMinAgo * MIN), last_viewed_at: viewedMinAgo === null ? null : iso(clock - viewedMinAgo * MIN) });
      expect(detector.due(user.id, T, clock)).toBe(expected);
      expect(detector.due(user.id, T, new Date(clock))).toBe(expected);
    });

    test('a skipped company is looked at again after the shorter wait, so a reconnect is noticed soon', async () => {
      users.saveUserConfig(user.id, { XERO_CONNECTION_TYPE: 'custom', XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cc-secret', XERO_OAUTH_REFRESH_TOKEN: '' });
      await poll();
      expect(detector.due(user.id, T, clock)).toBe(false);
      expect(detector.due(user.id, T, clock + detector.SKIP_BACKOFF_MS)).toBe(true);
    });
  });

  describe('noteViewed and version', () => {
    test('a view is one row, and never loses the cursor', async () => {
      mockGetJournals.mockResolvedValue(journals(9));
      await poll();
      detector.noteViewed(user.id, T, new Date(clock + MIN));
      expect(row()).toMatchObject({ last_viewed_at: iso(clock + MIN), last_journal_number: 9, last_poll_at: iso(clock), live: 1 });

      detector.noteViewed(user.id, 't-new');
      expect(row('t-new')).toMatchObject({ last_viewed_at: expect.any(String), last_journal_number: null, live: null });
    });

    test('version() says not checked yet, then what the last look found', async () => {
      expect(detector.version(user.id, T)).toEqual({ changedAt: null, changeReason: null, checkedAt: null, live: false, liveReason: 'Not checked yet' });

      detector.noteViewed(user.id, T);
      expect(detector.version(user.id, T).liveReason).toBe('Not checked yet');

      mockGetJournals.mockResolvedValue(journals(5));
      await poll();
      expect(detector.version(user.id, T)).toEqual({ changedAt: null, changeReason: null, checkedAt: iso(clock), live: true, liveReason: null });

      clock += 2 * MIN;
      mockGetJournals.mockResolvedValue(journals(6));
      await poll();
      expect(detector.version(user.id, T)).toEqual({ changedAt: iso(clock), changeReason: '1 new journal', checkedAt: iso(clock), live: true, liveReason: null });

      tokenCache.markNeedsReconnect(user.id, { method: 'oauth', reason: 'Reconnect Xero in Setup.' });
      clock += 2 * MIN;
      await poll();
      expect(detector.version(user.id, T)).toMatchObject({ changedAt: iso(clock - 2 * MIN), checkedAt: iso(clock - 2 * MIN), live: false, liveReason: 'Reconnect Xero in Setup.' });
    });
  });
});

describe('report-cache clearTenant', () => {
  let cache;
  beforeEach(() => {
    jest.resetModules();
    cache = require('./report-cache');
    for (const key of [
      'summary:u1:t1', 'org:u1:t1', 'banktx:u1:t1:acc-9', 'budgetvar:u1:t1:fy:2026-01:2026-12:9:9',
      'summary:u1:t10', 'summary:u1:t2', 'summary:u2:t1', 'banktx:u2:t1:acc-9',
    ]) cache._cacheSet(key, { key });
  });

  test('drops every key of that user and company, with or without a range, and nothing else', () => {
    cache.clearTenant('u1', 't1');
    expect([...cache._cache.keys()].sort()).toEqual(['banktx:u2:t1:acc-9', 'summary:u1:t10', 'summary:u1:t2', 'summary:u2:t1']);
  });

  test('clearCache still drops every company of the user', () => {
    cache.clearCache('u1');
    expect([...cache._cache.keys()].sort()).toEqual(['banktx:u2:t1:acc-9', 'summary:u2:t1']);
  });
});
