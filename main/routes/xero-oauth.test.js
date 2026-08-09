const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

jest.mock('../xero/oauth');
jest.mock('../utils/oauth-state');
jest.mock('../utils/token-cache');

describe('routes/xero-oauth', () => {
  let app, users, jwtSecret, testUser, xeroOAuth, oauthState, tokenCache;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    xeroOAuth  = require('../xero/oauth');
    oauthState = require('../utils/oauth-state');
    tokenCache = require('../utils/token-cache');
    const xeroOAuthRoutes = require('./xero-oauth');

    testUser = await users.createUser('user@test.com', 'password123', 'user');

    app = express();
    app.use(express.json());
    app.use('/api/xero', xeroOAuthRoutes);
  });

  function tokenFor(user) {
    return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  }

  describe('GET /oauth/connect', () => {
    test('requires authentication', async () => {
      await request(app).get('/api/xero/oauth/connect').expect(401);
    });

    test('returns the authorize URL from xero/oauth', async () => {
      xeroOAuth.buildAuthorizeUrl.mockReturnValue('https://login.xero.com/identity/connect/authorize?state=abc');
      const res = await request(app)
        .get('/api/xero/oauth/connect')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);
      expect(res.body.url).toContain('login.xero.com');
      expect(xeroOAuth.buildAuthorizeUrl).toHaveBeenCalledWith(testUser.id);
    });

    test('surfaces a config error as 400, not a 500 crash', async () => {
      xeroOAuth.buildAuthorizeUrl.mockImplementation(() => { throw new Error('Xero OAuth is not configured'); });
      const res = await request(app)
        .get('/api/xero/oauth/connect')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(400);
      expect(res.body.error).toMatch(/not configured/i);
    });
  });

  describe('GET /oauth/callback', () => {
    // This route must NEVER complete the connection itself — it has no way to
    // verify the browser sitting here is the same one that started the flow
    // (no cookies/sessions in this app). It only forwards code+state to the SPA,
    // which completes the connection via an authenticated call. See
    // POST /oauth/complete below for the actual security boundary.
    test('redirects with an error flag when Xero reports a consent error, without touching state', async () => {
      const res = await request(app).get('/api/xero/oauth/callback?error=access_denied');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('xero_oauth=error');
      expect(oauthState.consume).not.toHaveBeenCalled();
    });

    test('redirects with an error flag when code or state is missing', async () => {
      const res = await request(app).get('/api/xero/oauth/callback?code=abc');
      expect(res.headers.location).toContain('xero_oauth=error');
      expect(xeroOAuth.completeConnection).not.toHaveBeenCalled();
    });

    test('never calls completeConnection itself — only forwards code+state pending', async () => {
      const res = await request(app).get('/api/xero/oauth/callback?code=the-code&state=some-state');
      expect(xeroOAuth.completeConnection).not.toHaveBeenCalled();
      expect(oauthState.consume).not.toHaveBeenCalled();
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('xero_oauth=pending');
      expect(res.headers.location).toContain('code=the-code');
      expect(res.headers.location).toContain('state=some-state');
    });

    test('does not require an Authorization header at all (browser redirect has none)', async () => {
      // Deliberately no .set('Authorization', ...) here.
      const res = await request(app).get('/api/xero/oauth/callback?code=c&state=s');
      expect(res.status).toBe(302);
    });
  });

  describe('POST /oauth/complete', () => {
    test('requires authentication', async () => {
      await request(app).post('/api/xero/oauth/complete').send({ code: 'c', state: 's' }).expect(401);
    });

    test('rejects when code or state is missing', async () => {
      const res = await request(app)
        .post('/api/xero/oauth/complete')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .send({ code: 'c' })
        .expect(400);
      expect(res.body.error).toMatch(/missing/i);
    });

    test('rejects when state is missing/invalid/expired', async () => {
      oauthState.consume.mockReturnValue(null);
      const res = await request(app)
        .post('/api/xero/oauth/complete')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .send({ code: 'c', state: 'bogus' })
        .expect(400);
      expect(xeroOAuth.completeConnection).not.toHaveBeenCalled();
      expect(res.body.error).toMatch(/invalid or expired/i);
    });

    // The actual security fix: a state minted for one user must not be completable
    // by a different, currently-authenticated user — this is what prevents an
    // attacker from harvesting their own connect link, handing it to a victim, and
    // having the victim's Xero org linked to the attacker's account instead.
    test('rejects when the authenticated caller is not who the state was minted for', async () => {
      const otherUser = await users.createUser('other@test.com', 'password123', 'user');
      oauthState.consume.mockReturnValue(otherUser.id); // state belongs to a DIFFERENT user
      const res = await request(app)
        .post('/api/xero/oauth/complete')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`) // caller is testUser, not otherUser
        .send({ code: 'the-code', state: 'attacker-harvested-state' })
        .expect(400);
      expect(xeroOAuth.completeConnection).not.toHaveBeenCalled();
      expect(res.body.error).toMatch(/invalid or expired/i);
    });

    test('completes the connection when the caller matches who started it', async () => {
      oauthState.consume.mockReturnValue(testUser.id);
      xeroOAuth.completeConnection.mockResolvedValue([{ tenantId: 't1', tenantName: 'Org' }]);

      const res = await request(app)
        .post('/api/xero/oauth/complete')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .send({ code: 'the-code', state: 'valid-state' })
        .expect(200);

      expect(xeroOAuth.completeConnection).toHaveBeenCalledWith(testUser.id, 'the-code');
      expect(res.body).toEqual({ success: true });
    });

    test('surfaces a completeConnection failure as 400, not a 500 crash', async () => {
      oauthState.consume.mockReturnValue(testUser.id);
      xeroOAuth.completeConnection.mockRejectedValue(new Error('Xero rejected the code'));

      const res = await request(app)
        .post('/api/xero/oauth/complete')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .send({ code: 'bad-code', state: 'valid-state' })
        .expect(400);

      expect(res.body.error).toMatch(/rejected/i);
    });
  });

  describe('DELETE /oauth/disconnect', () => {
    test('requires authentication', async () => {
      await request(app).delete('/api/xero/oauth/disconnect').expect(401);
    });

    test('removes every cached tenant and clears the stored OAuth config', async () => {
      const removeTenant = jest.fn();
      tokenCache.forUser.mockReturnValue({
        getAllTenants: () => [{ tenant_id: 't1' }, { tenant_id: 't2' }],
        removeTenant,
      });

      const res = await request(app)
        .delete('/api/xero/oauth/disconnect')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(res.body).toEqual({ success: true });
      expect(removeTenant).toHaveBeenCalledWith('t1');
      expect(removeTenant).toHaveBeenCalledWith('t2');
      expect(users.getUserConfig(testUser.id).XERO_CONNECTION_TYPE).toBeUndefined();
    });
  });

  describe('GET /tenants', () => {
    test('requires authentication', async () => {
      await request(app).get('/api/xero/tenants').expect(401);
    });

    test('defaults connectionType to "custom" when nothing is set yet', async () => {
      tokenCache.getPersistedTenants.mockReturnValue([]);
      const res = await request(app)
        .get('/api/xero/tenants')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);
      expect(res.body).toEqual({ connectionType: 'custom', tenants: [] });
    });

    test('reflects an active oauth connection and its tenant list', async () => {
      users.saveUserConfig(testUser.id, { XERO_CONNECTION_TYPE: 'oauth' });
      tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't1', tenantName: 'Org One' }]);

      const res = await request(app)
        .get('/api/xero/tenants')
        .set('Authorization', `Bearer ${tokenFor(testUser)}`)
        .expect(200);

      expect(res.body.connectionType).toBe('oauth');
      expect(res.body.tenants).toEqual([{ tenantId: 't1', tenantName: 'Org One' }]);
    });
  });
});
