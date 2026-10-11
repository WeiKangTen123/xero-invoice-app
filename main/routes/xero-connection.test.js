// GET /api/xero/connection — the shape the app-wide banner is built against —
// and DELETE /api/xero/oauth/disconnect revoking the token with Xero.
// Real routes, token cache, users and database; only axios is replaced, so
// nothing here reaches Xero.
jest.mock('axios');

const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

const KEYS = ['connected', 'method', 'missingScopes', 'needsReconnect', 'optional', 'probe', 'reason', 'refusedMessage', 'refusedScopes'];
const FUTURE = () => new Date(Date.now() + 30 * 60_000);
// Nothing refused at consent, which is every case here but one.
const NONE_REFUSED = { refusedScopes: [], refusedMessage: null };
// No OAuth connection, so no optional permissions and no probe.
const NO_OPTIONAL = { optional: null, probe: null };
const JOURNALS = 'accounting.journals.read';
const BS = 'accounting.reports.balancesheet.read';
const TB = 'accounting.reports.trialbalance.read';
// The two optional groups as the status reports them. The probe has not
// answered on a first read (it is started, not waited for), so it is null.
const OPTIONAL = (live, balance) => ({
  optional: {
    live:    { label: 'Live updates',  scopes: [JOURNALS], status: live },
    balance: { label: 'Balance Sheet', scopes: [BS, TB],   status: balance },
  },
  probe: null,
});
// Xero's authorize page, as it was seen to answer on 2026-10-11: a 302 to its
// sign-in page when it accepts the scopes asked for, to its error page when
// it does not. Refuses the journals scope, accepts everything else.
const AUTHORIZE_REFUSING_JOURNALS = (url, opts) => {
  const scope = String((opts && opts.params && opts.params.scope) || '');
  const location = scope.includes(JOURNALS)
    ? 'https://login.xero.com/identity/error?errorId=abc'
    : 'https://login.xero.com/identity/user/login?ReturnUrl=%2Fidentity%2Fconnect%2Fauthorize%2Fcallback';
  return Promise.resolve({ status: 302, headers: { location }, data: '' });
};

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
      expect(await status()).toEqual({ method: null, connected: false, needsReconnect: false, reason: null, missingScopes: [], ...NONE_REFUSED, ...NO_OPTIONAL });
    });

    test('a working OAuth connection with every scope', async () => {
      connectOAuth();
      withOrg('oauth');
      tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: oauth.SCOPES.split(' ') });
      expect(await status()).toEqual({
        method: 'oauth', connected: true, needsReconnect: false, reason: null, missingScopes: [], ...NONE_REFUSED,
        ...OPTIONAL('granted', 'granted'),
      });
    });

    test('a working Custom Connection', async () => {
      users.saveUserConfig(user.id, { XERO_CONNECTION_TYPE: 'custom', XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs' });
      withOrg('custom');
      expect(await status()).toEqual({ method: 'custom', connected: true, needsReconnect: false, reason: null, missingScopes: [], ...NONE_REFUSED, ...NO_OPTIONAL });
    });

    test('Custom Connection credentials saved but no type recorded still count as custom', async () => {
      users.saveUserConfig(user.id, { XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs' });
      expect(await status()).toEqual({ method: 'custom', connected: false, needsReconnect: false, reason: null, missingScopes: [], ...NONE_REFUSED, ...NO_OPTIONAL });
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
        reason: expect.stringMatching(/reconnect xero in setup/i), missingScopes: [], ...NONE_REFUSED,
        ...OPTIONAL('unknown', 'unknown'),
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
        method: 'oauth', connected: true, needsReconnect: false, reason: null, missingScopes: ['accounting.attachments'], ...NONE_REFUSED,
        ...OPTIONAL('granted', 'granted'),
      });
    });

    test('scopes Xero refused this app at consent are carried apart, with the message, and are not missing', async () => {
      connectOAuth();
      withOrg('oauth');
      const refused = ['accounting.reports.balancesheet.read', 'accounting.reports.trialbalance.read'];
      tokenCache.markScopesRefused(user.id, refused);
      tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: oauth.SCOPES.split(' ').filter(s => !refused.includes(s)) });
      expect(await status()).toEqual({
        method: 'oauth', connected: true, needsReconnect: false, reason: null, missingScopes: [],
        refusedScopes: refused, refusedMessage: 'Xero refused these permissions for this app',
        ...OPTIONAL('granted', 'refused'),
      });
    });

    test('granted scopes not known yet report nothing missing', async () => {
      connectOAuth();
      withOrg('oauth');
      expect((await status()).missingScopes).toEqual([]);
    });

    // ?force=true asks Xero's authorize page now and waits. A connection made
    // before the optional groups existed has neither; the probe says which
    // this app may ask for: the one refused is reported as such and leaves
    // the "missing" list, the one allowed is missing (a reconnect adds it).
    test('?force=true asks Xero which permissions this app may request, and reports each', async () => {
      connectOAuth();
      withOrg('oauth');
      tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: oauth.SCOPES.split(' ').filter(s => ![JOURNALS, BS, TB].includes(s)) });
      axios.get.mockImplementation(AUTHORIZE_REFUSING_JOURNALS);

      const res = await request(serverFor(app)).get('/api/xero/connection?force=true').set('Authorization', auth()).expect(200);
      expect(res.body.optional.live.status).toBe('refused');
      expect(res.body.optional.balance.status).toBe('missing');
      expect(res.body.missingScopes).toEqual([BS, TB]);
      expect(res.body.refusedScopes).toEqual([JOURNALS]);
      expect(res.body.probe).toEqual({ at: expect.any(String), base: 'available', groups: { live: 'refused', balance: 'available' } });

      // Three questions: the base set, then the base set with each group. No
      // secret goes with them and no redirect is followed.
      expect(axios.get).toHaveBeenCalledTimes(3);
      for (const [url, opts] of axios.get.mock.calls) {
        expect(url).toBe('https://login.xero.com/identity/connect/authorize');
        expect(opts.maxRedirects).toBe(0);
        expect(JSON.stringify(opts)).not.toContain('secret');
        expect(opts.params.client_id).toBe('cid');
      }

      // Asked again within the day, the answer on file is used.
      axios.get.mockClear();
      await request(serverFor(app)).get('/api/xero/connection').set('Authorization', auth()).expect(200);
      expect(axios.get).not.toHaveBeenCalled();
    });

    test('a probe Xero cannot answer leaves both unknown and records nothing as refused', async () => {
      connectOAuth();
      withOrg('oauth');
      tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: oauth.SCOPES.split(' ').filter(s => ![JOURNALS, BS, TB].includes(s)) });
      axios.get.mockRejectedValue(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }));

      const res = await request(serverFor(app)).get('/api/xero/connection?force=true').set('Authorization', auth()).expect(200);
      expect(res.body.optional.live.status).toBe('unknown');
      expect(res.body.optional.balance.status).toBe('unknown');
      expect(res.body.refusedScopes).toEqual([]);
      expect(res.body.probe).toMatchObject({ base: 'unknown', groups: { live: 'unknown', balance: 'unknown' } });
    });

    test('a group left unticked at Connect is declined, not missing', async () => {
      connectOAuth();
      withOrg('oauth');
      tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: oauth.SCOPES.split(' ').filter(s => s !== JOURNALS) });
      tokenCache.markScopesDeclined(user.id, [JOURNALS]);
      const body = await status();
      expect(body.optional.live.status).toBe('declined');
      expect(body.optional.balance.status).toBe('granted');
      expect(body.missingScopes).toEqual([]);
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
      expect(await status()).toEqual({ method: null, connected: false, needsReconnect: false, reason: null, missingScopes: [], ...NONE_REFUSED, ...NO_OPTIONAL });
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
