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
    test('enforces minimum 12 character password', async () => {
      const res = await request(serverFor(app))
        .post('/api/auth/register')
        .send({ email: 'short@test.com', password: 'elevenchars' })
        .expect(400);
      expect(res.body.error).toMatch(/at least 12 characters/);
    });

    test('the very first account can always be created, becomes admin, and its password is its own (not temporary)', async () => {
      const res = await request(serverFor(app))
        .post('/api/auth/register')
        .send({ email: 'first@test.com', password: 'first-admin-pass-1' })
        .expect(201);
      expect(res.body.user.role).toBe('admin');
      expect(res.body.user.mustChangePassword).toBe(false);
      expect(users.findById(res.body.user.id)).toMatchObject({ must_change_password: 0, temp_password_expires_at: null });
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
          .send({ email: 'stranger@test.com', password: 'stranger-pass-2026' })
          .expect(403);
        expect(res.body.error).toMatch(/registration is disabled/i);

        process.env.ALLOW_REGISTRATION = 'true';
        await request(serverFor(app))
          .post('/api/auth/register')
          .send({ email: 'stranger@test.com', password: 'stranger-pass-2026' })
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
    test('needs the current password, both fields and at least 12 characters', async () => {
      const u = await users.createUser('cp@test.com', 'password123', 'user');
      const t = tokenFor(u);
      // A wrong current password is a 400, not a 401: a 401 would bounce the
      // browser to the login page.
      const wrong = await change(t, { currentPassword: 'wrong', newPassword: 'new-password-2026' }).expect(400);
      expect(wrong.body.error).toMatch(/current password/i);
      await change(t, { currentPassword: 'password123', newPassword: 'short' }).expect(400);
      await change(t, { newPassword: 'new-password-2026' }).expect(400);
      await change(t, { currentPassword: 'password123' }).expect(400);
      await login('cp@test.com', 'password123').expect(200);
    });

    test('a sixth attempt inside 15 minutes is refused, for that account only', async () => {
      // Whoever this stops already holds a session and is guessing the current
      // password, so the limit follows the account, not the IP.
      const u = await users.createUser('guess@test.com', 'password123', 'user');
      const other = await users.createUser('bystander@test.com', 'password123', 'user');
      const t = tokenFor(u);
      for (let i = 0; i < 5; i++) {
        await change(t, { currentPassword: `guess-${i}`, newPassword: 'new-password-2026' }).expect(400);
      }
      const limited = await change(t, { currentPassword: 'password123', newPassword: 'new-password-2026' }).expect(429);
      expect(limited.body.error).toMatch(/too many/i);
      await login('guess@test.com', 'password123').expect(200);   // the right answer, sixth, changed nothing
      await change(tokenFor(other), { currentPassword: 'password123', newPassword: 'new-password-2026' }).expect(200);
    });

    test("an admin's reset that lands mid-change wins: 409, and the admin's password stands", async () => {
      const u = await users.createUser('race@test.com', 'password123', 'user');
      // The reset is made to land in the window this route has: after the
      // current password has been checked, before the new one is written.
      // Hashes are Argon2id (users.js), so the check is argon2.verify.
      const argon2 = require('argon2');
      const realVerify = argon2.verify;
      jest.spyOn(argon2, 'verify').mockImplementationOnce(async (hash, pw) => {
        const ok = await realVerify(hash, pw);
        await users.setPassword(u.id, 'admin-set-pass-01');   // what PATCH /api/admin/users/:id/password calls
        return ok;
      });
      try {
        const res = await change(tokenFor(u), { currentPassword: 'password123', newPassword: 'my-choice-pass-01' }).expect(409);
        expect(res.body.error).toMatch(/changed elsewhere/i);
        expect(res.body.token).toBeUndefined();
      } finally {
        jest.restoreAllMocks();
      }
      await login('race@test.com', 'admin-set-pass-01').expect(200);
      await login('race@test.com', 'my-choice-pass-01').expect(401);
      await login('race@test.com', 'password123').expect(401);
    });

    test('changes the password, keeps this session via the returned token and signs out the others', async () => {
      const u = await users.createUser('cp@test.com', 'password123', 'user');
      const stale = tokenFor(u, 5);
      const res = await change(stale, { currentPassword: 'password123', newPassword: 'new-password-2026' }).expect(200);
      expect(res.body.token).toBeTruthy();
      await me(stale).expect(401);
      await me(res.body.token).expect(200);
      await login('cp@test.com', 'password123').expect(401);
      await login('cp@test.com', 'new-password-2026').expect(200);
    });
  });

  test('POST /logout stops the watcher even when it reports not running — a reconnect may be pending', async () => {
    const registry = require('../email/watcher-registry');
    const stop = jest.spyOn(registry, 'stop');
    try {
      const u = await users.createUser('bye@test.com', 'password123', 'user');
      expect(registry.isRunning(u.id)).toBe(false);
      const res = await request(serverFor(app)).post('/api/auth/logout').set('Authorization', `Bearer ${tokenFor(u)}`).expect(200);
      expect(res.body).toEqual({ ok: true, watcherStopped: false });
      expect(stop).toHaveBeenCalledWith(u.id);
    } finally {
      jest.restoreAllMocks();
    }
  });

  // A QR code left on screen is an upload link that needs no sign-in, so it
  // must not outlive the session that made it.
  test('POST /logout revokes every phone-capture link the account holds, and only its own', async () => {
    const pairing = require('../utils/pairing');
    pairing._reset();
    const u = await users.createUser('pair-out@test.com', 'password123', 'user');
    const other = await users.createUser('pair-stay@test.com', 'password123', 'user');
    const mine = [pairing.create(u.id), pairing.create(u.id)];
    const theirs = pairing.create(other.id);
    expect(mine.every(t => pairing.verify(t))).toBe(true);

    await request(serverFor(app)).post('/api/auth/logout').set('Authorization', `Bearer ${tokenFor(u)}`).expect(200);
    expect(mine.map(t => pairing.verify(t))).toEqual([null, null]);
    expect(pairing.verify(theirs)).not.toBeNull();
    pairing._reset();
  });

  test('POST /logout still signs out, and still stops the watcher, if revoking the links fails', async () => {
    const pairing = require('../utils/pairing');
    const registry = require('../email/watcher-registry');
    jest.spyOn(pairing, 'revokeForUser').mockImplementation(() => { throw new Error('boom'); });
    const stop = jest.spyOn(registry, 'stop');
    try {
      const u = await users.createUser('pair-boom@test.com', 'password123', 'user');
      const res = await request(serverFor(app)).post('/api/auth/logout').set('Authorization', `Bearer ${tokenFor(u)}`).expect(200);
      expect(res.body.ok).toBe(true);
      expect(stop).toHaveBeenCalledWith(u.id);
    } finally {
      jest.restoreAllMocks();
    }
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

// ── Sign-in lockout, temporary passwords and the Account page ───────────────
describe('routes/auth sign-in lockout, temporary passwords and the Account page', () => {
  let app, users, db, auth;
  const PW = 'Fixture-pass-2026';
  const HOUR = 60 * 60;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db    = require('../db');
    users = require('../utils/users');
    auth  = require('../middleware/auth-middleware');
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
    // Any other route, behind the same requireAuth every real route uses.
    app.get('/api/invoices', auth.requireAuth, (_req, res) => res.json({ ok: true }));
  });

  function tokenFor(user, secondsAgo = 0) {
    const iat = Math.floor(Date.now() / 1000) - secondsAgo;
    return jwt.sign({ id: user.id, email: user.email, role: user.role, iat }, auth.jwtSecret(), { expiresIn: 24 * HOUR });
  }
  const login = (email, password) => request(serverFor(app)).post('/api/auth/login').send({ email, password });
  const as    = (token, verb, path) => request(serverFor(app))[verb](path).set('Authorization', `Bearer ${token}`);
  const row   = id => users.findById(id);
  const adminEvents = () => db.prepare('SELECT * FROM admin_events ORDER BY id').all().map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  const failTimes = async (email, n) => { for (let i = 0; i < n; i++) await login(email, `wrong-${i}`); };
  const endLock = id => db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);

  describe('lockout', () => {
    test('the fifth wrong password locks the account for 15 minutes: 423 with when it ends, and the right password is refused too', async () => {
      const u = await users.createUser('lock@test.com', PW, 'user');
      for (let i = 0; i < 4; i++) {
        const res = await login('lock@test.com', 'wrong').expect(401);
        expect(res.body.error).toBe('Invalid email or password');
      }
      expect(row(u.id).failed_logins).toBe(4);
      const locked = await login('lock@test.com', 'wrong').expect(423);
      expect(locked.body).toEqual({ error: 'Too many failed attempts. This account is locked.', lockedUntil: expect.any(String), lockMinutes: 15 });
      const left = Date.parse(locked.body.lockedUntil) - Date.now();
      expect(left).toBeGreaterThan(14 * 60 * 1000);
      expect(left).toBeLessThanOrEqual(15 * 60 * 1000);
      expect(row(u.id)).toMatchObject({ failed_logins: 0, lock_count: 1, locked_until: locked.body.lockedUntil, last_locked_at: expect.any(String) });

      // The right password, while locked: the same answer, and nothing changes.
      const right = await login('lock@test.com', PW).expect(423);
      expect(right.body).toEqual({ error: 'Too many failed attempts. This account is locked.', lockedUntil: locked.body.lockedUntil, lockMinutes: 15 });
      await login('lock@test.com', 'wrong').expect(423);
      expect(row(u.id)).toMatchObject({ failed_logins: 0, lock_count: 1, locked_until: locked.body.lockedUntil, last_login_at: null });
      // Five failures and the lock in the trail, and the two attempts made
      // during it as one refusal: at most one a minute is kept.
      expect(adminEvents().map(e => e.action)).toEqual([...Array(5).fill('login.failed'), 'login.locked', 'login.refused']);
      const [lockEvent, refused] = adminEvents().slice(-2);
      expect(lockEvent.details).toEqual({ ip: expect.any(String), ua: null, lockedUntil: locked.body.lockedUntil, lockMinutes: 15, failures: 5 });
      expect(refused).toMatchObject({ actor_id: null, target_user_id: u.id, details: { reason: 'locked', ip: expect.any(String), ua: null } });
    });

    test('once the lock has ended the right password signs in and clears the record', async () => {
      const u = await users.createUser('after@test.com', PW, 'user');
      await failTimes('after@test.com', 5);
      endLock(u.id);
      const res = await login('after@test.com', PW).expect(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.user).toMatchObject({ id: u.id, email: 'after@test.com', role: 'user', mustChangePassword: false });
      expect(row(u.id)).toMatchObject({ failed_logins: 0, lock_count: 0, locked_until: null, last_locked_at: null, last_login_at: expect.any(String) });
      expect(adminEvents().pop()).toMatchObject({ action: 'login.success', actor_id: u.id, target_user_id: u.id, details: { ip: expect.any(String) } });
    });

    test('after an ended lock wrong passwords count again, and the next lock inside 24 hours is twice as long', async () => {
      const u = await users.createUser('twice@test.com', PW, 'user');
      await failTimes('twice@test.com', 5);
      endLock(u.id);
      await failTimes('twice@test.com', 4);
      expect(row(u.id)).toMatchObject({ failed_logins: 4, lock_count: 1 });
      const second = await login('twice@test.com', 'wrong').expect(423);
      expect(second.body.lockMinutes).toBe(30);
      expect(Date.parse(second.body.lockedUntil) - Date.now()).toBeGreaterThan(29 * 60 * 1000);
      expect(row(u.id).lock_count).toBe(2);
    });

    test('an unknown address is a 401 that counts nothing and is still recorded, without the password', async () => {
      const res = await login('nobody@test.com', 'Secret-typed-here').expect(401);
      expect(res.body.error).toBe('Invalid email or password');
      const [e] = adminEvents();
      expect(e).toMatchObject({ action: 'login.failed', actor_id: null, target_user_id: null, target_email: null, details: { email: 'nobody@test.com', ip: expect.any(String) } });
      expect(JSON.stringify(adminEvents())).not.toContain('Secret-typed-here');
    });

    test('a wrong password on a disabled account counts; the right one is still the disabled answer, and counts nothing', async () => {
      const u = await users.createUser('off@test.com', PW, 'user');
      users.setDisabled(u.id, true);
      await login('off@test.com', 'wrong').expect(401);
      expect(row(u.id).failed_logins).toBe(1);
      const res = await login('off@test.com', PW).expect(403);
      expect(res.body.error).toMatch(/disabled/);
      expect(row(u.id)).toMatchObject({ failed_logins: 1, last_login_at: null });
    });
  });

  describe('temporary passwords', () => {
    test('a temporary password signs in with mustChangePassword, and /me says so too', async () => {
      const u = await users.createUser('temp@test.com', PW, 'user', { temporary: true });
      const res = await login('temp@test.com', PW).expect(200);
      expect(res.body.user).toMatchObject({ id: u.id, mustChangePassword: true });
      const me = await as(res.body.token, 'get', '/api/auth/me').expect(200);
      expect(me.body.user).toMatchObject({ id: u.id, email: 'temp@test.com', mustChangePassword: true, timezone: 'Asia/Singapore' });
    });

    test('an expired temporary password is refused with its own message, and is not a failure', async () => {
      const u = await users.createUser('old@test.com', PW, 'user', { temporary: true });
      db.prepare('UPDATE users SET temp_password_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), u.id);
      const res = await login('old@test.com', PW).expect(401);
      expect(res.body.error).toBe('This temporary password has expired. Ask your administrator for a new one.');
      expect(row(u.id)).toMatchObject({ failed_logins: 0, last_login_at: null });
      // Recorded as refused, not failed, so the admin can see they tried.
      expect(adminEvents().map(e => [e.action, e.details])).toEqual([
        ['login.refused', { reason: 'expired_temporary', ip: expect.any(String), ua: null }],
      ]);
      // A wrong password is still a wrong password.
      await login('old@test.com', 'wrong').expect(401);
      expect(row(u.id).failed_logins).toBe(1);
    });

    test('until it is replaced every other route is a 403 with a code; the change clears it', async () => {
      const u = await users.createUser('gate@test.com', PW, 'user', { temporary: true });
      const { body: { token } } = await login('gate@test.com', PW).expect(200);
      const gated = await as(token, 'get', '/api/invoices').expect(403);
      expect(gated.body).toEqual({ error: 'Set a new password to continue.', code: 'password_change_required' });
      await as(token, 'post', '/api/auth/sign-out-everywhere').expect(403);
      // The allow-list: what the change-password screen needs.
      await as(token, 'get', '/api/auth/me').expect(200);
      await as(token, 'get', '/api/auth/sign-ins').expect(200);
      await as(token, 'get', '/api/auth/sign-ins?x=1').expect(200);
      // Sign out too. It ends the session it is sent with, so it is tried
      // with a second sign-in's token.
      const { body: { token: second } } = await login('gate@test.com', PW).expect(200);
      await as(second, 'post', '/api/auth/logout').expect(200);
      await as(second, 'get', '/api/auth/me').expect(401);
      const short = await as(token, 'post', '/api/auth/change-password').send({ currentPassword: PW, newPassword: 'elevenchars' }).expect(400);
      expect(short.body.error).toBe('Password must be at least 12 characters');
      const changed = await as(token, 'post', '/api/auth/change-password').send({ currentPassword: PW, newPassword: 'my-own-pass-2026' }).expect(200);
      expect(row(u.id)).toMatchObject({ must_change_password: 0, temp_password_expires_at: null });
      await as(changed.body.token, 'get', '/api/invoices').expect(200);
      const me = await as(changed.body.token, 'get', '/api/auth/me').expect(200);
      expect(me.body.user.mustChangePassword).toBe(false);
      const again = await login('gate@test.com', 'my-own-pass-2026').expect(200);
      expect(again.body.user.mustChangePassword).toBe(false);
    });
  });

  describe('password rules at the routes', () => {
    test('register refuses the email address and a common password, naming the rule', async () => {
      const email = 'rules@test.com';
      const register = password => request(serverFor(app)).post('/api/auth/register').send({ email, password });
      expect((await register('Rules@Test.com').expect(400)).body.error).toBe('Password must not be your email address');
      expect((await register('qwerty123456').expect(400)).body.error).toBe('That password is too common; choose another');
      expect((await register('elevenchars').expect(400)).body.error).toBe('Password must be at least 12 characters');
      await register('correct horse battery staple').expect(201);
    });

    test('change-password applies the same rules to the new password', async () => {
      const u = await users.createUser('cp-rules@test.com', PW, 'user');
      const token = tokenFor(u);
      const change = newPassword => as(token, 'post', '/api/auth/change-password').send({ currentPassword: PW, newPassword });
      expect((await change('cp-rules@test.com').expect(400)).body.error).toBe('Password must not be your email address');
      expect((await change('CP-RULES').expect(400)).body.error).toBe('Password must be at least 12 characters');
      expect((await change('1q2w3e4r5t6y').expect(400)).body.error).toBe('That password is too common; choose another');
      await login('cp-rules@test.com', PW).expect(200);
    });

    // The same password again is no change; for a temporary one, the admin
    // who typed it would go on knowing it.
    test('change-password refuses the current password as the new one', async () => {
      const u = await users.createUser('same@test.com', PW, 'user', { temporary: true });
      const res = await as(tokenFor(u), 'post', '/api/auth/change-password').send({ currentPassword: PW, newPassword: PW }).expect(400);
      expect(res.body.error).toBe('Choose a password different from your current one');
      expect(row(u.id).must_change_password).toBe(1);
    });

    // A password set before the rules tightened (or a demo account's short
    // one) still signs in: the account is then asked for a new one, held to
    // that like a temporary password but with no expiry.
    test('a sign-in with a password the rules now refuse must choose a new one first', async () => {
      const u = await users.createUser('old@test.com', 'short-pw', 'user');
      const res = await login('old@test.com', 'short-pw').expect(200);
      expect(res.body.user).toMatchObject({ mustChangePassword: true, passwordChangeReason: 'rules' });
      expect(row(u.id)).toMatchObject({ must_change_password: 1, temp_password_expires_at: null });
      const token = res.body.token;
      expect((await as(token, 'get', '/api/auth/me').expect(200)).body.user).toMatchObject({ mustChangePassword: true, passwordChangeReason: 'rules' });
      await as(token, 'post', '/api/auth/sign-out-everywhere').expect(403);
      const changed = await as(token, 'post', '/api/auth/change-password').send({ currentPassword: 'short-pw', newPassword: 'a-proper-one-2026' }).expect(200);
      expect((await as(changed.body.token, 'get', '/api/auth/me').expect(200)).body.user).toMatchObject({ mustChangePassword: false, passwordChangeReason: null });
      // A password that passes is never asked about.
      expect((await login('old@test.com', 'a-proper-one-2026').expect(200)).body.user.mustChangePassword).toBe(false);
    });

    test('an admin\'s temporary password keeps its own reason, and its expiry', async () => {
      const u = await users.createUser('temp@test.com', PW, 'user', { temporary: true });
      const res = await login('temp@test.com', PW).expect(200);
      expect(res.body.user).toMatchObject({ mustChangePassword: true, passwordChangeReason: 'temporary' });
      expect(row(u.id).temp_password_expires_at).not.toBeNull();
    });
  });

  describe('the Account page', () => {
    test('GET /sign-ins is the caller\'s last 20 sign-in events, newest first, each with the address', async () => {
      const u = await users.createUser('acct@test.com', PW, 'user');
      await users.createUser('other@test.com', PW, 'user');
      await login('other@test.com', 'wrong').expect(401);
      await login('acct@test.com', 'wrong').expect(401);
      const { body: { token } } = await login('acct@test.com', PW).expect(200);
      const res = await as(token, 'get', '/api/auth/sign-ins').expect(200);
      expect(res.body.events.map(e => e.action)).toEqual(['login.success', 'login.failed']);
      for (const e of res.body.events) expect(e).toEqual({ at: expect.any(String), action: expect.any(String), ip: expect.any(String), ua: null });

      const insert = db.prepare("INSERT INTO admin_events (at, target_user_id, target_email, action, details) VALUES (?, ?, ?, 'login.failed', ?)");
      for (let i = 0; i < 25; i++) insert.run(new Date(Date.now() + i).toISOString(), u.id, u.email, JSON.stringify({ email: u.email, ip: `10.0.0.${i}` }));
      const capped = await as(token, 'get', '/api/auth/sign-ins').expect(200);
      expect(capped.body.events).toHaveLength(20);
      expect(capped.body.events[0].ip).toBe('10.0.0.24');
    });

    test('POST /sign-out-everywhere ends the other sessions, keeps this one by its new token, and is recorded as the person\'s own', async () => {
      const u = await users.createUser('bye@test.com', PW, 'user');
      const other = await users.createUser('stay@test.com', PW, 'user');
      const old = tokenFor(u, 2 * HOUR);     // old enough to be due a renewal
      await as(old, 'get', '/api/auth/me').expect(200);
      const res = await as(old, 'post', '/api/auth/sign-out-everywhere').expect(200);
      expect(res.body).toEqual({ token: expect.any(String) });
      expect(res.headers['x-session-token']).toBeUndefined();   // the renewal predates the cutoff
      await as(old, 'get', '/api/auth/me').expect(401);
      await as(res.body.token, 'get', '/api/auth/me').expect(200);
      await as(tokenFor(other, 5), 'get', '/api/auth/me').expect(200);   // nobody else's session
      const [e] = adminEvents();
      expect(e).toMatchObject({ action: 'user.sign_out', actor_id: u.id, actor_email: u.email, target_user_id: u.id, target_email: u.email });
      await request(serverFor(app)).post('/api/auth/sign-out-everywhere').expect(401);
    });
  });
});
