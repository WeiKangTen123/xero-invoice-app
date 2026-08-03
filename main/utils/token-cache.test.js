jest.mock('../xero/connect', () => ({ refreshClientCredentialsToken: jest.fn() }));
jest.mock('../xero/oauth',   () => ({ refreshAuthCodeToken: jest.fn() }));

describe('token-cache', () => {
  let tokenCache, refreshClientCredentialsToken, refreshAuthCodeToken;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    // db/index.js opens a real (in-memory, since NODE_ENV=test) connection —
    // token-cache.js best-effort-persists to xero_tenants, harmless here.
    require('../db/migrate').run();
    tokenCache = require('./token-cache');
    ({ refreshClientCredentialsToken } = require('../xero/connect'));
    ({ refreshAuthCodeToken } = require('../xero/oauth'));
  });

  test('getAllTenants/getValidToken work for a token cached with the default (custom) type', async () => {
    const cache = tokenCache.forUser('user-1');
    // Comfortably past getValidToken's 60s expiry buffer, not right at the edge of it.
    cache.cacheToken('t1', 'Org', 'access-tok', new Date(Date.now() + 10 * 60_000));
    expect(await cache.getValidToken('t1')).toBe('access-tok');
    expect(cache.getAllTenants()).toEqual([{ tenant_id: 't1', tenant_name: 'Org' }]);
  });

  test('an expired custom-connection token refreshes via xero/connect, not xero/oauth', async () => {
    const cache = tokenCache.forUser('user-1');
    cache.cacheToken('t1', 'Org', 'stale-tok', new Date(Date.now() - 1000), 'custom');
    refreshClientCredentialsToken.mockResolvedValue({ access_token: 'fresh-tok', expires_at: new Date(Date.now() + 60_000) });

    const token = await cache.getValidToken('t1');

    expect(token).toBe('fresh-tok');
    expect(refreshClientCredentialsToken).toHaveBeenCalledWith('user-1');
    expect(refreshAuthCodeToken).not.toHaveBeenCalled();
  });

  test('an expired oauth token refreshes via xero/oauth, not xero/connect', async () => {
    const cache = tokenCache.forUser('user-2');
    cache.cacheToken('t2', 'Org', 'stale-tok', new Date(Date.now() - 1000), 'oauth');
    refreshAuthCodeToken.mockResolvedValue({ access_token: 'fresh-oauth-tok', expires_at: new Date(Date.now() + 60_000) });

    const token = await cache.getValidToken('t2');

    expect(token).toBe('fresh-oauth-tok');
    expect(refreshAuthCodeToken).toHaveBeenCalledWith('user-2');
    expect(refreshClientCredentialsToken).not.toHaveBeenCalled();
  });

  test('the connection type survives a refresh — a second expiry still refreshes via the same mechanism', async () => {
    const cache = tokenCache.forUser('user-3');
    cache.cacheToken('t3', 'Org', 'stale-tok', new Date(Date.now() - 1000), 'oauth');
    refreshAuthCodeToken.mockResolvedValue({ access_token: 'tok-2', expires_at: new Date(Date.now() - 1000) }); // immediately stale again
    await cache.getValidToken('t3');

    refreshAuthCodeToken.mockResolvedValue({ access_token: 'tok-3', expires_at: new Date(Date.now() + 60_000) });
    await cache.getValidToken('t3');

    expect(refreshAuthCodeToken).toHaveBeenCalledTimes(2);
    expect(refreshClientCredentialsToken).not.toHaveBeenCalled();
  });

  test('getValidToken throws a clear error for a tenant with no cached token', async () => {
    const cache = tokenCache.forUser('user-4');
    await expect(cache.getValidToken('unknown-tenant')).rejects.toThrow(/reconnect xero first/i);
  });

  test('clear() empties both tokens and tenants', () => {
    const cache = tokenCache.forUser('user-5');
    cache.cacheToken('t5', 'Org', 'tok', new Date(Date.now() + 60_000));
    cache.clear();
    expect(cache.getAllTenants()).toEqual([]);
  });
});
