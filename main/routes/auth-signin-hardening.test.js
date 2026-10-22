const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// Sign-up and sign-in at the routes, past the happy path: three registrations
// at once, inputs that are not text, the time an unknown address takes, the
// owner signing in to a locked account from an address they have used, a
// lock that a right password checked at the same moment cannot wipe, and a
// rate limit that counts only failures. Real routes, users and database.
describe('routes/auth sign-up and sign-in hardening', () => {
  let app, db, users;
  const PW = 'Fixture-pass-2026';
  const HOME = '203.0.113.5';      // where the owner has signed in before
  const AWAY = '198.51.100.7';     // somewhere they never have

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    db    = require('../db');
    users = require('../utils/users');
    app = express();
    // As index.js: the client's own address comes from the proxy's header.
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ALLOW_REGISTRATION;
  });

  const post = (path, body, ip = HOME) => request(serverFor(app)).post(`/api/auth/${path}`).set('X-Forwarded-For', ip).send(body);
  const register = (body, ip) => post('register', body, ip);
  const login = (email, password, ip) => post('login', { email, password }, ip);
  const row = id => users.findById(id);
  const adminEvents = () => db.prepare('SELECT * FROM admin_events ORDER BY id').all()
    .map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  const lockNow = id => db.prepare('UPDATE users SET locked_until = ?, lock_count = 1 WHERE id = ?')
    .run(new Date(Date.now() + 15 * 60 * 1000).toISOString(), id);

  describe('POST /register', () => {
    test('three at once: exactly one 201, as the admin; the others 403 with the closed message', async () => {
      const results = await Promise.all(['a', 'b', 'c'].map(n => register({ email: `${n}@test.com`, password: `first-admin-pass-${n}` })));
      const statuses = results.map(r => r.status).sort();
      expect(statuses).toEqual([201, 403, 403]);
      const made = results.find(r => r.status === 201);
      expect(made.body.user.role).toBe('admin');
      for (const r of results.filter(x => x.status === 403)) {
        expect(r.body).toEqual({ error: 'Public registration is disabled. Contact your administrator.' });
      }
      expect(users.getAllUsers()).toHaveLength(1);
    });

    test('inputs that are not text are a 400 that says what is needed, never a raw message', async () => {
      for (const body of [
        { email: 42, password: 'first-admin-pass-1' },
        { email: 'first@test.com', password: 123456789012345 },
        { email: ['first@test.com'], password: 'first-admin-pass-1' },
        { email: 'first@test.com', password: { toString: 'x' } },
        { email: 'first@test.com' },
        {},
      ]) {
        const res = await register(body).expect(400);
        expect(res.body).toEqual({ error: 'Email and password are required' });
      }
      expect((await register({ email: 'not-an-address', password: 'first-admin-pass-1' }).expect(400)).body)
        .toEqual({ error: 'Enter a valid email address' });
      expect(users.hasUsers()).toBe(false);
    });

    test('an address already taken, however it is typed, is a 409 (only reachable while registration is open)', async () => {
      process.env.ALLOW_REGISTRATION = 'true';
      await register({ email: 'jane@test.com', password: 'first-admin-pass-1' }).expect(201);
      const res = await register({ email: ' JANE@Test.com ', password: 'another-pass-2026' }).expect(409);
      expect(res.body).toEqual({ error: 'An account with this email already exists' });
    });

    test('anything unexpected is a 500 that says nothing of why', async () => {
      jest.spyOn(require('argon2'), 'hash').mockRejectedValueOnce(new TypeError('email.toLowerCase is not a function'));
      const res = await register({ email: 'first@test.com', password: 'first-admin-pass-1' }).expect(500);
      expect(res.body).toEqual({ error: 'Could not create the account' });
    });

    test('is recorded as user.register, with where it came from; the token it hands back works', async () => {
      const res = await register({ email: 'first@test.com', password: 'first-admin-pass-1' }).expect(201);
      const [e] = adminEvents();
      expect(e).toMatchObject({
        action: 'user.register', actor_id: res.body.user.id, target_user_id: res.body.user.id, target_email: 'first@test.com',
        details: { role: 'admin', ip: HOME, ua: null },
      });
      expect(JSON.stringify(adminEvents())).not.toContain('first-admin-pass-1');
      await request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);
    });
  });

  describe('POST /login', () => {
    test('inputs that are not text are a 400, the same for an address with an account and one without, and count nothing', async () => {
      const u = await users.createUser('jane@test.com', PW, 'user');
      for (const email of ['jane@test.com', 'nobody@test.com']) {
        for (const password of [123456789012, ['x'], { a: 1 }, null, '']) {
          const res = await login(email, password).expect(400);
          expect(res.body).toEqual({ error: 'Email and password are required' });
        }
      }
      expect((await login(42, PW).expect(400)).body).toEqual({ error: 'Email and password are required' });
      expect(row(u.id).failed_logins).toBe(0);
      expect(adminEvents()).toEqual([]);
    });

    test('the address is found however it is cased or spaced', async () => {
      const u = await users.createUser('jane@test.com', PW, 'user');
      const res = await login('  Jane@TEST.com ', PW).expect(200);
      expect(res.body.user.id).toBe(u.id);
    });

    test('an address is looked up whole: one longer than the trail keeps is not cut down to another account\'s', async () => {
      const long = `${'a'.repeat(188)}@example.com`;   // 200 characters
      await users.createUser(long, PW, 'user');
      await login(`${long}zz`, PW).expect(401);
      await login(long, PW).expect(200);
    });

    test('an unknown address costs a password check, so it takes as long as a known one', async () => {
      await users.createUser('jane@test.com', PW, 'user');
      const argon2 = require('argon2');
      const verify = jest.spyOn(argon2, 'verify');
      await login('nobody@test.com', 'Some-guess-2026').expect(401);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledWith(expect.stringMatching(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/), 'Some-guess-2026');
      // Loosely timed, so a busy machine cannot fail it: it used to be 4 ms
      // against 79, and is now one hash against one hash.
      const time = async email => { const t = Date.now(); await login(email, 'Some-guess-2026'); return Date.now() - t; };
      const median = xs => xs.sort((a, b) => a - b)[1];
      const unknown = [], known = [];
      for (let i = 0; i < 3; i++) { unknown.push(await time('nobody@test.com')); known.push(await time('jane@test.com')); }
      expect(median(unknown)).toBeGreaterThanOrEqual(median(known) * 0.25);
    });

    test('a locked account: the right password from an address it has signed in from goes through, and the lock stays for everyone else', async () => {
      const u = await users.createUser('jane@test.com', PW, 'user');
      await login('jane@test.com', PW, HOME).expect(200);
      for (let i = 0; i < 5; i++) await login('jane@test.com', `wrong-${i}`, AWAY);
      const lockedUntil = row(u.id).locked_until;
      expect(Date.parse(lockedUntil)).toBeGreaterThan(Date.now());

      // From somewhere new: refused, right password or wrong, and nothing counted.
      expect((await login('jane@test.com', PW, AWAY).expect(423)).body).toMatchObject({ error: 'Too many failed attempts. This account is locked.', lockedUntil });
      await login('jane@test.com', 'wrong-again', AWAY).expect(423);
      // From home: a wrong password is refused like any other, and counts nothing.
      await login('jane@test.com', 'wrong-again', HOME).expect(423);
      expect(row(u.id)).toMatchObject({ failed_logins: 0, locked_until: lockedUntil });

      // From home, the right password signs in, and is recorded as such.
      const res = await login('jane@test.com', PW, HOME).expect(200);
      expect(jwt.decode(res.body.token)).toMatchObject({ id: u.id, sid: expect.any(String) });
      expect(adminEvents().pop()).toMatchObject({ action: 'login.success', target_user_id: u.id, details: { ip: HOME, viaKnownAddress: true } });
      // The lock is left standing: the stranger is still kept out.
      expect(row(u.id).locked_until).toBe(lockedUntil);
      await login('jane@test.com', PW, AWAY).expect(423);
    });

    test('only a sign-in that went through makes an address known, and only for 90 days', async () => {
      const u = await users.createUser('jane@test.com', PW, 'user');
      // A failure from here is not a sign-in from here.
      await login('jane@test.com', 'wrong', HOME).expect(401);
      lockNow(u.id);
      await login('jane@test.com', PW, HOME).expect(423);
      // A sign-in from here 91 days ago no longer counts; one 89 days ago does.
      const ins = db.prepare("INSERT INTO admin_events (at, actor_id, target_user_id, target_email, action, details) VALUES (?, ?, ?, ?, 'login.success', ?)");
      const daysAgo = d => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
      ins.run(daysAgo(91), u.id, u.id, u.email, JSON.stringify({ ip: HOME }));
      await login('jane@test.com', PW, HOME).expect(423);
      ins.run(daysAgo(89), u.id, u.id, u.email, JSON.stringify({ ip: HOME }));
      await login('jane@test.com', PW, HOME).expect(200);
      // Someone else's sign-in from an address is not this account's.
      const other = await users.createUser('john@test.com', PW, 'user');
      await login('john@test.com', PW, AWAY).expect(200);
      await login('jane@test.com', PW, AWAY).expect(423);
      expect(row(other.id).locked_until).toBeNull();
    });

    // The lock is read before the slow password check, so a wrong guess and
    // the right password sent together both pass it. The wrong one is made to
    // land while the right one is being checked: the right one must then be
    // refused, and must not clear the lock the wrong one set.
    describe('a lock that lands while a right password is being checked', () => {
      async function race(ip, { knownAddress = null } = {}) {
        const u = await users.createUser('race@test.com', PW, 'user');
        if (knownAddress) {
          db.prepare("INSERT INTO admin_events (at, actor_id, target_user_id, target_email, action, details) VALUES (?, ?, ?, ?, 'login.success', ?)")
            .run(new Date().toISOString(), u.id, u.id, u.email, JSON.stringify({ ip: knownAddress }));
        }
        for (let i = 0; i < 4; i++) await login('race@test.com', `wrong-${i}`, AWAY).expect(401);
        const argon2 = require('argon2');
        const realVerify = argon2.verify;
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const verify = jest.spyOn(argon2, 'verify').mockImplementation(async (hash, pw) => {
          if (pw === PW) await gate;
          return realVerify(hash, pw);
        });
        const right = login('race@test.com', PW, ip).then(r => r);
        while (!verify.mock.calls.some(([, pw]) => pw === PW)) await new Promise(resolve => setTimeout(resolve, 5));
        const wrong = await login('race@test.com', 'wrong-4', AWAY);
        expect(wrong.status).toBe(423);
        const lockedUntil = row(u.id).locked_until;
        release();
        return { u, res: await right, lockedUntil };
      }

      test('from a new address: refused as locked, and the lock stands', async () => {
        const { u, res, lockedUntil } = await race(AWAY);
        expect(res.status).toBe(423);
        expect(res.body).toMatchObject({ error: 'Too many failed attempts. This account is locked.', lockedUntil });
        expect(res.body.token).toBeUndefined();
        expect(row(u.id)).toMatchObject({ locked_until: lockedUntil, lock_count: 1, last_login_at: null });
      });

      test('from an address the account has signed in from: let through, and the lock still stands', async () => {
        const { u, res, lockedUntil } = await race(HOME, { knownAddress: HOME });
        expect(res.status).toBe(200);
        expect(row(u.id).locked_until).toBe(lockedUntil);
        expect(adminEvents().pop()).toMatchObject({ action: 'login.success', details: { ip: HOME, viaKnownAddress: true } });
      });
    });
  });

  // Only failures count against an address. Every attempt used to, and an
  // office behind one address was shut out after its tenth sign-in of the
  // morning. The limit is cut to three here so the test can reach it.
  describe('the per-address limit', () => {
    beforeEach(() => {
      jest.resetModules();
      jest.doMock('express-rate-limit', () => {
        const real = jest.requireActual('express-rate-limit');
        return opts => real({ ...opts, max: 3 });
      });
      require('../db/migrate').run();
      db    = require('../db');
      users = require('../utils/users');
      app = express();
      app.set('trust proxy', 1);
      app.use(express.json());
      app.use('/api/auth', require('./auth'));
    });
    afterEach(() => jest.dontMock('express-rate-limit'));

    test('sign-ins that go through are not counted; failures are', async () => {
      await users.createUser('office@test.com', PW, 'user');
      for (let i = 0; i < 5; i++) await login('office@test.com', PW).expect(200);
      for (let i = 0; i < 3; i++) await login('office@test.com', `wrong-${i}`).expect(401);
      const limited = await login('office@test.com', PW).expect(429);
      expect(limited.body.error).toMatch(/too many/i);
      // Another address is its own count.
      await login('office@test.com', PW, AWAY).expect(200);
    });
  });
});
