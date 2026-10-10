// A refresh token Xero refuses (invalid_grant: revoked, or 60 days unused) or
// app credentials it refuses (invalid_client) used to surface as a bare
// "Request failed with status code 400", and every request tried the same dead
// credentials again. Now the refusal is classified, recorded per user, reported
// by getConnectionStatus, and not retried until something changes.
//
// Real token cache, users and database (in-memory under NODE_ENV=test); only
// axios is replaced, so nothing here reaches Xero.
jest.mock('axios');

const REDIRECT_URI = 'https://example.test/api/xero/oauth/callback';
const oauthError = code => Object.assign(new Error('Request failed with status code 400'), {
  response: { status: 400, data: { error: code } },
});
const tokenResponse = (extra = {}) => ({
  data: { access_token: 'at-new', refresh_token: 'rt-rotated', expires_in: 1800, ...extra },
});

describe('Xero connection health', () => {
  let axios, users, tokenCache, oauth, connect, reconnect, xeroUtils, user;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.XERO_OAUTH_REDIRECT_URI = REDIRECT_URI;
    require('../db/migrate').run();
    axios      = require('axios');
    users      = require('../utils/users');
    tokenCache = require('../utils/token-cache');
    oauth      = require('./oauth');
    connect    = require('./connect');
    reconnect  = require('./reconnect');
    xeroUtils  = require('./xero-utils');
    user = await users.createUser('health@test.com', 'password123', 'user');
    users.saveUserConfig(user.id, {
      XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret',
      XERO_OAUTH_REFRESH_TOKEN: 'rt-dead',
    });
  });

  afterEach(() => { process.env = { ...originalEnv }; });

  describe('invalid_grant on an OAuth refresh', () => {
    test('is a needs-reconnect error with a plain reason, and is recorded against the user', async () => {
      axios.post.mockRejectedValue(oauthError('invalid_grant'));

      const err = await oauth.refreshAuthCodeToken(user.id).catch(e => e);

      expect(err).toBeInstanceOf(xeroUtils.XeroReconnectError);
      expect(err).toMatchObject({ needsReconnect: true, code: 'XERO_RECONNECT_REQUIRED', oauthError: 'invalid_grant' });
      expect(xeroUtils.xeroErrMsg(err)).toMatch(/reconnect xero in setup/i);
      expect(xeroUtils.xeroErrMsg(err)).not.toMatch(/status code 400/);
      expect(tokenCache.getHealth(user.id)).toMatchObject({ method: 'oauth', needsReconnect: true });
      expect(reconnect.getConnectionStatus(user.id)).toMatchObject({
        method: 'oauth', connected: false, needsReconnect: true, reason: expect.stringMatching(/revoked|60 days/),
      });
    });

    test('is written to the database, so a restart still knows', async () => {
      axios.post.mockRejectedValue(oauthError('invalid_grant'));
      await oauth.refreshAuthCodeToken(user.id).catch(() => {});
      const row = require('../db').prepare('SELECT needs_reconnect, method, reason FROM xero_connection_health WHERE user_id = ?').get(user.id);
      expect(row).toMatchObject({ needs_reconnect: 1, method: 'oauth', reason: expect.stringMatching(/reconnect/i) });
    });

    test('is not retried: no refresh, cold-cache reconnect, expiry refresh or withRetry asks Xero again', async () => {
      axios.post.mockRejectedValue(oauthError('invalid_grant'));
      await oauth.refreshAuthCodeToken(user.id).catch(() => {});
      axios.post.mockClear();

      await expect(oauth.refreshAuthCodeToken(user.id)).rejects.toMatchObject({ needsReconnect: true });

      // Cold cache (after a restart): the reconnect fails fast, unwrapped.
      await expect(tokenCache.forUser(user.id).getValidToken('t-1'))
        .rejects.toMatchObject({ needsReconnect: true, message: expect.stringMatching(/reconnect xero in setup/i) });

      // An expired access token: the refresh fails fast too.
      tokenCache.forUser(user.id).cacheToken('t-2', null, 'at-old', new Date(Date.now() - 1000), 'oauth');
      await expect(tokenCache.forUser(user.id).getValidToken('t-2')).rejects.toMatchObject({ needsReconnect: true });

      // withRetry gives up on it at once.
      const fn = jest.fn(() => oauth.refreshAuthCodeToken(user.id));
      await expect(xeroUtils.withRetry(fn, 5, 1)).rejects.toMatchObject({ needsReconnect: true });
      expect(fn).toHaveBeenCalledTimes(1);

      expect(axios.post).not.toHaveBeenCalled();
    });

    test('a person pressing Test still asks Xero (force), and a working answer clears the mark', async () => {
      axios.post.mockRejectedValueOnce(oauthError('invalid_grant'));
      await oauth.refreshAuthCodeToken(user.id).catch(() => {});

      axios.post.mockResolvedValueOnce(tokenResponse());
      await expect(oauth.refreshAuthCodeToken(user.id, { force: true })).resolves.toMatchObject({ access_token: 'at-new' });
      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(tokenCache.getHealth(user.id).needsReconnect).toBe(false);
      expect(users.getUserConfig(user.id).XERO_OAUTH_REFRESH_TOKEN).toBe('rt-rotated');
    });

    test('a fresh consent clears it and says which scopes were granted', async () => {
      axios.post.mockRejectedValueOnce(oauthError('invalid_grant'));
      await oauth.refreshAuthCodeToken(user.id).catch(() => {});

      axios.post.mockResolvedValueOnce(tokenResponse({ refresh_token: 'rt-consented', scope: oauth.SCOPES }));
      axios.get.mockResolvedValueOnce({ data: [{ tenantId: 't-1', tenantName: 'Org One' }] });
      await oauth.completeConnection(user.id, 'the-code');

      expect(reconnect.getConnectionStatus(user.id)).toEqual({
        method: 'oauth', connected: true, needsReconnect: false, reason: null, missingScopes: [], refusedScopes: [], refusedMessage: null,
      });
    });

    test('a refresh token replaced some other way is tried, not refused from the old record', async () => {
      axios.post.mockRejectedValueOnce(oauthError('invalid_grant'));
      await oauth.refreshAuthCodeToken(user.id).catch(() => {});

      users.saveUserConfig(user.id, { XERO_OAUTH_REFRESH_TOKEN: 'rt-different' });
      expect(reconnect.getConnectionStatus(user.id).needsReconnect).toBe(false);
      axios.post.mockResolvedValueOnce(tokenResponse());
      await oauth.refreshAuthCodeToken(user.id);
      expect(axios.post.mock.calls[1][1].get('refresh_token')).toBe('rt-different');
    });
  });

  test('a failure Xero might recover from (a 502) is not a reconnect, and the next call asks again', async () => {
    axios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 502'), {
      response: { status: 502, data: '<html>Bad gateway</html>' },
    }));
    const err = await oauth.refreshAuthCodeToken(user.id).catch(e => e);
    expect(err.needsReconnect).toBeUndefined();
    expect(tokenCache.getHealth(user.id).needsReconnect).toBe(false);

    axios.post.mockResolvedValueOnce(tokenResponse());
    await oauth.refreshAuthCodeToken(user.id);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  // Xero rotates the refresh token on every use. Two refreshes racing with the
  // same token could have the loser refused with invalid_grant, which would
  // now mark a healthy connection as needing a reconnect.
  test('refreshes running at once share one request to Xero', async () => {
    users.saveUserConfig(user.id, { XERO_OAUTH_REFRESH_TOKEN: 'rt-live' });
    let release;
    axios.post.mockImplementation(() => new Promise(r => { release = () => r(tokenResponse()); }));

    const all = Promise.all([
      oauth.refreshAuthCodeToken(user.id),
      oauth.refreshAuthCodeToken(user.id),
      oauth.refreshAuthCodeToken(user.id),
    ]);
    await new Promise(r => setImmediate(r));
    release();
    const results = await all;

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(new Set(results.map(r => r.access_token))).toEqual(new Set(['at-new']));
  });

  test('the scopes granted on a refresh are recorded', async () => {
    users.saveUserConfig(user.id, { XERO_OAUTH_REFRESH_TOKEN: 'rt-live' });
    const withoutAttachments = oauth.SCOPES.split(' ').filter(s => s !== 'accounting.attachments').join(' ');
    axios.post.mockResolvedValueOnce(tokenResponse({ scope: withoutAttachments }));
    await oauth.refreshAuthCodeToken(user.id);
    expect(tokenCache.getHealth(user.id).grantedScopes).not.toContain('accounting.attachments');
  });

  // Not every Xero app may ask for the granular report scopes. Ones Xero
  // refused at consent are recorded (by the callback's retry, xero/oauth.js
  // retryAuthorizeUrl) and are then not "missing": no reconnect can gain them.
  test('scopes Xero refused at consent are reported apart, left out of the next consent link, and cleared by a disconnect', () => {
    const { BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE } = xeroUtils;
    tokenCache.forUser(user.id).cacheToken('t-1', 'Org One', 'at', new Date(Date.now() + 60_000), 'oauth');
    tokenCache.markScopesRefused(user.id, [BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE]);
    const granted = oauth.SCOPES.split(' ').filter(s => ![BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE, 'accounting.attachments'].includes(s));
    tokenCache.markRefreshed(user.id, { method: 'oauth', grantedScopes: granted });

    expect(reconnect.getConnectionStatus(user.id)).toEqual({
      method: 'oauth', connected: true, needsReconnect: false, reason: null,
      missingScopes:  ['accounting.attachments'],
      refusedScopes:  [BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE],
      refusedMessage: 'Xero refused these permissions for this app',
    });
    // Written to the database, so a restart still knows; and a refresh
    // recording granted scopes did not wipe it.
    const row = require('../db').prepare('SELECT refused_scopes FROM xero_connection_health WHERE user_id = ?').get(user.id);
    expect(row.refused_scopes).toBe(`${BALANCE_SHEET_SCOPE} ${TRIAL_BALANCE_SCOPE}`);

    const scopes = new URL(oauth.buildAuthorizeUrl(user.id)).searchParams.get('scope').split(' ');
    expect(scopes).not.toContain(BALANCE_SHEET_SCOPE);
    expect(scopes).not.toContain(TRIAL_BALANCE_SCOPE);
    expect(scopes).toEqual(expect.arrayContaining(['offline_access', 'accounting.attachments', 'accounting.journals.read']));

    tokenCache.clearHealth(user.id);
    expect(reconnect.getConnectionStatus(user.id)).toMatchObject({ refusedScopes: [], refusedMessage: null });
    expect(new URL(oauth.buildAuthorizeUrl(user.id)).searchParams.get('scope').split(' ')).toContain(BALANCE_SHEET_SCOPE);
  });

  test('the scopes can be read from the access token when the response does not list them', () => {
    const payload = Buffer.from(JSON.stringify({ scope: ['offline_access', 'accounting.invoices'] })).toString('base64url');
    expect(xeroUtils.grantedScopesFrom({ access_token: `h.${payload}.s` })).toEqual(['offline_access', 'accounting.invoices']);
    expect(xeroUtils.grantedScopesFrom({ access_token: 'not-a-jwt' })).toBeNull();
  });

  describe('Custom Connection credentials Xero refuses (invalid_client)', () => {
    beforeEach(() => {
      users.saveUserConfig(user.id, {
        XERO_CONNECTION_TYPE: 'custom', XERO_CLIENT_ID: 'cc-id', XERO_CLIENT_SECRET: 'cc-old-secret', XERO_OAUTH_REFRESH_TOKEN: '',
      });
    });

    test('are recorded and not retried until different credentials are saved', async () => {
      axios.post.mockRejectedValueOnce(oauthError('invalid_client'));
      const err = await connect.refreshClientCredentialsToken(user.id).catch(e => e);
      expect(err).toMatchObject({ needsReconnect: true, oauthError: 'invalid_client' });
      expect(reconnect.getConnectionStatus(user.id)).toMatchObject({
        method: 'custom', needsReconnect: true, connected: false, reason: expect.stringMatching(/client id or secret/i),
      });

      await expect(connect.refreshClientCredentialsToken(user.id)).rejects.toMatchObject({ needsReconnect: true });
      expect(axios.post).toHaveBeenCalledTimes(1);

      // A new secret saved in Setup: the old refusal no longer applies.
      users.saveUserConfig(user.id, { XERO_CLIENT_SECRET: 'cc-new-secret' });
      expect(reconnect.getConnectionStatus(user.id).needsReconnect).toBe(false);
      axios.post.mockResolvedValueOnce(tokenResponse());
      await connect.refreshClientCredentialsToken(user.id);
      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(tokenCache.getHealth(user.id).needsReconnect).toBe(false);
    });
  });

  test('xeroErrMsg explains a raw identity-server refusal too', () => {
    expect(xeroUtils.xeroErrMsg(oauthError('invalid_grant'))).toMatch(/reconnect xero in setup/i);
    expect(xeroUtils.xeroErrMsg(oauthError('invalid_client'))).toMatch(/client id or secret/i);
  });
});
