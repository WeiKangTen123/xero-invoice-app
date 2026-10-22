// The client learns an account is a demo one from the sign-in response and
// from GET /api/auth/me, and from nowhere else. Real routes, users and
// database.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/auth — the demo flag', () => {
  let app, users, jwtSecret, demo, real;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
    demo = await users.createUser('demo@test.com', 'password1234', 'user', { demo: true });
    real = await users.createUser('real@test.com', 'password1234', 'user');
  });

  const tokenFor = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());

  test('the sign-in response says which it is', async () => {
    const signIn = email => request(serverFor(app)).post('/api/auth/login').send({ email, password: 'password1234' }).expect(200);
    expect((await signIn('demo@test.com')).body.user).toMatchObject({ id: demo.id, demo: true });
    expect((await signIn('real@test.com')).body.user).toMatchObject({ id: real.id, demo: false });
  });

  test('GET /me says which it is, from the account row and not the token', async () => {
    const me = user => request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor(user)}`).expect(200);
    expect((await me(demo)).body.user).toMatchObject({ id: demo.id, demo: true, timezone: 'Asia/Singapore' });
    expect((await me(real)).body.user).toMatchObject({ id: real.id, demo: false });
  });

  // Demo accounts were once allowed a six-character password; no account is now.
  test('change-password holds a demo account to the full rule, admin or not', async () => {
    const change = user => request(serverFor(app)).post('/api/auth/change-password')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ currentPassword: 'password1234', newPassword: 'kq7zp4' });
    const admin = await users.createUser('boss@test.com', 'password1234', 'admin');
    users.setDemo(admin.id, true);
    for (const user of [demo, admin]) {
      const res = await change(user);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Password must be at least 12 characters');
    }
  });

  // A demo account from before that, still on its short password, signs in
  // with it and is then asked for a new one, with nothing else open.
  test('a demo account signing in with a short password must choose a new one', async () => {
    const old = await users.createUser('old.demo@test.com', 'kq7zp4', 'user', { demo: true });
    const res = await request(serverFor(app)).post('/api/auth/login').send({ email: 'old.demo@test.com', password: 'kq7zp4' }).expect(200);
    expect(res.body.user).toMatchObject({ demo: true, mustChangePassword: true, passwordChangeReason: 'rules' });
    expect(users.findById(old.id)).toMatchObject({ must_change_password: 1, temp_password_expires_at: null });
  });

  test('registration makes a real account', async () => {
    process.env.ALLOW_REGISTRATION = 'true';
    try {
      const res = await request(serverFor(app)).post('/api/auth/register')
        .send({ email: 'new@test.com', password: 'a-long-enough-password' }).expect(201);
      expect(res.body.user.demo).toBe(false);
    } finally {
      delete process.env.ALLOW_REGISTRATION;
    }
  });
});
