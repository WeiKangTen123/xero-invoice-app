const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

jest.mock('axios', () => ({ post: jest.fn(async () => ({})) }));

// The admin side of 2-step sign-in: what would hand someone an admin's keys
// wants a "Confirm it's you" from this session within ten minutes (making an
// admin; resetting, sending a reset link to or deleting an admin; turning off
// anyone's 2-step), an admin can turn off someone else's 2-step for a lost
// phone, and the Users list says whose is on. Admin sessions here are real
// ones (a sid on the token): a test-suite token with no session has nothing
// to have confirmed and is let through, which the last test pins.
describe('admin: 2-step sign-in and confirming it is you', () => {
  let app, db, users, sessions, mfa, auth, axios, admin, other, jane;
  const PW = 'Fixture-pass-2026';
  const REAUTH = { code: 'reauth_required', error: "Confirm it's you to continue." };

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db       = require('../db');
    users    = require('../utils/users');
    sessions = require('../utils/sessions');
    mfa      = require('../utils/mfa');
    auth     = require('../middleware/auth-middleware');
    axios    = require('axios');
    axios.post.mockClear();
    process.env.APP_BASE_URL = 'https://app.firm.test';
    app = express();
    app.use(express.json());
    app.use('/api/admin', require('./admin'));
    app.use('/api/auth',  require('./auth'));
    admin = await users.createUser('admin@test.com', PW, 'auto');    // first user -> admin
    other = await users.createUser('other@test.com', PW, 'admin');
    jane  = await users.createUser('jane@test.com',  PW, 'user');
  });
  afterEach(() => {
    delete process.env.APP_BASE_URL;
    delete process.env.SLACK_WEBHOOK_URL;
  });

  // A signed-in session of `u`: its sid and the token a sign-in would give.
  function signIn(u) {
    const sid = sessions.startSession(u.id, { ip: '203.0.113.5', userAgent: 'Firefox' });
    return { sid, token: auth.signSession(u, { sid }) };
  }
  const api = (token, verb, path) => request(serverFor(app))[verb](path).set('Authorization', `Bearer ${token}`);
  const confirm = token => api(token, 'post', '/api/auth/reauth').send({ password: PW }).expect(200);
  const events = action => db.prepare('SELECT * FROM admin_events WHERE action = ? ORDER BY id').all(action)
    .map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  function turnOn(u) {
    const { secret } = mfa.beginSetup(u.id);
    expect(mfa.enable(u.id, mfa.codeAt(secret)).ok).toBe(true);
    return secret;
  }

  test('making an admin, and resetting, re-linking or deleting one, want a recent confirmation; the same for a user do not', async () => {
    const me = signIn(admin);
    // Unconfirmed: refused before anything changes.
    expect((await api(me.token, 'post', '/api/admin/users').send({ email: 'new@test.com', password: 'Temp-pass-2026-x', role: 'admin' }).expect(403)).body)
      .toEqual(REAUTH);
    expect(users.findByEmail('new@test.com')).toBeNull();
    expect((await api(me.token, 'patch', `/api/admin/users/${jane.id}/role`).send({ role: 'admin' }).expect(403)).body).toEqual(REAUTH);
    expect(users.findById(jane.id).role).toBe('user');
    expect((await api(me.token, 'patch', `/api/admin/users/${other.id}/password`).send({ password: 'Admin-set-pass-01' }).expect(403)).body).toEqual(REAUTH);
    expect((await api(me.token, 'post', `/api/admin/users/${other.id}/reset-link`).expect(403)).body).toEqual(REAUTH);
    expect((await api(me.token, 'delete', `/api/admin/users/${other.id}`).expect(403)).body).toEqual(REAUTH);
    expect(users.findById(other.id)).not.toBeNull();
    // A 400 or 404 is still said as it is.
    await api(me.token, 'delete', `/api/admin/users/${admin.id}`).expect(400);
    await api(me.token, 'patch', '/api/admin/users/nope/role').send({ role: 'admin' }).expect(404);

    // The same for a user's account, or making a user, need nothing more.
    await api(me.token, 'post', '/api/admin/users').send({ email: 'plain@test.com', password: 'Temp-pass-2026-x', role: 'user' }).expect(201);
    await api(me.token, 'patch', `/api/admin/users/${jane.id}/password`).send({ password: 'Admin-set-pass-01' }).expect(200);
    await api(me.token, 'post', `/api/admin/users/${jane.id}/reset-link`).expect(200);
    await api(me.token, 'patch', `/api/admin/users/${other.id}/role`).send({ role: 'user' }).expect(200);
    await api(me.token, 'patch', `/api/admin/users/${other.id}/role`).send({ role: 'admin' }).expect(403);

    // Confirmed: all of it goes through.
    await confirm(me.token);
    await api(me.token, 'post', '/api/admin/users').send({ email: 'new@test.com', password: 'Temp-pass-2026-x', role: 'admin' }).expect(201);
    await api(me.token, 'patch', `/api/admin/users/${other.id}/role`).send({ role: 'admin' }).expect(200);
    await api(me.token, 'patch', `/api/admin/users/${other.id}/password`).send({ password: 'Admin-set-pass-01' }).expect(200);
    await api(me.token, 'post', `/api/admin/users/${other.id}/reset-link`).expect(200);
    await api(me.token, 'delete', `/api/admin/users/${other.id}`).expect(200);
    expect(users.findById(other.id)).toBeNull();
  });

  test('a confirmation is for ten minutes, and for the session that made it', async () => {
    const me = signIn(admin);
    const laptop = signIn(admin);
    await confirm(me.token);
    await api(me.token, 'patch', `/api/admin/users/${jane.id}/role`).send({ role: 'admin' }).expect(200);
    expect((await api(laptop.token, 'patch', `/api/admin/users/${other.id}/password`).send({ password: 'Admin-set-pass-01' }).expect(403)).body)
      .toEqual(REAUTH);
    // Eleven minutes on, it has run out.
    db.prepare('UPDATE sessions SET reauth_at = ? WHERE id = ?').run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), me.sid);
    expect((await api(me.token, 'patch', `/api/admin/users/${other.id}/password`).send({ password: 'Admin-set-pass-01' }).expect(403)).body)
      .toEqual(REAUTH);
    db.prepare('UPDATE sessions SET reauth_at = ? WHERE id = ?').run(new Date(Date.now() - 9 * 60 * 1000).toISOString(), me.sid);
    await api(me.token, 'patch', `/api/admin/users/${other.id}/password`).send({ password: 'Admin-set-pass-01' }).expect(200);
  });

  test("mfa-reset: confirmation first, never on yourself, then the account's 2-step goes and every session with it", async () => {
    process.env.SLACK_WEBHOOK_URL = 'http://slack.test/hook';
    const me = signIn(admin);
    turnOn(jane);
    const hers = signIn(jane);
    expect((await api(me.token, 'post', `/api/admin/users/${jane.id}/mfa-reset`).expect(403)).body).toEqual(REAUTH);
    expect(mfa.status(jane.id).enabled).toBe(true);
    await confirm(me.token);
    expect((await api(me.token, 'post', `/api/admin/users/${admin.id}/mfa-reset`).expect(400)).body).toEqual({ error: "You can't reset your own 2-step sign-in" });
    await api(me.token, 'post', '/api/admin/users/nope/mfa-reset').expect(404);
    expect((await api(me.token, 'post', `/api/admin/users/${jane.id}/mfa-reset`).expect(200)).body).toEqual({ success: true });
    expect(users.findById(jane.id)).toMatchObject({ mfa_secret: null, mfa_enabled_at: null, mfa_recovery: null, mfa_last_step: null });
    expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get(hers.sid)).toMatchObject({ ended_reason: 'mfa_reset', ended_by: admin.id });
    await api(hers.token, 'get', '/api/auth/me').expect(401);
    expect(events('mfa.reset')).toEqual([expect.objectContaining({ actor_id: admin.id, target_user_id: jane.id, details: { role: 'user' } })]);
    expect(require('../utils/audit-log').describeAdminEvent('mfa.reset', { role: 'user' }, 'jane@test.com')).toBe('Turned off 2-step sign-in for jane@test.com');
    await new Promise(r => setTimeout(r, 20));
    expect(axios.post.mock.calls.map(([, b]) => b.text)).toContain('🔐 admin@test.com turned off 2-step sign-in for jane@test.com');
    // Nothing left to reset.
    expect((await api(me.token, 'post', `/api/admin/users/${jane.id}/mfa-reset`).expect(409)).body)
      .toEqual({ error: "This account doesn't have 2-step sign-in on.", code: 'MFA_NOT_ENABLED' });
    // Only an admin.
    const hersAgain = signIn(jane);
    await api(hersAgain.token, 'post', `/api/admin/users/${admin.id}/mfa-reset`).expect(403);
  });

  test('the Users list says whose 2-step sign-in is on', async () => {
    turnOn(jane);
    const res = await api(signIn(admin).token, 'get', '/api/admin/users').expect(200);
    const byEmail = Object.fromEntries(res.body.users.map(u => [u.email, u]));
    expect(byEmail['jane@test.com'].mfaEnabled).toBe(true);
    expect(byEmail['admin@test.com'].mfaEnabled).toBe(false);
    for (const u of res.body.users) {
      expect(Object.keys(u).some(k => /secret|recovery/i.test(k))).toBe(false);
    }
  });

  test('a test-suite token with no session has nothing to confirm and is let through (NODE_ENV=test only)', async () => {
    const legacy = jwt.sign({ id: admin.id, email: admin.email, role: 'admin' }, auth.jwtSecret());
    await api(legacy, 'post', '/api/admin/users').send({ email: 'new@test.com', password: 'Temp-pass-2026-x', role: 'admin' }).expect(201);
    await api(legacy, 'delete', `/api/admin/users/${other.id}`).expect(200);
  });
});
