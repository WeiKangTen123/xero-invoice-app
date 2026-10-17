// A demo account at the Xero connection routes: GET /api/xero/connection
// says it is connected to the Demo Company with everything granted, and
// every route that would make, finish, test or drop a connection is refused
// with the one message. Real routes, users, token cache and database; axios
// is replaced so nothing can reach Xero (and to see that nothing tries), and
// the demo folder is stubbed to its contract.
jest.mock('axios');
jest.mock('../xero/demo/api', () => ({
  DEMO_TENANT: { tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' },
  DEMO_TOKEN_PREFIX: 'demo:',
  isDemoToken: t => typeof t === 'string' && t.startsWith('demo:'),
  userIdFromDemoToken: t => (typeof t === 'string' && t.startsWith('demo:') ? t.slice(5) : null),
  demoApiFor: jest.fn(),
}));

const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

const MESSAGE = 'Demo account: sample data, no Xero connection.';
const KEYS = ['connected', 'method', 'missingScopes', 'needsReconnect', 'optional', 'probe', 'reason', 'refusedMessage', 'refusedScopes'];

describe('routes/xero-oauth and routes/setup — a demo account', () => {
  let app, users, axios, jwtSecret, demo, real;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.XERO_OAUTH_REDIRECT_URI = 'https://example.test/api/xero/oauth/callback';
    require('../db/migrate').run();
    axios = require('axios');
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/xero', require('./xero-oauth'));
    app.use('/api/setup', require('./setup'));
    demo = await users.createUser('demo@test.com', 'password123', 'user', { demo: true });
    real = await users.createUser('real@test.com', 'password123', 'user');
  });

  afterEach(() => { process.env = { ...originalEnv }; });

  const auth = user => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;
  const as = (user, method, url) => request(serverFor(app))[method](url).set('Authorization', auth(user));

  test('GET /connection: connected to the Demo Company, everything granted, no probe, and no call to Xero', async () => {
    // Even with a Client ID and a refresh token typed into its Setup: a demo
    // account is never an OAuth or Custom Connection.
    users.saveUserConfig(demo.id, {
      XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret', XERO_OAUTH_REFRESH_TOKEN: 'rt',
      XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs',
    });
    const res = await as(demo, 'get', '/api/xero/connection?force=true').expect(200);
    expect(res.body).toEqual({
      method: 'demo', connected: true, needsReconnect: false, reason: null,
      missingScopes: [], refusedScopes: [], refusedMessage: null,
      optional: {
        live:    { label: 'Live updates',  scopes: ['accounting.journals.read'], status: 'granted' },
        balance: { label: 'Balance Sheet', scopes: ['accounting.reports.balancesheet.read', 'accounting.reports.trialbalance.read'], status: 'granted' },
      },
      probe: null,
      demo: true,
      tenants: [{ tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd', connectedAt: demo.createdAt }],
    });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test("a real account's answer carries neither key", async () => {
    const res = await as(real, 'get', '/api/xero/connection').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(KEYS);
    expect(res.body).toMatchObject({ method: null, connected: false });
  });

  test('GET /tenants: the Demo Company, connection type demo', async () => {
    const res = await as(demo, 'get', '/api/xero/tenants').expect(200);
    expect(res.body).toEqual({
      connectionType: 'demo',
      tenants: [{ tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd', connectedAt: demo.createdAt }],
    });
    expect((await as(real, 'get', '/api/xero/tenants').expect(200)).body).toEqual({ connectionType: 'custom', tenants: [] });
  });

  test.each([
    ['get',    '/api/xero/oauth/connect'],
    ['post',   '/api/xero/oauth/complete'],
    ['delete', '/api/xero/oauth/disconnect'],
  ])('%s %s is refused for a demo account before anything happens', async (method, url) => {
    users.saveUserConfig(demo.id, {
      XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret', XERO_OAUTH_REFRESH_TOKEN: 'rt',
    });
    const res = await as(demo, method, url).send({ code: 'c', state: 's' }).expect(400);
    expect(res.body).toEqual({ error: MESSAGE });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    // Nothing cleared, nothing minted: the config is as it was.
    expect(users.getUserConfig(demo.id).XERO_OAUTH_REFRESH_TOKEN).toBe('rt');
  });

  test('POST /setup/test/xero is refused for a demo account, in both the error and the message the button shows', async () => {
    users.saveUserConfig(demo.id, { XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs' });
    const res = await as(demo, 'post', '/api/setup/test/xero').expect(400);
    expect(res.body).toEqual({ success: false, error: MESSAGE, message: MESSAGE });
    expect(axios.post).not.toHaveBeenCalled();
    expect(users.getUserConfig(demo.id).XERO_CONNECTION_TYPE).toBeUndefined();
  });

  test('xero/reconnect: testConnection refuses and reconnectXero answers the Demo Company without a call', async () => {
    const reconnect = require('../xero/reconnect');
    await expect(reconnect.testConnection(demo.id)).rejects.toThrow(MESSAGE);
    await expect(reconnect.reconnectXero(demo.id)).resolves.toEqual([{ tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' }]);
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
});
