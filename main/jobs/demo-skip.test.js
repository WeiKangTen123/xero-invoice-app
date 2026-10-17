// The background jobs that keep a Xero connection alive or look for changes
// in it leave a demo account alone: it has no connection, whatever its
// config says, and its Demo Company never changes. Real users, token cache
// and database; the reconnect and the look are replaced, so nothing here
// reaches Xero, and the demo folder is stubbed to its contract.
jest.mock('../xero/oauth',           () => ({ reconnect: jest.fn() }));
jest.mock('../xero/change-detector', () => ({ due: jest.fn(), pollTenant: jest.fn() }));
jest.mock('../xero/demo/api', () => ({
  DEMO_TENANT: { tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' },
  DEMO_TOKEN_PREFIX: 'demo:',
  isDemoToken: t => typeof t === 'string' && t.startsWith('demo:'),
  userIdFromDemoToken: t => (typeof t === 'string' && t.startsWith('demo:') ? t.slice(5) : null),
  demoApiFor: jest.fn(),
}));

const DAY  = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe('jobs — a demo account is skipped', () => {
  let users, tokenCache, oauth, detector, demo, real;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users      = require('../utils/users');
    tokenCache = require('../utils/token-cache');
    oauth      = require('../xero/oauth');
    detector   = require('../xero/change-detector');
    oauth.reconnect.mockResolvedValue([{ tenantId: 't-1' }]);
    detector.due.mockReturnValue(true);
    detector.pollTenant.mockResolvedValue({ live: true, liveReason: null, changed: false, reason: null, calls: 2 });
    demo = await users.createUser('demo@test.com', 'password123', 'user', { demo: true });
    real = await users.createUser('real@test.com', 'password123', 'user');
    // Both look like stale OAuth connections on file; only the real one is.
    for (const u of [demo, real]) {
      users.saveUserConfig(u.id, { XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_REFRESH_TOKEN: 'rt', XERO_OAUTH_CONNECTED_AT: new Date(Date.now() - 30 * DAY).toISOString() });
    }
    tokenCache.forUser(real.id).cacheToken('t-1', 'Real Org', 'at', Date.now() + HOUR, 'oauth');
  });

  afterEach(() => {
    require('./xero-keepalive').stop();
    require('./xero-change-detector').stop();
  });

  test('the keep-alive refreshes the real connection and never the demo account', async () => {
    const summary = await require('./xero-keepalive').runOnce({ now: Date.now() });
    expect(oauth.reconnect.mock.calls.map(([id]) => id)).toEqual([real.id]);
    expect(summary).toEqual({ checked: 1, refreshed: 1, skipped: 0, failed: 0 });
  });

  test('the change detector looks at the real company and never at the Demo Company', async () => {
    const summary = await require('./xero-change-detector').runOnce({ now: () => new Date() });
    expect(detector.due.mock.calls.map(([id, tenantId]) => [id, tenantId])).toEqual([[real.id, 't-1']]);
    expect(detector.pollTenant.mock.calls.map(([id, tenantId]) => [id, tenantId])).toEqual([[real.id, 't-1']]);
    expect(summary).toMatchObject({ accounts: 1, companies: 1, polled: 1 });
  });
});
