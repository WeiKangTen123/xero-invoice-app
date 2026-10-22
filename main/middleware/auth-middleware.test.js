// Sessions are signed with JWT_SECRET and nothing else. Outside production a
// missing secret used to fall back to a string published in this repository,
// so anyone could sign a token the server would accept.
const jwt = require('jsonwebtoken');

describe('auth-middleware secrets', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };
  let auth;
  beforeEach(() => {
    jest.resetModules();
    auth = require('./auth-middleware');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test.each(['development', 'production', undefined])('with no JWT_SECRET and NODE_ENV=%s there is no secret to fall back on', NODE_ENV => {
    if (NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = NODE_ENV;
    delete process.env.JWT_SECRET;
    expect(() => auth.jwtSecret()).toThrow(/JWT_SECRET is not set/);
    // A token signed with the old public fallback is refused, not accepted.
    const forged = jwt.sign({ id: 'someone', role: 'admin' }, 'dev-secret-change-in-production');
    expect(auth.sessionUser(forged)).toEqual({ error: 'Invalid or expired token' });
  });

  test('the test suite keeps a fallback of its own, so it runs on a checkout with no .env', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    expect(auth.jwtSecret()).toBeTruthy();
    expect(auth.jwtSecret()).not.toBe('dev-secret-change-in-production');
    process.env.JWT_SECRET = 'from-the-environment';
    expect(auth.jwtSecret()).toBe('from-the-environment');
  });

  // An account signed in with a temporary password may only replace it; the
  // few routes that screen needs are named by method and mounted path.
  test('allowedBeforePasswordChange: the change itself, who am I, sign out and the sign-in history, and nothing else', () => {
    expect([...auth.PASSWORD_CHANGE_ALLOWED].sort()).toEqual([
      'GET /api/auth/me', 'GET /api/auth/sign-ins', 'POST /api/auth/change-password', 'POST /api/auth/logout',
    ]);
    const ok = (m, p) => auth.allowedBeforePasswordChange(m, p);
    expect(ok('POST', '/api/auth/change-password')).toBe(true);
    expect(ok('get', '/api/auth/me')).toBe(true);
    expect(ok('GET', '/api/auth/sign-ins?limit=5')).toBe(true);   // the query string is not the route
    expect(ok('POST', '/api/auth/logout/')).toBe(true);            // nor a trailing slash
    expect(ok('GET', '/api/auth/change-password')).toBe(false);    // a GET is not the change
    expect(ok('POST', '/api/auth/sign-out-everywhere')).toBe(false);
    expect(ok('GET', '/api/invoices')).toBe(false);
    expect(ok('GET', '/api/admin/users')).toBe(false);
    expect(ok('GET', '/auth/me')).toBe(false);                     // unmounted: not how index.js serves it
    expect(ok('GET', '')).toBe(false);
    expect(ok(undefined, undefined)).toBe(false);
    expect(auth.PASSWORD_CHANGE_REQUIRED).toEqual({ error: 'Set a new password to continue.', code: 'password_change_required' });
  });

  // A sign-in's token names its session; the session must still be live, and
  // less than twelve hours old. A token that names none is refused, except
  // the test suite's own while it runs.
  test('sessionUser: a token whose session has ended, or does not exist, is signed out; one with no sid is refused', async () => {
    process.env.NODE_ENV = 'test';
    require('../db/migrate').run();
    const users    = require('../utils/users');
    const sessions = require('../utils/sessions');
    const u   = await users.createUser('mw@test.com', 'password123', 'user');
    const sid = sessions.startSession(u.id);
    const token = auth.signSession(u, { sid });
    expect(jwt.decode(token)).toMatchObject({ id: u.id, sid });
    expect(jwt.decode(auth.signSession(u)).sid).toBeUndefined();
    expect(auth.sessionUser(token)).toMatchObject({ user: { id: u.id }, claims: { sid }, session: { userId: u.id, startedAt: expect.any(Number) } });
    sessions.endSession(sid, 'logout');
    expect(auth.sessionUser(token)).toEqual({ error: 'You have been signed out. Sign in again.' });
    expect(auth.SIGNED_OUT_MESSAGE).toBe('You have been signed out. Sign in again.');
    expect(auth.sessionUser(auth.signSession(u, { sid: 'f'.repeat(32) }))).toEqual({ error: auth.SIGNED_OUT_MESSAGE });

    // No sid: under NODE_ENV=test, accepted (the route tests' tokens), with
    // a secret of its own or without; on a server, refused.
    delete process.env.JWT_SECRET;
    expect(auth.sessionUser(auth.signSession(u))).toMatchObject({ user: { id: u.id }, session: null });
    process.env.JWT_SECRET = 'x'.repeat(40);
    expect(auth.sessionUser(auth.signSession(u))).toMatchObject({ user: { id: u.id }, session: null });
    for (const NODE_ENV of ['production', 'development']) {
      process.env.NODE_ENV = NODE_ENV;
      expect(auth.sessionUser(auth.signSession(u))).toEqual({ error: 'Your session has ended. Sign in again.' });
    }
    expect(auth.SESSION_ENDED_MESSAGE).toBe('Your session has ended. Sign in again.');
  });

  test('signSession: two hours, cut short to end at the session\'s twelfth hour', async () => {
    process.env.NODE_ENV = 'test';
    require('../db/migrate').run();
    const users    = require('../utils/users');
    const sessions = require('../utils/sessions');
    const u   = await users.createUser('mw2@test.com', 'password123', 'user');
    const lifetime = t => { const c = jwt.decode(t); return c.exp - c.iat; };
    expect(lifetime(auth.signSession(u, { sid: sessions.startSession(u.id) }))).toBe(2 * 60 * 60);
    const startedAt = Date.now() - 11.5 * 60 * 60 * 1000;
    expect(lifetime(auth.signSession(u, { sid: sessions.startSession(u.id), startedAt }))).toBeGreaterThanOrEqual(30 * 60 - 1);
    expect(lifetime(auth.signSession(u, { sid: sessions.startSession(u.id), startedAt }))).toBeLessThanOrEqual(30 * 60);
    // Never minted already dead.
    expect(lifetime(auth.signSession(u, { sid: sessions.startSession(u.id), startedAt: Date.now() - 13 * 60 * 60 * 1000 }))).toBe(1);
  });

  test('jwtSecretProblem: missing is fatal; short or published is only a warning', () => {
    expect(auth.jwtSecretProblem(undefined)).toEqual({ fatal: expect.stringMatching(/^JWT_SECRET is not set/) });
    expect(auth.jwtSecretProblem('')).toEqual({ fatal: expect.stringMatching(/^JWT_SECRET is not set/) });
    expect(auth.jwtSecretProblem('x'.repeat(31))).toEqual({ warning: expect.stringMatching(/only 31 characters; use at least 32/) });
    expect(auth.jwtSecretProblem('dev-secret-change-in-production')).toEqual({ warning: expect.stringMatching(/published in this repository/) });
    expect(auth.jwtSecretProblem('change_this_to_a_long_random_string')).toEqual({ warning: expect.stringMatching(/published in this repository/) });
    expect(auth.jwtSecretProblem('x'.repeat(32))).toEqual({});
  });
});
