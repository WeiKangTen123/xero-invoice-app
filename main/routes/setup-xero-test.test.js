// POST /api/setup/test/xero tests the method that is active and leaves it
// active. It used to run Custom Connection only and set the type to 'custom'
// on success, so an OAuth user pressing Test was moved off OAuth.
// Real route, users and database; only axios is replaced.
jest.mock('axios');

const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/setup — POST /test/xero', () => {
  let app, users, axios, jwtSecret, user;
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
    app.use('/api/setup', require('./setup'));
    user = await users.createUser('t@test.com', 'password123', 'user');
    axios.post.mockResolvedValue({ data: { access_token: 'at', refresh_token: 'rt-2', expires_in: 1800 } });
    axios.get.mockResolvedValue({ data: [{ tenantId: 't-1', tenantName: 'Org One' }] });
  });

  afterEach(() => { process.env = { ...originalEnv }; });

  const auth = () => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;
  const test_ = () => request(serverFor(app)).post('/api/setup/test/xero').set('Authorization', auth());
  const grants = () => axios.post.mock.calls.map(([, body]) => body.get('grant_type'));

  test('an OAuth user is tested over OAuth and stays on OAuth, even with Custom Connection credentials saved', async () => {
    users.saveUserConfig(user.id, {
      XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret', XERO_OAUTH_REFRESH_TOKEN: 'rt-1',
      XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs',
    });

    const res = await test_().expect(200);

    expect(res.body).toMatchObject({ success: true, message: expect.stringMatching(/oauth/i) });
    expect(grants()).toEqual(['refresh_token']);
    expect(users.getUserConfig(user.id).XERO_CONNECTION_TYPE).toBe('oauth');
    expect(users.getUserConfig(user.id).XERO_OAUTH_REFRESH_TOKEN).toBe('rt-2');
  });

  test('a Custom Connection user is tested over Custom Connection', async () => {
    users.saveUserConfig(user.id, { XERO_CONNECTION_TYPE: 'custom', XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs' });
    const res = await test_().expect(200);
    expect(res.body).toMatchObject({ success: true, message: expect.stringMatching(/custom connection/i) });
    expect(grants()).toEqual(['client_credentials']);
    expect(users.getUserConfig(user.id).XERO_CONNECTION_TYPE).toBe('custom');
  });

  test('with no method recorded, a passing Custom Connection test records it', async () => {
    users.saveUserConfig(user.id, { XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs' });
    await test_().expect(200);
    expect(grants()).toEqual(['client_credentials']);
    expect(users.getUserConfig(user.id).XERO_CONNECTION_TYPE).toBe('custom');
  });

  test('a failed OAuth test says what to do and leaves the method alone', async () => {
    users.saveUserConfig(user.id, {
      XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret', XERO_OAUTH_REFRESH_TOKEN: 'rt-dead',
      XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs',
    });
    axios.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { error: 'invalid_grant' } },
    }));

    const res = await test_().expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/reconnect xero in setup/i);
    expect(users.getUserConfig(user.id).XERO_CONNECTION_TYPE).toBe('oauth');
    expect(grants()).toEqual(['refresh_token']);
  });

  test('pressing Test asks Xero again even after a recorded refusal', async () => {
    users.saveUserConfig(user.id, {
      XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret', XERO_OAUTH_REFRESH_TOKEN: 'rt-1',
    });
    axios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { error: 'invalid_grant' } },
    }));
    await test_().expect(400);
    await test_().expect(200);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});
