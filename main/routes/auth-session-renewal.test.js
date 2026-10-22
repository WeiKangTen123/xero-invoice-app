const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// Sessions last two hours from the last request, and never more than twelve
// from the sign-in: tokens live two hours, requireAuth renews one that is a
// quarter of an hour old in the X-Session-Token header but never past the
// session's twelfth hour, and a token whose session began longer ago than
// that is refused. These pin each part, and that renewal never reaches past a
// check a session has failed.
describe('two-hour sliding sessions, twelve hours at most', () => {
  let app, db, users, sessions, auth;
  const MIN  = 60;
  const HOUR = 60 * MIN;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    db       = require('../db');
    users    = require('../utils/users');
    sessions = require('../utils/sessions');
    auth     = require('../middleware/auth-middleware');
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  // A session as a sign-in starts one, begun `startedAgo` seconds ago.
  function sessionOf(u, startedAgo = 0) {
    const sid = sessions.startSession(u.id);
    const at  = new Date(Date.now() - startedAgo * 1000).toISOString();
    db.prepare('UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE id = ?').run(at, at, sid);
    return sid;
  }
  // A token of that session made `ageSeconds` ago, running out `lifetime`
  // after that: two hours, as the server issues them, unless said otherwise.
  function tokenFor(u, ageSeconds = 0, { sid = sessionOf(u, ageSeconds), lifetime = 2 * HOUR, ...extra } = {}) {
    return jwt.sign({ id: u.id, email: u.email, role: u.role, sid, iat: nowSec() - ageSeconds, ...extra },
      auth.jwtSecret(), { expiresIn: lifetime });
  }
  const me = token => request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const renewal = res => res.headers['x-session-token'];
  const lifetimeOf = token => { const c = jwt.decode(token); return c.exp - c.iat; };

  test('the constants say what the change is: two hours, at most twelve, renewed after a quarter hour, in X-Session-Token', () => {
    expect(auth.SESSION_TTL_SECONDS).toBe(2 * HOUR);
    expect(auth.SESSION_MAX_AGE_SECONDS).toBe(12 * HOUR);
    expect(auth.SESSION_RENEW_AFTER_SECONDS).toBe(15 * MIN);
    expect(auth.SESSION_TOKEN_HEADER).toBe('X-Session-Token');
  });

  describe('every token issued at sign-in lasts two hours', () => {
    test('register and login', async () => {
      const reg = await request(serverFor(app)).post('/api/auth/register')
        .send({ email: 'first@test.com', password: 'first-admin-pass-1' }).expect(201);
      expect(lifetimeOf(reg.body.token)).toBe(2 * HOUR);
      const login = await request(serverFor(app)).post('/api/auth/login')
        .send({ email: 'first@test.com', password: 'first-admin-pass-1' }).expect(200);
      expect(lifetimeOf(login.body.token)).toBe(2 * HOUR);
      expect(jwt.decode(login.body.token)).toMatchObject({ id: reg.body.user.id, email: 'first@test.com', role: 'admin', sid: expect.any(String) });
      expect(jwt.decode(login.body.token).renewed).toBeUndefined();
    });

    test('change-password, whose response carries no renewal even when the token sent was due one', async () => {
      // The renewal requireAuth made predates the cutoff the change moves, so
      // it is dead on arrival; the token in the body is the session's.
      const u = await users.createUser('cp@test.com', 'password123', 'user');
      const res = await request(serverFor(app)).post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tokenFor(u, HOUR)}`)
        .send({ currentPassword: 'password123', newPassword: 'new-password-2026' }).expect(200);
      expect(lifetimeOf(res.body.token)).toBe(2 * HOUR);
      expect(renewal(res)).toBeUndefined();
      await me(res.body.token).expect(200);
    });

    test("the token a password change hands back in a session's eleventh hour ends with the session", async () => {
      const u = await users.createUser('late@test.com', 'password123', 'user');
      const sid = sessionOf(u, 11 * HOUR);
      const res = await request(serverFor(app)).post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tokenFor(u, 10 * MIN, { sid })}`)
        .send({ currentPassword: 'password123', newPassword: 'new-password-2026' }).expect(200);
      const { exp } = jwt.decode(res.body.token);
      expect(Math.abs(exp - (nowSec() + HOUR))).toBeLessThanOrEqual(2);
      await me(res.body.token).expect(200);
    });
  });

  describe('renewal', () => {
    test('a token over a quarter hour old comes back renewed: same account and session, later end, and it works', async () => {
      const u = await users.createUser('slide@test.com', 'password123', 'user');
      const old = tokenFor(u, 20 * MIN);
      const res = await me(old).expect(200);
      const fresh = renewal(res);
      expect(fresh).toBeTruthy();
      const before = jwt.decode(old), after = jwt.verify(fresh, auth.jwtSecret());
      expect(after).toMatchObject({ id: u.id, email: u.email, role: u.role, sid: before.sid, renewed: true });
      expect(after.exp).toBeGreaterThan(before.exp);
      expect(after.exp - after.iat).toBe(2 * HOUR);
      const again = await me(fresh).expect(200);
      expect(renewal(again)).toBeUndefined();   // fresh now, so nothing more until it is a quarter hour old
    });

    test('a token under a quarter hour old gets none', async () => {
      const u = await users.createUser('fresh@test.com', 'password123', 'user');
      expect(renewal(await me(tokenFor(u)).expect(200))).toBeUndefined();
      expect(renewal(await me(tokenFor(u, 14 * MIN)).expect(200))).toBeUndefined();
    });

    test('renewing leaves the old token good and the sign-out cutoff where it was', async () => {
      // Requests already in flight with the old token must still succeed.
      const u = await users.createUser('keep@test.com', 'password123', 'user');
      const cutoff = users.findById(u.id).sessions_valid_from;
      const old = tokenFor(u, HOUR);
      expect(renewal(await me(old).expect(200))).toBeTruthy();
      expect(users.findById(u.id).sessions_valid_from).toBe(cutoff);
      await me(old).expect(200);
    });

    test("in a session's last two hours a renewal ends at its twelfth hour, and none is offered once nothing later can be", async () => {
      const u = await users.createUser('dusk@test.com', 'password123', 'user');
      const sid = sessionOf(u, 10 * HOUR + 45 * MIN);   // ends in 75 minutes
      const res = await me(tokenFor(u, HOUR, { sid })).expect(200);     // this token ends in an hour
      const renewed = jwt.decode(renewal(res));
      expect(Math.abs(renewed.exp - (nowSec() + 75 * MIN))).toBeLessThanOrEqual(2);
      expect(renewed.exp - renewed.iat).toBeLessThan(2 * HOUR);
      // A token that already runs to the session's end is offered nothing.
      expect(renewal(await me(tokenFor(u, 20 * MIN, { sid, lifetime: 95 * MIN })).expect(200))).toBeUndefined();
    });

    test('a 24-hour token from before this change keeps its own end, and is refused at its twelfth hour all the same', async () => {
      // Offering it a two-hour token would be a shorter session the browser
      // discards (it keeps the token that runs out last).
      const u = await users.createUser('legacy@test.com', 'password123', 'user');
      expect(renewal(await me(tokenFor(u, HOUR, { lifetime: 24 * HOUR })).expect(200))).toBeUndefined();
      const res = await me(tokenFor(u, 12 * HOUR + MIN, { lifetime: 24 * HOUR })).expect(401);
      expect(res.body.error).toBe('Your session ended 12 hours after you signed in. Sign in again.');
    });

    test('the role in a renewal is the one in the database, not the one in the old token', async () => {
      const u = await users.createUser('demoted@test.com', 'password123', 'user');
      const res = await me(tokenFor({ ...u, role: 'admin' }, HOUR)).expect(200);
      expect(jwt.decode(renewal(res)).role).toBe('user');
    });
  });

  describe('twelve hours from the sign-in, however busy', () => {
    test('a token in date whose session began more than twelve hours ago is refused, and not renewed', async () => {
      const u = await users.createUser('long@test.com', 'password123', 'user');
      const sid = sessionOf(u, 12 * HOUR + MIN);
      const res = await me(tokenFor(u, HOUR, { sid })).expect(401);
      expect(res.body.error).toBe('Your session ended 12 hours after you signed in. Sign in again.');
      expect(renewal(res)).toBeUndefined();
      // A minute short of it, the same token is good.
      const sooner = sessionOf(u, 12 * HOUR - MIN);
      await me(tokenFor(u, HOUR, { sid: sooner })).expect(200);
    });

    test('a token cut short to end with its session says so when it runs out', async () => {
      const u = await users.createUser('cut@test.com', 'password123', 'user');
      const res = await me(tokenFor(u, HOUR, { lifetime: 30 * MIN })).expect(401);
      expect(res.body.error).toBe('Your session ended 12 hours after you signed in. Sign in again.');
    });
  });

  describe('a session that fails a check gets a 401 and no renewal', () => {
    test('a disabled account', async () => {
      const u = await users.createUser('off@test.com', 'password123', 'user');
      const old = tokenFor(u, HOUR);
      users.setDisabled(u.id, true);
      const res = await me(old).expect(401);
      expect(renewal(res)).toBeUndefined();
    });

    test('a token from before the sign-out cutoff', async () => {
      const u = await users.createUser('cut@test.com', 'password123', 'user');
      const old = tokenFor(u, HOUR);
      users.invalidateSessions(u.id);
      const res = await me(old).expect(401);
      expect(res.body.error).toMatch(/signed out/i);
      expect(renewal(res)).toBeUndefined();
    });

    test('a deleted account', async () => {
      const u = await users.createUser('gone@test.com', 'password123', 'user');
      const old = tokenFor(u, HOUR);
      users.deleteUser(u.id);
      expect(renewal(await me(old).expect(401))).toBeUndefined();
    });

    test('an expired token, refused with a plain message', async () => {
      const u = await users.createUser('away@test.com', 'password123', 'user');
      const res = await me(tokenFor(u, 2 * HOUR + MIN)).expect(401);
      expect(res.body.error).toBe('Your session ended after 2 hours without use. Sign in again.');
      expect(renewal(res)).toBeUndefined();
      // A token that is wrong rather than old keeps the generic wording.
      const forged = await me(jwt.sign({ id: u.id }, 'not-the-secret')).expect(401);
      expect(forged.body.error).toBe('Invalid or expired token');
    });

    test('a token signed with any algorithm but HS256 is refused, even with the right secret', async () => {
      const u = await users.createUser('alg@test.com', 'password123', 'user');
      const sid = sessionOf(u);
      const hs512 = jwt.sign({ id: u.id, email: u.email, role: u.role, sid }, auth.jwtSecret(), { algorithm: 'HS512', expiresIn: HOUR });
      expect((await me(hs512).expect(401)).body.error).toBe('Invalid or expired token');
      await me(tokenFor(u, 0, { sid })).expect(200);
    });

    test("a token naming another account's session is refused", async () => {
      const u = await users.createUser('mine@test.com', 'password123', 'user');
      const other = await users.createUser('theirs@test.com', 'password123', 'user');
      const res = await me(tokenFor(u, 0, { sid: sessionOf(other) })).expect(401);
      expect(res.body.error).toBe('You have been signed out. Sign in again.');
    });
  });

  // Before sessions were kept a token named none, and renewal kept it going
  // without one: nothing could end it but a password change. On a server it
  // is refused; only the test suite's own are let through, under
  // NODE_ENV=test (auth-middleware.js#acceptsTokensWithoutSession).
  describe('a token that names no session', () => {
    const legacy = (u, ageSeconds = 0) => jwt.sign({ id: u.id, email: u.email, role: u.role, iat: nowSec() - ageSeconds },
      auth.jwtSecret(), { expiresIn: 24 * HOUR });

    test('is refused, and not renewed, on a server', async () => {
      // As a server runs: production, with a secret of its own.
      process.env.NODE_ENV   = 'production';
      process.env.JWT_SECRET = 'a-real-secret-for-this-test-0123456789abcdef';
      const u = await users.createUser('nosid@test.com', 'password123', 'user');
      const res = await me(legacy(u, HOUR)).expect(401);
      expect(res.body.error).toBe('Your session has ended. Sign in again.');
      expect(renewal(res)).toBeUndefined();
      // A token of a session is fine.
      await me(tokenFor(u)).expect(200);
    });

    test("the test suite's own are accepted while it runs, and never renewed", async () => {
      const u = await users.createUser('suite@test.com', 'password123', 'user');
      expect(renewal(await me(legacy(u, HOUR)).expect(200))).toBeUndefined();
    });
  });

  describe('revocation still reaches renewed tokens', () => {
    test('a later "sign out everywhere" refuses a renewal made before it', async () => {
      const u = await users.createUser('revoke@test.com', 'password123', 'user');
      const sid = sessionOf(u, HOUR);
      const fresh = renewal(await me(tokenFor(u, HOUR, { sid })).expect(200));
      await me(fresh).expect(200);
      // Backdated a few seconds so the cutoff is plainly after it.
      const renewedEarlier = tokenFor(u, 5, { sid, renewed: true });
      users.invalidateSessions(u.id);
      await me(renewedEarlier).expect(401);
    });

    test("a renewal stamped with the cutoff's own second is refused; a sign-in from that second is not", async () => {
      // A renewal needs a token a quarter hour old that passed the cutoff, so
      // one made in the cutoff's second was made before it, for the session
      // the cutoff ended. A sign-in straight after a reset lands in that
      // second too, and must still work.
      const u = await users.createUser('samesec@test.com', 'password123', 'user');
      const sid = sessionOf(u);
      const second = Math.floor(Date.parse(users.invalidateSessions(u.id)) / 1000);
      const sign = extra => jwt.sign({ id: u.id, email: u.email, role: u.role, sid, iat: second, ...extra },
        auth.jwtSecret(), { expiresIn: 2 * HOUR });
      await me(sign({ renewed: true })).expect(401);
      await me(sign({})).expect(200);
    });
  });
});
