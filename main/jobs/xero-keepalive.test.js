// The daily keep-alive refreshes OAuth connections nobody has used for a week,
// so an idle account's refresh token never reaches Xero's 60-day lapse. Real
// users, token cache and database; the OAuth reconnect itself is replaced, so
// nothing here reaches Xero.
jest.mock('../xero/oauth', () => ({ reconnect: jest.fn() }));

const DAY = 24 * 60 * 60 * 1000;

describe('jobs/xero-keepalive', () => {
  let keepalive, users, tokenCache, oauth, now;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users      = require('../utils/users');
    tokenCache = require('../utils/token-cache');
    oauth      = require('../xero/oauth');
    keepalive  = require('./xero-keepalive');
    oauth.reconnect.mockResolvedValue([{ tenantId: 't-1' }]);
    now = Date.now();
  });

  afterEach(() => {
    keepalive.stop();
    jest.useRealTimers();
  });

  async function account(name, { type = 'oauth', token = 'rt', refreshedDaysAgo = null, connectedDaysAgo = null, disabled = false, dead = false } = {}) {
    const u = await users.createUser(`${name}@test.com`, 'password123', 'user');
    users.saveUserConfig(u.id, {
      XERO_CONNECTION_TYPE: type,
      XERO_OAUTH_REFRESH_TOKEN: token,
      ...(connectedDaysAgo !== null && { XERO_OAUTH_CONNECTED_AT: new Date(now - connectedDaysAgo * DAY).toISOString() }),
    });
    if (refreshedDaysAgo !== null) tokenCache.markRefreshed(u.id, { method: 'oauth', at: new Date(now - refreshedDaysAgo * DAY) });
    if (dead) tokenCache.markNeedsReconnect(u.id, { method: 'oauth', reason: 'revoked' });
    if (disabled) users.setDisabled(u.id, true);
    return u.id;
  }

  test('refreshes only active OAuth connections not refreshed for 7+ days', async () => {
    const stale    = await account('stale',    { refreshedDaysAgo: 8 });
    const fresh    = await account('fresh',    { refreshedDaysAgo: 1 });
    const legacy   = await account('legacy',   { connectedDaysAgo: 30 });   // connected before refreshes were recorded
    const unknown  = await account('unknown');                              // nothing says when: refresh to be safe
    const disabled = await account('disabled', { refreshedDaysAgo: 20, disabled: true });
    const custom   = await account('custom',   { type: 'custom', token: '' });
    const dead     = await account('dead',     { refreshedDaysAgo: 20, dead: true });
    const noToken  = await account('notoken',  { token: '' });

    const summary = await keepalive.runOnce({ now });

    const refreshed = oauth.reconnect.mock.calls.map(([id]) => id);
    expect(refreshed.sort()).toEqual([stale, legacy, unknown].sort());
    for (const id of [fresh, disabled, custom, dead, noToken]) expect(refreshed).not.toContain(id);
    expect(summary).toEqual({ checked: 5, refreshed: 3, skipped: 2, failed: 0 });
  });

  test('exactly seven days counts as stale; just under does not', async () => {
    const seven = await account('seven', { refreshedDaysAgo: 7 });
    await account('six', { refreshedDaysAgo: 6.9 });
    await keepalive.runOnce({ now });
    expect(oauth.reconnect.mock.calls.map(([id]) => id)).toEqual([seven]);
  });

  test('one account at a time', async () => {
    for (const n of ['a', 'b', 'c']) await account(n, { refreshedDaysAgo: 10 });
    let inFlight = 0;
    let most = 0;
    oauth.reconnect.mockImplementation(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise(r => setImmediate(r));
      inFlight--;
    });
    await keepalive.runOnce({ now });
    expect(oauth.reconnect).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
  });

  test('never throws: one failure is logged and the run carries on', async () => {
    const first  = await account('first',  { refreshedDaysAgo: 10 });
    const second = await account('second', { refreshedDaysAgo: 10 });
    oauth.reconnect.mockImplementation(async id => {
      if (id === first) throw Object.assign(new Error('boom'), { needsReconnect: true });
    });

    const summary = await keepalive.runOnce({ now });

    expect(oauth.reconnect.mock.calls.map(([id]) => id)).toEqual([first, second]);
    expect(summary).toMatchObject({ refreshed: 1, failed: 1 });
  });

  test('never throws even when the accounts cannot be listed', async () => {
    jest.spyOn(users, 'getAllUsers').mockImplementation(() => { throw new Error('database is locked'); });
    await expect(keepalive.runOnce({ now })).resolves.toEqual({ checked: 0, refreshed: 0, skipped: 0, failed: 0 });
  });

  test('start() schedules a first run after boot and then one a day, once however often it is called', async () => {
    // The account first: password hashing runs on real timers.
    const stale = await account('scheduled', { refreshedDaysAgo: 10 });
    jest.useFakeTimers({ now });

    const intervals = jest.spyOn(global, 'setInterval');
    const delays    = jest.spyOn(global, 'setTimeout');

    keepalive.start();
    keepalive.start();
    expect(intervals.mock.calls.filter(([, ms]) => ms === keepalive.DAY_MS)).toHaveLength(1);
    expect(delays.mock.calls.filter(([, ms]) => ms === keepalive.FIRST_RUN_DELAY_MS)).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(keepalive.FIRST_RUN_DELAY_MS);
    expect(oauth.reconnect.mock.calls.map(([id]) => id)).toEqual([stale]);

    // A day later it runs again; the account was just refreshed (by the mock,
    // nothing recorded) so it is still stale and is refreshed again.
    await jest.advanceTimersByTimeAsync(keepalive.DAY_MS);
    expect(oauth.reconnect).toHaveBeenCalledTimes(2);

    // Stopped: nothing more runs.
    keepalive.stop();
    await jest.advanceTimersByTimeAsync(keepalive.DAY_MS);
    expect(oauth.reconnect).toHaveBeenCalledTimes(2);
  });
});
