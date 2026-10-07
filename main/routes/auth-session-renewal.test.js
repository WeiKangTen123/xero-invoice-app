const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// Sessions last 24 hours from the last request rather than seven days from the
// sign-in: tokens live a day, and requireAuth renews one that is an hour old
// in the X-Session-Token header. These pin both halves, and that renewal never
// reaches past a check a session has failed.
describe('24-hour sliding sessions', () => {
  let app, users, auth;
  const HOUR = 60 * 60;
  const DAY  = 24 * HOUR;
  const nowSec = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    auth  = require('../middleware/auth-middleware');
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
  });

  // A session token as the server issues them, made `ageSeconds` ago, so it
  // runs out 24 hours after that (or `lifetime` after, for the old 7-day ones).
  function tokenFor(u, ageSeconds = 0, { lifetime = DAY, ...extra } = {}) {
    return jwt.sign({ id: u.id, email: u.email, role: u.role, iat: nowSec() - ageSeconds, ...extra },
      auth.jwtSecret(), { expiresIn: lifetime });
  }
  const me = token => request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const renewal = res => res.headers['x-session-token'];

  test('the constants say what the change is: 24 hours, renewed after an hour, in X-Session-Token', () => {
    expect(auth.SESSION_TTL_SECONDS).toBe(DAY);
    expect(auth.SESSION_RENEW_AFTER_SECONDS).toBe(HOUR);
    expect(auth.SESSION_TOKEN_HEADER).toBe('X-Session-Token');
  });

  describe('every token issued at sign-in lasts 24 hours', () => {
    const lifetimeOf = token => { const c = jwt.decode(token); return c.exp - c.iat; };

    test('register and login', async () => {
      const reg = await request(serverFor(app)).post('/api/auth/register')
        .send({ email: 'first@test.com', password: 'password123' }).expect(201);
      expect(lifetimeOf(reg.body.token)).toBe(DAY);
      const login = await request(serverFor(app)).post('/api/auth/login')
        .send({ email: 'first@test.com', password: 'password123' }).expect(200);
      expect(lifetimeOf(login.body.token)).toBe(DAY);
      expect(jwt.decode(login.body.token)).toMatchObject({ id: reg.body.user.id, email: 'first@test.com', role: 'admin' });
      expect(jwt.decode(login.body.token).renewed).toBeUndefined();
    });

    test('change-password, whose response carries no renewal even when the token sent was due one', async () => {
      // The renewal requireAuth made predates the cutoff the change moves, so
      // it is dead on arrival; the token in the body is the session's.
      const u = await users.createUser('cp@test.com', 'password123', 'user');
      const res = await request(serverFor(app)).post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tokenFor(u, 2 * HOUR)}`)
        .send({ currentPassword: 'password123', newPassword: 'newpassword1' }).expect(200);
      expect(lifetimeOf(res.body.token)).toBe(DAY);
      expect(renewal(res)).toBeUndefined();
      await me(res.body.token).expect(200);
    });
  });

  describe('renewal', () => {
    test('a token over an hour old comes back renewed: same account, later end, and it works', async () => {
      const u = await users.createUser('slide@test.com', 'password123', 'user');
      const old = tokenFor(u, 2 * HOUR);
      const res = await me(old).expect(200);
      const fresh = renewal(res);
      expect(fresh).toBeTruthy();
      const before = jwt.decode(old), after = jwt.verify(fresh, auth.jwtSecret());
      expect(after).toMatchObject({ id: u.id, email: u.email, role: u.role, renewed: true });
      expect(after.exp).toBeGreaterThan(before.exp);
      expect(after.exp - after.iat).toBe(DAY);
      const again = await me(fresh).expect(200);
      expect(renewal(again)).toBeUndefined();   // fresh now, so nothing more until it is an hour old
    });

    test('a token under an hour old gets none', async () => {
      const u = await users.createUser('fresh@test.com', 'password123', 'user');
      expect(renewal(await me(tokenFor(u)).expect(200))).toBeUndefined();
      expect(renewal(await me(tokenFor(u, HOUR - 60)).expect(200))).toBeUndefined();
    });

    test('renewing leaves the old token good and the sign-out cutoff where it was', async () => {
      // Requests already in flight with the old token must still succeed.
      const u = await users.createUser('keep@test.com', 'password123', 'user');
      const cutoff = users.findById(u.id).sessions_valid_from;
      const old = tokenFor(u, 3 * HOUR);
      expect(renewal(await me(old).expect(200))).toBeTruthy();
      expect(users.findById(u.id).sessions_valid_from).toBe(cutoff);
      await me(old).expect(200);
    });

    test('a 7-day token from before this change keeps its own end, and is renewed in its final day', async () => {
      // Offering it a 24-hour token sooner would be a shorter session the
      // browser discards (it keeps the token that runs out last).
      const u = await users.createUser('legacy@test.com', 'password123', 'user');
      expect(renewal(await me(tokenFor(u, 2 * DAY, { lifetime: 7 * DAY })).expect(200))).toBeUndefined();
      const lastDay = await me(tokenFor(u, 6 * DAY + HOUR, { lifetime: 7 * DAY })).expect(200);
      expect(jwt.decode(renewal(lastDay)).exp - nowSec()).toBeGreaterThan(DAY - 60);
    });

    test('the role in a renewal is the one in the database, not the one in the old token', async () => {
      const u = await users.createUser('demoted@test.com', 'password123', 'user');
      const res = await me(tokenFor({ ...u, role: 'admin' }, 2 * HOUR)).expect(200);
      expect(jwt.decode(renewal(res)).role).toBe('user');
    });
  });

  describe('a session that fails a check gets a 401 and no renewal', () => {
    test('a disabled account', async () => {
      const u = await users.createUser('off@test.com', 'password123', 'user');
      const old = tokenFor(u, 2 * HOUR);
      users.setDisabled(u.id, true);
      const res = await me(old).expect(401);
      expect(renewal(res)).toBeUndefined();
    });

    test('a token from before the sign-out cutoff', async () => {
      const u = await users.createUser('cut@test.com', 'password123', 'user');
      const old = tokenFor(u, 2 * HOUR);
      users.invalidateSessions(u.id);
      const res = await me(old).expect(401);
      expect(res.body.error).toMatch(/signed out/i);
      expect(renewal(res)).toBeUndefined();
    });

    test('a deleted account', async () => {
      const u = await users.createUser('gone@test.com', 'password123', 'user');
      const old = tokenFor(u, 2 * HOUR);
      users.deleteUser(u.id);
      expect(renewal(await me(old).expect(401))).toBeUndefined();
    });

    test('an expired token, refused with a plain message', async () => {
      const u = await users.createUser('away@test.com', 'password123', 'user');
      const res = await me(tokenFor(u, DAY + 60)).expect(401);
      expect(res.body.error).toBe('Your session ended after 24 hours away. Sign in again.');
      expect(renewal(res)).toBeUndefined();
      // A token that is wrong rather than old keeps the generic wording.
      const forged = await me(jwt.sign({ id: u.id }, 'not-the-secret')).expect(401);
      expect(forged.body.error).toBe('Invalid or expired token');
    });
  });

  describe('revocation still reaches renewed tokens', () => {
    test('a later "sign out everywhere" refuses a renewal made before it', async () => {
      const u = await users.createUser('revoke@test.com', 'password123', 'user');
      const fresh = renewal(await me(tokenFor(u, 2 * HOUR)).expect(200));
      await me(fresh).expect(200);
      // Backdated a few seconds so the cutoff is plainly after it.
      const renewedEarlier = tokenFor(u, 5, { renewed: true });
      users.invalidateSessions(u.id);
      await me(renewedEarlier).expect(401);
    });

    test("a renewal stamped with the cutoff's own second is refused; a sign-in from that second is not", async () => {
      // A renewal needs a token an hour old that passed the cutoff, so one made
      // in the cutoff's second was made before it, for the session the cutoff
      // ended. A sign-in straight after a reset lands in that second too, and
      // must still work.
      const u = await users.createUser('samesec@test.com', 'password123', 'user');
      const second = Math.floor(Date.parse(users.invalidateSessions(u.id)) / 1000);
      const sign = extra => jwt.sign({ id: u.id, email: u.email, role: u.role, iat: second, ...extra },
        auth.jwtSecret(), { expiresIn: DAY });
      await me(sign({ renewed: true })).expect(401);
      await me(sign({})).expect(200);
    });
  });
});
