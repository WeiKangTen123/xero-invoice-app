const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/auth', () => {
  let app, users, jwtSecret;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    const authRoutes = require('./auth');

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
  });

  function tokenFor(user) {
    return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  }

  describe('GET /me', () => {
    test('defaults timezone to Asia/Singapore when the user has never set one', async () => {
      const u = await users.createUser('notz@test.com', 'password123', 'user');
      const res = await request(serverFor(app))
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenFor(u)}`)
        .expect(200);
      expect(res.body.user.timezone).toBe('Asia/Singapore');
    });

    test('returns the user-configured timezone once set', async () => {
      const u = await users.createUser('withtz@test.com', 'password123', 'user');
      users.saveUserConfig(u.id, { TIMEZONE: 'America/New_York' });
      const res = await request(serverFor(app))
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenFor(u)}`)
        .expect(200);
      expect(res.body.user.timezone).toBe('America/New_York');
    });
  });

  // Proves the requireAuth -> touchLastSeen wiring actually works end to end
  // (not just that touchLastSeen itself works in isolation, which utils/users.test.js
  // already covers) — a real authenticated request through a real route.
  test('any authenticated request updates last_seen_at, independent of which route', async () => {
    const u = await users.createUser('presence@test.com', 'password123', 'user');
    expect(users.findById(u.id).last_seen_at).toBeFalsy();

    await request(serverFor(app))
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenFor(u)}`)
      .expect(200);

    const after = users.findById(u.id);
    expect(after.last_seen_at).toBeTruthy();
    expect(users.isOnline(after.last_seen_at)).toBe(true);
  });

  test("a deleted user's token is refused, however long it has left", async () => {
    // Role and existence come from the database on every request; a 7-day
    // token must not outlive a deletion.
    const u = await users.createUser('gone@test.com', 'password123', 'user');
    const token = tokenFor(u);
    users.deleteUser(u.id);
    await request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
  });

  test('an invalid token does not touch last_seen_at and is rejected', async () => {
    const u = await users.createUser('badtoken@test.com', 'password123', 'user');
    await request(serverFor(app))
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
    expect(users.findById(u.id).last_seen_at).toBeFalsy();
  });

  describe('POST /register security controls', () => {
    test('enforces minimum 8 character password', async () => {
      const res = await request(serverFor(app))
        .post('/api/auth/register')
        .send({ email: 'short@test.com', password: 'short' })
        .expect(400);
      expect(res.body.error).toMatch(/at least 8 characters/);
    });

    test('the very first account can always be created, and becomes admin', async () => {
      const res = await request(serverFor(app))
        .post('/api/auth/register')
        .send({ email: 'first@test.com', password: 'password123' })
        .expect(201);
      expect(res.body.user.role).toBe('admin');
    });

    test('once a user exists, registration is closed unless ALLOW_REGISTRATION=true', async () => {
      // The public URL used to accept anyone: the flag was opt-OUT and
      // undocumented. After the first account, admins add users on the Admin page.
      await users.createUser('existing@test.com', 'password123', 'admin');
      const prevEnv = process.env.ALLOW_REGISTRATION;
      try {
        delete process.env.ALLOW_REGISTRATION;
        const res = await request(serverFor(app))
          .post('/api/auth/register')
          .send({ email: 'stranger@test.com', password: 'password123' })
          .expect(403);
        expect(res.body.error).toMatch(/registration is disabled/i);

        process.env.ALLOW_REGISTRATION = 'true';
        await request(serverFor(app))
          .post('/api/auth/register')
          .send({ email: 'stranger@test.com', password: 'password123' })
          .expect(201);
      } finally {
        if (prevEnv === undefined) delete process.env.ALLOW_REGISTRATION; else process.env.ALLOW_REGISTRATION = prevEnv;
      }
    });
  });
});

// ── Password change, session cutoff and disabled accounts ───────────────────
describe('routes/auth password and account state', () => {
  let app, users, jwtSecret;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
  });

  // See admin.test.js: a token that must be refused is minted a little in the past.
  function tokenFor(user, secondsAgo = 0) {
    const iat = Math.floor(Date.now() / 1000) - secondsAgo;
    return jwt.sign({ id: user.id, email: user.email, role: user.role, iat }, jwtSecret());
  }
  const login  = (email, password) => request(serverFor(app)).post('/api/auth/login').send({ email, password });
  const me     = token => request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const change = (token, body) => request(serverFor(app)).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send(body);

  describe('POST /change-password', () => {
    test('needs the current password, both fields and at least 8 characters', async () => {
      const u = await users.createUser('cp@test.com', 'password123', 'user');
      const t = tokenFor(u);
      // A wrong current password is a 400, not a 401: a 401 would bounce the
      // browser to the login page.
      const wrong = await change(t, { currentPassword: 'wrong', newPassword: 'newpassword1' }).expect(400);
      expect(wrong.body.error).toMatch(/current password/i);
      await change(t, { currentPassword: 'password123', newPassword: 'short' }).expect(400);
      await change(t, { newPassword: 'newpassword1' }).expect(400);
      await change(t, { currentPassword: 'password123' }).expect(400);
      await login('cp@test.com', 'password123').expect(200);
    });

    test('changes the password, keeps this session via the returned token and signs out the others', async () => {
      const u = await users.createUser('cp@test.com', 'password123', 'user');
      const stale = tokenFor(u, 5);
      const res = await change(stale, { currentPassword: 'password123', newPassword: 'newpassword1' }).expect(200);
      expect(res.body.token).toBeTruthy();
      await me(stale).expect(401);
      await me(res.body.token).expect(200);
      await login('cp@test.com', 'password123').expect(401);
      await login('cp@test.com', 'newpassword1').expect(200);
    });
  });

  test('POST /login refuses a disabled account, and only once the password is right', async () => {
    const u = await users.createUser('off@test.com', 'password123', 'user');
    users.setDisabled(u.id, true);
    const res = await login('off@test.com', 'password123').expect(403);
    expect(res.body.error).toMatch(/disabled/);
    await login('off@test.com', 'nope').expect(401);
    users.setDisabled(u.id, false);
    await login('off@test.com', 'password123').expect(200);
  });

  test('requireAuth refuses a token minted before the cutoff and accepts one from the cutoff\'s own second', async () => {
    const u = await users.createUser('cut@test.com', 'password123', 'user');
    const stale = tokenFor(u, 5);
    await me(stale).expect(200);
    const at = users.invalidateSessions(u.id);
    // Signing straight back in after a reset lands in the same second as the
    // cutoff; iat has no sub-second precision, so that token must be accepted.
    const sameSecond = jwt.sign({ id: u.id, email: u.email, role: u.role, iat: Math.floor(Date.parse(at) / 1000) }, jwtSecret());
    await me(stale).expect(401);
    await me(sameSecond).expect(200);
  });
});
