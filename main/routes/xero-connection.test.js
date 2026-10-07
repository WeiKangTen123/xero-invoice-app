// GET /api/xero/connection — the shape the app-wide banner is built against —
// and DELETE /api/xero/oauth/disconnect revoking the token with Xero.
// Real routes, token cache, users and database; only axios is replaced, so
// nothing here reaches Xero.
jest.mock('axios');

const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

const KEYS = ['connected', 'method', 'missingScopes', 'needsReconnect', 'reason'];
const FUTURE = () => new Date(Date.now() + 30 * 60_000);

describe('routes/xero-oauth — connection status and disconnect', () => {
  let app, users, tokenCache, oauth, axios, jwtSecret, user;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.XERO_OAUTH_REDIRECT_URI = 'https://example.test/api/xero/oauth/callback';
    require('../db/migrate').run();
    axios      = require('axios');
    users      = require('../utils/users');
    tokenCache = require('../utils/token-cache');
    oauth      = require('../xero/oauth');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/xero', require('./xero-oauth'));
    user = await users.createUser('conn@test.com', 'password123', 'user');
  });

  afterEach(() => { process.env = { ...originalEnv }; });

  const auth = () => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;
  const status = async () => {
    const res = await request(serverFor(app)).get('/api/xero/connection').set('Authorization', auth()).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(KEYS);
    return res.body;
  };
  const connectOAuth = (extra = {}) => users.saveUserConfig(user.id, {
    XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret',
    XERO_OAUTH_REFRESH_TOKEN: 'rt-live', ...extra,
  });
  const withOrg = type => tokenCache.forUser(user.id).cacheToken('t-1', 'Org One', 'at', FUTURE(), type);

  describe('GET /connection', () => {
    test('requires authentication', async () => {
      await request(serverFor(app)).get('/api/xero/connection').expect(401);
    });

    test('nothing set up', async () => {
      expect(await status()).toEqual({ method: null, connected: false, needsReconnect: false, reason: null, missingScopes: [] });
    });

    test('a working OAuth connection with every scope', async () => {
      connectOAuth();
      withOrg('oauth');
      tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: oauth.SCOPES.split(' ') });
      expect(await status()).toEqual({ method: 'oauth', connected: true, needsReconnect: false, reason: null, missingScopes: [] });
    });

    test('a working Custom Connection', async () => {
      users.saveUserConfig(user.id, { XERO_CONNECTION_TYPE: 'custom', XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs' });
      withOrg('custom');
      expect(await status()).toEqual({ method: 'custom', connected: true, needsReconnect: false, reason: null, missingScopes: [] });
    });

    test('Custom Connection credentials saved but no type recorded still count as custom', async () => {
      users.saveUserConfig(user.id, { XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs' });
      expect(await status()).toEqual({ method: 'custom', connected: false, needsReconnect: false, reason: null, missingScopes: [] });
    });

    test('an OAuth connection Xero refused (invalid_grant) needs a reconnect', async () => {
      connectOAuth();
      withOrg('oauth');
      axios.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { error: 'invalid_grant' } },
      }));
      await oauth.refreshAuthCodeToken(user.id).catch(() => {});

      const body = await status();
      expect(body).toEqual({
        method: 'oauth', connected: false, needsReconnect: true,
        reason: expect.stringMatching(/reconnect xero in setup/i), missingScopes: [],
      });
    });

    test('OAuth chosen but no refresh token on file needs a reconnect', async () => {
      connectOAuth({ XERO_OAUTH_REFRESH_TOKEN: '' });
      const body = await status();
      expect(body).toMatchObject({ method: 'oauth', connected: false, needsReconnect: true });
      expect(body.reason).toMatch(/connect xero in setup/i);
    });

    test('a connection made before accounting.attachments was added names the missing scope', async () => {
      connectOAuth();
      withOrg('oauth');
      const before = oauth.SCOPES.split(' ').filter(s => s !== 'accounting.attachments');
      tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: before });
      expect(await status()).toEqual({
        method: 'oauth', connected: true, needsReconnect: false, reason: null, missingScopes: ['accounting.attachments'],
      });
    });

    test('granted scopes not known yet report nothing missing', async () => {
      connectOAuth();
      withOrg('oauth');
      expect((await status()).missingScopes).toEqual([]);
    });
  });

  describe('DELETE /oauth/disconnect', () => {
    test('revokes the refresh token with Xero, then clears the connection here', async () => {
      connectOAuth();
      withOrg('oauth');
      tokenCache.markNeedsReconnect(user.id, { method: 'oauth', reason: 'old trouble' });
      axios.post.mockResolvedValue({ status: 200, data: {} });

      await request(serverFor(app)).delete('/api/xero/oauth/disconnect').set('Authorization', auth()).expect(200);

      expect(axios.post).toHaveBeenCalledTimes(1);
      const [url, body, opts] = axios.post.mock.calls[0];
      expect(url).toBe('https://identity.xero.com/connect/revocation');
      expect(body.get('token')).toBe('rt-live');
      expect(opts.headers.Authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);

      const config = users.getUserConfig(user.id);
      expect(config.XERO_OAUTH_REFRESH_TOKEN).toBeUndefined();
      expect(config.XERO_CONNECTION_TYPE).toBeUndefined();
      expect(tokenCache.getPersistedTenants(user.id)).toEqual([]);
      expect(await status()).toEqual({ method: null, connected: false, needsReconnect: false, reason: null, missingScopes: [] });
    });

    test('still disconnects when Xero cannot be reached to revoke', async () => {
      connectOAuth();
      withOrg('oauth');
      axios.post.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

      const res = await request(serverFor(app)).delete('/api/xero/oauth/disconnect').set('Authorization', auth()).expect(200);

      expect(res.body).toEqual({ success: true });
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(users.getUserConfig(user.id).XERO_OAUTH_REFRESH_TOKEN).toBeUndefined();
    });

    test('with no token on file there is nothing to revoke', async () => {
      await request(serverFor(app)).delete('/api/xero/oauth/disconnect').set('Authorization', auth()).expect(200);
      expect(axios.post).not.toHaveBeenCalled();
    });
  });
});
