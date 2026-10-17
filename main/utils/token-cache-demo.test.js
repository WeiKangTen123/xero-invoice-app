// A demo account in the token cache: its token is 'demo:<userId>' with no
// reconnect and no refresh, its one organisation is the Demo Company with no
// xero_tenants row behind it, and its connection health is a Web app
// connection granted everything. Real users and database; the Xero
// reconnects are replaced so a real account's path can be seen taken, and
// the demo folder is stubbed to its contract.
jest.mock('../xero/connect',   () => ({ refreshClientCredentialsToken: jest.fn() }));
jest.mock('../xero/oauth',     () => ({ refreshAuthCodeToken: jest.fn() }));
jest.mock('../xero/reconnect', () => ({ reconnectXero: jest.fn() }));
jest.mock('../xero/demo/api', () => {
  const PREFIX = 'demo:';
  return {
    DEMO_TENANT: { tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' },
    DEMO_TOKEN_PREFIX: PREFIX,
    isDemoToken: t => typeof t === 'string' && t.startsWith(PREFIX),
    userIdFromDemoToken: t => (typeof t === 'string' && t.startsWith(PREFIX) ? t.slice(PREFIX.length) : null),
    demoApiFor: jest.fn(),
  };
});

describe('token-cache — demo accounts', () => {
  let tokenCache, users, db, reconnectXero, demo, real;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    db         = require('../db');
    users      = require('./users');
    tokenCache = require('./token-cache');
    ({ reconnectXero } = require('../xero/reconnect'));
    reconnectXero.mockResolvedValue(undefined);
    demo = await users.createUser('demo@test.com', 'password123', 'user', { demo: true });
    real = await users.createUser('real@test.com', 'password123', 'user');
  });

  test("getValidToken answers 'demo:<userId>' for any tenant, with no reconnect and no refresh", async () => {
    const cache = tokenCache.forUser(demo.id);
    expect(await cache.getValidToken('demo-company')).toBe(`demo:${demo.id}`);
    expect(await cache.getValidToken('anything')).toBe(`demo:${demo.id}`);
    expect(reconnectXero).not.toHaveBeenCalled();
    expect(require('../xero/oauth').refreshAuthCodeToken).not.toHaveBeenCalled();
    expect(require('../xero/connect').refreshClientCredentialsToken).not.toHaveBeenCalled();
  });

  test('a real account with a cold cache still reconnects', async () => {
    await expect(tokenCache.forUser(real.id).getValidToken('t-1')).rejects.toThrow(/reconnect xero first/i);
    expect(reconnectXero).toHaveBeenCalledWith(real.id);
  });

  test('the Demo Company is its one organisation, in memory and on file, with no xero_tenants row', () => {
    const cache = tokenCache.forUser(demo.id);
    expect(cache.getAllTenants()).toEqual([{ tenant_id: 'demo-company', tenant_name: 'Demo Company Pte Ltd' }]);
    expect(tokenCache.getPersistedTenants(demo.id)).toEqual([
      { tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd', connectedAt: demo.createdAt },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM xero_tenants WHERE user_id = ?').get(demo.id).n).toBe(0);
    expect(tokenCache.getPersistedTenants(real.id)).toEqual([]);
    expect(tokenCache.forUser(real.id).getAllTenants()).toEqual([]);
  });

  test('nothing removes or replaces it: clear, removeTenant and pruneTenants leave the Demo Company', () => {
    const cache = tokenCache.forUser(demo.id);
    cache.clear();
    cache.removeTenant('demo-company');
    cache.pruneTenants([]);
    expect(cache.getAllTenants()).toHaveLength(1);
    expect(tokenCache.getPersistedTenants(demo.id)).toHaveLength(1);
  });

  test('its connection health is a Web app connection granted every scope, however it is marked', () => {
    const { OAUTH_SCOPES, JOURNALS_SCOPE, ATTACHMENTS_SCOPE, BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE } = require('../xero/xero-utils');
    const health = tokenCache.getHealth(demo.id);
    expect(health).toMatchObject({
      method: 'demo', needsReconnect: false, reason: null, fingerprint: null, refusedScopes: [], declinedScopes: [], scopeProbe: null,
      lastRefreshedAt: demo.createdAt,
    });
    expect(health.grantedScopes).toEqual(['offline_access', ...OAUTH_SCOPES.split(' ')]);
    for (const s of [JOURNALS_SCOPE, ATTACHMENTS_SCOPE, BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE]) expect(health.grantedScopes).toContain(s);

    tokenCache.markNeedsReconnect(demo.id, { method: 'oauth', reason: 'revoked' });
    tokenCache.markScopesRefused(demo.id, [JOURNALS_SCOPE]);
    expect(tokenCache.getHealth(demo.id)).toMatchObject({ needsReconnect: false, refusedScopes: [] });
    // A real account's record is its own.
    tokenCache.markNeedsReconnect(real.id, { method: 'oauth', reason: 'revoked' });
    expect(tokenCache.getHealth(real.id)).toMatchObject({ needsReconnect: true, reason: 'revoked', grantedScopes: null });
  });
});
