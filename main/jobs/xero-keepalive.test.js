// The daily keep-alive refreshes OAuth connections nobody has used for a week,
// so an idle account's refresh token never reaches Xero's 60-day lapse,
// including the real connection of an admin who has switched to sample data.
// Real users, token cache and database; the OAuth reconnect itself is
// replaced (or, in one test, Xero's HTTP endpoints are), so nothing here
// reaches Xero.
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

  // `sampleData` switches the account to the Demo Company after its real
  // connection is recorded, as an admin's own switch does (users.setDemo),
  // and dates the account 90 days back: the demo stand-in's health reads as
  // refreshed the day the account was made, so an account made today would
  // look fresh to a keep-alive reading the stand-in, and one made long ago
  // stale, whatever its real connection says.
  async function account(name, {
    type = 'oauth', token = 'rt', refreshedDaysAgo = null, connectedDaysAgo = null, disabled = false, dead = false,
    role = 'user', sampleData = false,
  } = {}) {
    const u = await users.createUser(`${name}@test.com`, 'password123', role);
    users.saveUserConfig(u.id, {
      XERO_CONNECTION_TYPE: type,
      XERO_OAUTH_REFRESH_TOKEN: token,
      ...(connectedDaysAgo !== null && { XERO_OAUTH_CONNECTED_AT: new Date(now - connectedDaysAgo * DAY).toISOString() }),
    });
    if (refreshedDaysAgo !== null) tokenCache.markRefreshed(u.id, { method: 'oauth', at: new Date(now - refreshedDaysAgo * DAY) });
    if (dead) tokenCache.markNeedsReconnect(u.id, { method: 'oauth', reason: 'revoked' });
    if (disabled) users.setDisabled(u.id, true);
    if (sampleData) {
      users.setDemo(u.id, true);
      require('../db').prepare('UPDATE users SET created_at = ? WHERE id = ?').run(new Date(now - 90 * DAY).toISOString(), u.id);
    }
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

  // An admin can switch their own account to sample data and back
  // (PUT /api/setup/data-source); the real connection waits underneath and
  // must not lapse meanwhile. It is judged by its own stored health, never
  // the stand-in, which never needs reconnecting and is as old as the account.
  test('an admin on sample data keeps its real connection alive, judged by that connection\'s own health', async () => {
    const stale    = await account('admin-stale', { role: 'admin', sampleData: true, refreshedDaysAgo: 8 });
    const fresh    = await account('admin-fresh', { role: 'admin', sampleData: true, refreshedDaysAgo: 1 });
    const dead     = await account('admin-dead',  { role: 'admin', sampleData: true, refreshedDaysAgo: 20, dead: true });
    const demoUser = await account('demo-user',   { sampleData: true, refreshedDaysAgo: 20 });
    // An admin on sample data with no real connection has nothing to keep.
    const none     = await account('admin-none',  { role: 'admin', sampleData: true, type: '', token: '' });
    expect(tokenCache.getHealth(stale)).toMatchObject({ method: 'demo' });

    const summary = await keepalive.runOnce({ now });

    expect(oauth.reconnect.mock.calls.map(([id]) => id)).toEqual([stale]);
    for (const id of [fresh, dead, demoUser, none]) expect(oauth.reconnect.mock.calls.map(([x]) => x)).not.toContain(id);
    expect(summary).toEqual({ checked: 3, refreshed: 1, skipped: 2, failed: 0 });
  });

  // Nothing in oauth.js knows about demo accounts: the stored refresh token
  // is redeemed and replaced as for any account, and the record of the real
  // connection is updated on top of what it said (its refused scopes, its
  // probe), never rebuilt from the stand-in. The account still reads as the
  // Demo Company throughout, and as its real connection once switched back.
  test('for an admin on sample data the refresh is real, and lands on the real connection', async () => {
    const id = await account('admin-real', { role: 'admin', refreshedDaysAgo: 10 });
    users.saveUserConfig(id, { XERO_OAUTH_CLIENT_ID: 'oauth-id', XERO_OAUTH_CLIENT_SECRET: 'oauth-secret' });
    tokenCache.markScopesRefused(id, ['accounting.reports.balancesheet.read']);
    tokenCache.saveScopeProbe(id, { at: new Date(now).toISOString(), fingerprint: 'fp', base: 'available', groups: {} });
    users.setDemo(id, true);

    const savedRedirect = process.env.XERO_OAUTH_REDIRECT_URI;
    process.env.XERO_OAUTH_REDIRECT_URI = 'https://app.test/oauth/callback';
    jest.doMock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
    try {
      const axios = require('axios');
      axios.post.mockResolvedValue({ data: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 1800, scope: 'offline_access accounting.invoices' } });
      axios.get.mockResolvedValue({ data: [{ tenantId: 't-real', tenantName: 'Real Org' }] });
      const realOauth = jest.requireActual('../xero/oauth');
      oauth.reconnect.mockImplementation((...args) => realOauth.reconnect(...args));

      expect(await keepalive.runOnce({ now })).toEqual({ checked: 1, refreshed: 1, skipped: 0, failed: 0 });

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(String(axios.post.mock.calls[0][1])).toContain('refresh_token=rt');
      expect(users.getUserConfig(id).XERO_OAUTH_REFRESH_TOKEN).toBe('rt-new');
      const real = tokenCache.getHealth(id, { stored: true });
      expect(real).toMatchObject({
        method: 'oauth', needsReconnect: false, grantedScopes: ['offline_access', 'accounting.invoices'],
        refusedScopes: ['accounting.reports.balancesheet.read'], scopeProbe: { fingerprint: 'fp' },
      });
      expect(now - Date.parse(real.lastRefreshedAt)).toBeLessThan(DAY);

      // Still the Demo Company while on sample data.
      expect(tokenCache.getHealth(id)).toMatchObject({ method: 'demo' });
      expect(await tokenCache.forUser(id).getValidToken('t-real')).toBe(`demo:${id}`);

      // Switched back, the connection is the one just refreshed.
      users.setDemo(id, false);
      expect(tokenCache.getHealth(id)).toEqual(real);
      expect(await tokenCache.forUser(id).getValidToken('t-real')).toBe('at-new');
    } finally {
      jest.dontMock('axios');
      if (savedRedirect === undefined) delete process.env.XERO_OAUTH_REDIRECT_URI;
      else process.env.XERO_OAUTH_REDIRECT_URI = savedRedirect;
    }
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
