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
