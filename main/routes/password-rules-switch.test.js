// The forced change of a password the rules now refuse is behind a switch
// (users.js rulesChangeRequired, PASSWORD_RULES_AT_SIGNIN): off on every
// server since 2026-10-23, on under the test suite. Off, signing in with such
// a password marks nothing, a mark already on an account asks nothing, and a
// temporary password is still asked for. Real routes, users and database.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('users.rulesChangeRequired', () => {
  const { rulesChangeRequired } = require('../utils/users');

  test('true or 1 turns it on, false or 0 off', () => {
    for (const v of ['true', 'TRUE', ' 1 ']) expect(rulesChangeRequired({ PASSWORD_RULES_AT_SIGNIN: v, NODE_ENV: 'production' })).toBe(true);
    for (const v of ['false', '0']) expect(rulesChangeRequired({ PASSWORD_RULES_AT_SIGNIN: v, NODE_ENV: 'test' })).toBe(false);
  });

  test('unset, it is off on a server and on under the test suite', () => {
    expect(rulesChangeRequired({ NODE_ENV: 'production' })).toBe(false);
    expect(rulesChangeRequired({})).toBe(false);
    expect(rulesChangeRequired({ NODE_ENV: 'test' })).toBe(true);
  });
});

describe('routes/auth and the gate — the rules switch', () => {
  let app, users, jwtSecret, saved;
  const SHORT = 'kq7zp4mx1w';   // ten characters: the rules want twelve

  beforeEach(() => {
    saved = process.env.PASSWORD_RULES_AT_SIGNIN;
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    const { requireAuth } = require('../middleware/auth-middleware');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
    app.get('/api/anything', requireAuth, (req, res) => res.json({ ok: true }));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.PASSWORD_RULES_AT_SIGNIN;
    else process.env.PASSWORD_RULES_AT_SIGNIN = saved;
  });

  const tokenFor = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  const signIn = email => request(serverFor(app)).post('/api/auth/login').send({ email, password: SHORT });
  const me     = user => request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor(user)}`);
  const page   = user => request(serverFor(app)).get('/api/anything').set('Authorization', `Bearer ${tokenFor(user)}`);

  test('off: a password the rules refuse signs in and opens everything, and marks nothing', async () => {
    process.env.PASSWORD_RULES_AT_SIGNIN = 'false';
    const u = await users.createUser('short@test.com', SHORT, 'user');
    const res = await signIn('short@test.com');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ mustChangePassword: false, passwordChangeReason: null });
    expect(users.findById(u.id).must_change_password).toBe(0);
    expect((await page(u)).status).toBe(200);
  });

  test('off: an account already marked asks nothing; on again, it asks again', async () => {
    const u = await users.createUser('marked@test.com', SHORT, 'user');
    users.requirePasswordChange(u.id);

    process.env.PASSWORD_RULES_AT_SIGNIN = 'false';
    expect((await me(u)).body.user).toMatchObject({ mustChangePassword: false, passwordChangeReason: null });
    expect((await page(u)).status).toBe(200);
    const res = await signIn('marked@test.com');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ mustChangePassword: false, passwordChangeReason: null });
    expect(users.getAllUsers().find(x => x.id === u.id)).toMatchObject({ mustChangePassword: false });

    process.env.PASSWORD_RULES_AT_SIGNIN = 'true';
    expect((await me(u)).body.user).toMatchObject({ mustChangePassword: true, passwordChangeReason: 'rules' });
    const gated = await page(u);
    expect(gated.status).toBe(403);
    expect(gated.body.code).toBe('password_change_required');
  });

  test('off: a temporary password is still asked for', async () => {
    process.env.PASSWORD_RULES_AT_SIGNIN = 'false';
    const u = await users.createUser('temp@test.com', 'a-temporary-pass-1', 'user', { temporary: true });
    expect((await me(u)).body.user).toMatchObject({ mustChangePassword: true, passwordChangeReason: 'temporary' });
    expect((await page(u)).status).toBe(403);
  });

  test('on: signing in with a password the rules refuse marks the account, as before', async () => {
    process.env.PASSWORD_RULES_AT_SIGNIN = 'true';
    const u = await users.createUser('strict@test.com', SHORT, 'user');
    const res = await signIn('strict@test.com');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ mustChangePassword: true, passwordChangeReason: 'rules' });
    expect(users.findById(u.id).must_change_password).toBe(1);
  });
});
