const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// What an admin does to an account's sessions (utils/sessions.js): signing it
// out everywhere, resetting its password and disabling it end every session
// with why and by whom, and one session can be ended on its own. Auth routes
// are mounted too: the proof is what the account's tokens can do afterwards.
describe('admin: sessions', () => {
  let app, db, users, sessions, auth, admin, target;
  const PW = 'Fixture-pass-2026';

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db       = require('../db');
    users    = require('../utils/users');
    sessions = require('../utils/sessions');
    auth     = require('../middleware/auth-middleware');
    app = express();
    app.use(express.json());
    app.use('/api/admin', require('./admin'));
    app.use('/api/auth',  require('./auth'));
    admin  = await users.createUser('admin@test.com', PW, 'auto');   // first user -> admin
    target = await users.createUser('jane@test.com',  PW, 'user');
  });

  // A signed-in session of `u`: its sid and the token a sign-in would give.
  function signIn(u) {
    const sid = sessions.startSession(u.id, { ip: '203.0.113.5', userAgent: 'Firefox' });
    return { sid, token: auth.signSession(u, { sid }) };
  }
  // The admin's own token, from a session of their own unless told otherwise.
  let adminSession;
  const adminToken = () => { adminSession = adminSession || signIn(admin); return adminSession.token; };
  beforeEach(() => { adminSession = null; });
  const asAdmin = req => req.set('Authorization', `Bearer ${adminToken()}`);
  const me      = token => request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  const row     = sid => db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  const events  = action => db.prepare('SELECT * FROM admin_events WHERE action = ? ORDER BY id').all(action)
    .map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  const revoke  = (userId, sid, token = adminToken()) => request(serverFor(app))
    .post(`/api/admin/users/${userId}/sessions/${sid}/revoke`).set('Authorization', `Bearer ${token}`);

  describe('ending every session of an account', () => {
    test.each([
      ['sign out everywhere', 'signed_out_everywhere', () => asAdmin(request(serverFor(app)).post(`/api/admin/users/${target.id}/sign-out`))],
      ['a password reset',    'password_changed',      () => asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/password`)).send({ password: 'admin-set-pass-01' })],
      ['disabling',           'disabled',              () => asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/disabled`)).send({ disabled: true })],
    ])('%s ends them all, as %s, by that admin', async (_what, reason, act) => {
      const a = signIn(target), b = signIn(target);
      const theirs = signIn(admin);
      await me(a.token).expect(200);
      await act().expect(200);
      for (const s of [a, b]) {
        expect(row(s.sid)).toMatchObject({ ended_at: expect.any(String), ended_reason: reason, ended_by: admin.id });
        await me(s.token).expect(401);
      }
      expect(sessions.listSessions(target.id)).toEqual([]);
      expect(sessions.isSessionLive(theirs.sid)).toBe(true);   // nobody else's
    });

    test('enabling an account again brings no session back', async () => {
      const a = signIn(target);
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/disabled`)).send({ disabled: true }).expect(200);
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/disabled`)).send({ disabled: false }).expect(200);
      expect(row(a.sid).ended_reason).toBe('disabled');
      await me(a.token).expect(401);
    });
  });

  describe('POST /users/:id/sessions/:sid/revoke', () => {
    test('ends that one session, by that admin, and records it; the account stays signed in elsewhere', async () => {
      const lost = signIn(target), kept = signIn(target);
      const res = await revoke(target.id, lost.sid).expect(200);
      expect(res.body).toEqual({ success: true });
      expect(row(lost.sid)).toMatchObject({ ended_reason: 'revoked', ended_by: admin.id });
      const refused = await me(lost.token).expect(401);
      expect(refused.body.error).toBe('You have been signed out. Sign in again.');
      await me(kept.token).expect(200);
      const [event] = events('session.revoke');
      expect(event).toMatchObject({ actor_id: admin.id, actor_email: admin.email, target_user_id: target.id, target_email: target.email, details: { sid: lost.sid } });
      const listed = await asAdmin(request(serverFor(app)).get(`/api/admin/events?action=session.revoke`)).expect(200);
      expect(listed.body.events[0].summary).toBe('Ended a session of jane@test.com');
    });

    test('an unknown account, an unknown session, or one of another account is a 404, and nothing ends', async () => {
      const hers = signIn(target);
      const his  = signIn(admin);
      expect((await revoke('nope', hers.sid).expect(404)).body.error).toBe('User not found');
      expect((await revoke(target.id, 'f'.repeat(32)).expect(404)).body.error).toBe('Session not found');
      expect((await revoke(target.id, his.sid).expect(404)).body.error).toBe('Session not found');
      expect(sessions.isSessionLive(hers.sid)).toBe(true);
      expect(sessions.isSessionLive(his.sid)).toBe(true);
      expect(events('session.revoke')).toEqual([]);
    });

    test("works on the admin's own other sessions, but not the one making the request", async () => {
      const laptop = signIn(admin);
      const current = adminToken();
      const res = await revoke(admin.id, adminSession.sid, current).expect(400);
      expect(res.body.error).toBe('Use Sign out to end this session');
      expect(sessions.isSessionLive(adminSession.sid)).toBe(true);
      await revoke(admin.id, laptop.sid, current).expect(200);
      expect(row(laptop.sid).ended_reason).toBe('revoked');
      await me(current).expect(200);
    });

    test('a session already ended is left as it ended, and nothing more is recorded', async () => {
      const gone = signIn(target);
      sessions.endSession(gone.sid, 'logout');
      await revoke(target.id, gone.sid).expect(200);
      expect(row(gone.sid)).toMatchObject({ ended_reason: 'logout', ended_by: null });
      expect(events('session.revoke')).toEqual([]);
    });

    test('admins only, and the request must be signed in', async () => {
      const s = signIn(target);
      await request(serverFor(app)).post(`/api/admin/users/${target.id}/sessions/${s.sid}/revoke`).expect(401);
      await revoke(target.id, s.sid, signIn(target).token).expect(403);
      expect(sessions.isSessionLive(s.sid)).toBe(true);
    });
  });

  test('GET /users reports when each password was set, the run of locks, and when a temporary password expires', async () => {
    const list = async () => (await asAdmin(request(serverFor(app)).get('/api/admin/users')).expect(200)).body.users
      .find(u => u.id === target.id);
    const created = users.findById(target.id).password_changed_at;
    expect(created).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(await list()).toMatchObject({ passwordChangedAt: created, lockCount: 0, lastLockedAt: null, tempPasswordExpiresAt: null });
    for (let i = 0; i < 5; i++) users.recordFailedLogin(target.id);
    expect(await list()).toMatchObject({ lockCount: 1, lastLockedAt: expect.any(String) });
    await new Promise(resolve => setTimeout(resolve, 5));
    await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/password`)).send({ password: 'admin-set-pass-01' }).expect(200);
    const after = await list();
    expect(Date.parse(after.passwordChangedAt)).toBeGreaterThan(Date.parse(created));
    expect(after).toMatchObject({ lockCount: 0, lastLockedAt: null, tempPasswordExpiresAt: users.findById(target.id).temp_password_expires_at });
    expect(after.tempPasswordExpiresAt).toEqual(expect.any(String));
  });

  test('a token from before sessions were kept is still signed out by the admin', async () => {
    const legacy = jwt.sign({ id: target.id, email: target.email, role: target.role, iat: Math.floor(Date.now() / 1000) - 5 }, auth.jwtSecret());
    await me(legacy).expect(200);
    await asAdmin(request(serverFor(app)).post(`/api/admin/users/${target.id}/sign-out`)).expect(200);
    await me(legacy).expect(401);
  });
});
