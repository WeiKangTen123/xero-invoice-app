const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// Slack is never reached (axios is mocked), and the new-country lookup finds
// nothing.
jest.mock('axios', () => ({ post: jest.fn(async () => ({})) }));
jest.mock('../utils/geoip', () => ({ lookupIp: jest.fn(() => null), ready: jest.fn(async () => {}) }));

// 2-step sign-in through the real routes, users and database: the password
// step starts no session, the code finishes it (once), wrong codes count like
// wrong passwords and kill the half-made sign-in at five, recovery codes are
// single use, admins must turn it on before anything else, anyone else may,
// and "Confirm it's you" marks this session for ten minutes.
describe('routes/auth 2-step sign-in', () => {
  let app, db, users, sessions, mfa, auth, axios;
  const PW   = 'Fixture-pass-2026';
  const UA   = 'Mozilla/5.0 (Windows NT 10.0) Firefox/131.0';
  const HOME = '203.0.113.5';
  const AWAY = '198.51.100.7';

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    db       = require('../db');
    users    = require('../utils/users');
    sessions = require('../utils/sessions');
    mfa      = require('../utils/mfa');
    auth     = require('../middleware/auth-middleware');
    axios    = require('axios');
    app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
    // Any other route of the app, behind requireAuth like all of them.
    app.get('/api/invoices', auth.requireAuth, (req, res) => res.json({ ok: true }));
  });
  afterEach(() => {
    delete process.env.MFA_REQUIRED_FOR_ADMINS;
    delete process.env.SLACK_WEBHOOK_URL;
  });

  const post  = (path, body, ip = HOME) => request(serverFor(app)).post(`/api/auth/${path}`).set('X-Forwarded-For', ip).set('User-Agent', UA).send(body);
  const login  = (email, password = PW, ip = HOME) => post('login', { email, password }, ip);
  const verify = (body, ip = HOME) => post('mfa/verify', body, ip);
  const as = (token, verb, path, ip = HOME) => request(serverFor(app))[verb](path)
    .set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip).set('User-Agent', UA);
  const row    = id => users.findById(id);
  const events = action => db.prepare('SELECT * FROM admin_events WHERE action = ? ORDER BY id').all(action)
    .map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  const sessionRows = id => db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at').all(String(id));
  const lockNow = id => db.prepare('UPDATE users SET locked_until = ?, lock_count = 1 WHERE id = ?')
    .run(new Date(Date.now() + 15 * 60 * 1000).toISOString(), id);
  // The code the phone shows `steps` steps from now.
  const code = (secret, steps = 0) => mfa.codeAt(secret, Date.now() + steps * 30 * 1000);
  // Turns 2-step on as the set-up page would, with a code from the step before
  // now, so this step's and the next one's are still unused.
  function turnOn(u) {
    const { secret } = mfa.beginSetup(u.id);
    const result = mfa.enable(u.id, code(secret, -1));
    expect(result.ok).toBe(true);
    return { secret, recoveryCodes: result.recoveryCodes };
  }
  // Lets this step's codes be used again, for a test that signs in more than twice.
  const allowCodesAgain = u => db.prepare('UPDATE users SET mfa_last_step = ? WHERE id = ?').run(mfa.stepAt() - 2, u.id);
  // Signs in through both steps; the token.
  async function signIn(u, secret, ip = HOME, steps = 0) {
    const first = await login(u.email, PW, ip).expect(200);
    const res = await verify({ mfaToken: first.body.mfaToken, code: code(secret, steps) }, ip).expect(200);
    return res.body.token;
  }
  // A signed-in session of an account without 2-step, through /login.
  async function plainSignIn(u, ip = HOME) {
    const res = await login(u.email, PW, ip).expect(200);
    return { token: res.body.token, sid: jwt.decode(res.body.token).sid };
  }
  const slackTexts = () => axios.post.mock.calls.map(([, body]) => body.text);

  describe('signing in with 2-step on', () => {
    test('the right password starts no session: an mfaToken, nothing cleared, login.password_ok recorded', async () => {
      const jane = await users.createUser('jane@test.com', PW, 'user');
      turnOn(jane);
      db.prepare('UPDATE users SET failed_logins = 2 WHERE id = ?').run(jane.id);
      const res = await login('jane@test.com').expect(200);
      expect(res.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String), methods: ['totp', 'recovery'] });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(jwt.decode(res.body.mfaToken)).toMatchObject({ id: jane.id, aud: 'mfa' });
      expect(sessionRows(jane.id)).toEqual([]);
      expect(row(jane.id)).toMatchObject({ failed_logins: 2, last_login_at: null });
      expect(events('login.password_ok')).toEqual([expect.objectContaining({ target_user_id: jane.id, actor_id: null, details: { ip: HOME, ua: UA } })]);
      expect(events('login.success')).toEqual([]);
      // It is no session token, even under the test suite (which takes tokens without a session).
      await as(res.body.mfaToken, 'get', '/api/auth/me').expect(401);
      // And it shows in the person's own sign-in list.
      expect(require('../utils/audit-log').listSignInEvents(jane.id)[0]).toMatchObject({ action: 'login.password_ok', ip: HOME });
    });

    test('a right code finishes the sign-in as /login does, once', async () => {
      const jane = await users.createUser('jane@test.com', PW, 'user');
      const { secret } = turnOn(jane);
      db.prepare('UPDATE users SET failed_logins = 2 WHERE id = ?').run(jane.id);
      const first = await login('jane@test.com').expect(200);
      const res = await verify({ mfaToken: first.body.mfaToken, code: code(secret) }).expect(200);
      expect(res.body.user).toMatchObject({ id: jane.id, email: 'jane@test.com', mfaEnabled: true, mfaSetupRequired: false, mustChangePassword: false });
      expect(res.body.user.recoveryCodesLeft).toBeUndefined();
      const { sid } = jwt.decode(res.body.token);
      expect(sessionRows(jane.id)).toEqual([expect.objectContaining({ id: sid, first_ip: HOME, user_agent: UA, ended_at: null })]);
      expect(row(jane.id)).toMatchObject({ failed_logins: 0, last_login_at: expect.any(String) });
      expect(events('login.success')).toEqual([expect.objectContaining({ actor_id: jane.id, details: { ip: HOME, ua: UA, mfa: 'totp' } })]);
      const me = await as(res.body.token, 'get', '/api/auth/me').expect(200);
      expect(me.body.user).toMatchObject({ mfaEnabled: true, mfaSetupRequired: false, sid });
      // The same mfaToken again, even with the next code: spent.
      expect((await verify({ mfaToken: first.body.mfaToken, code: code(secret, 1) }).expect(401)).body)
        .toEqual({ error: 'This sign-in has already been used. Sign in again.', restart: true });
      expect(sessionRows(jane.id)).toHaveLength(1);
    });

    test('a wrong code is a 401 that counts like a wrong password; a code is never good twice', async () => {
      const jane = await users.createUser('jane@test.com', PW, 'user');
      const { secret } = turnOn(jane);
      const first = await login('jane@test.com').expect(200);
      const wrong = String((Number(code(secret)) + 1) % 1000000).padStart(6, '0');
      expect((await verify({ mfaToken: first.body.mfaToken, code: wrong }).expect(401)).body).toEqual({ error: 'That code is not right. Try again.' });
      expect(row(jane.id).failed_logins).toBe(1);
      expect(events('login.failed')).toEqual([expect.objectContaining({ target_user_id: jane.id, details: { reason: 'wrong_code', method: 'totp', ip: HOME, ua: UA } })]);
      expect(require('../utils/audit-log').describeAdminEvent('login.failed', events('login.failed')[0].details, 'jane@test.com'))
        .toBe('Wrong 2-step code for jane@test.com');
      // The same mfaToken still takes the right code.
      const used = code(secret);
      await verify({ mfaToken: first.body.mfaToken, code: used }).expect(200);
      // A code read over a shoulder is no use once typed.
      const again = await login('jane@test.com').expect(200);
      await verify({ mfaToken: again.body.mfaToken, code: used }).expect(401);
    });

    test('a recovery code signs in once, says how many are left, and is told to Slack', async () => {
      process.env.SLACK_WEBHOOK_URL = 'http://slack.test/hook';
      const jane = await users.createUser('jane@test.com', PW, 'user');
      const { recoveryCodes } = turnOn(jane);
      const first = await login('jane@test.com').expect(200);
      const res = await verify({ mfaToken: first.body.mfaToken, recoveryCode: recoveryCodes[0].toUpperCase() }).expect(200);
      expect(res.body.user).toMatchObject({ id: jane.id, recoveryCodesLeft: 9 });
      expect(events('mfa.recovery_used')).toEqual([expect.objectContaining({ actor_id: jane.id, details: { codesLeft: 9, ip: HOME, ua: UA } })]);
      expect(events('login.success')[0].details).toMatchObject({ mfa: 'recovery' });
      await new Promise(r => setTimeout(r, 20));
      expect(slackTexts().some(t => /jane@test\.com signed in with a 2-step recovery code; 9 left/.test(t))).toBe(true);
      // Used up.
      const again = await login('jane@test.com').expect(200);
      expect((await verify({ mfaToken: again.body.mfaToken, recoveryCode: recoveryCodes[0] }).expect(401)).body.error)
        .toBe('That code is not right. Try again.');
      expect(events('login.failed')[0].details).toMatchObject({ reason: 'wrong_code', method: 'recovery' });
      // One typed into the code box is taken as one.
      const res2 = await verify({ mfaToken: again.body.mfaToken, code: recoveryCodes[1] }).expect(200);
      expect(res2.body.user.recoveryCodesLeft).toBe(8);
      expect(mfa.status(jane.id).recoveryCodesLeft).toBe(8);
    });

    test('five wrong codes kill the mfaToken: restart, and the right code after is refused', async () => {
      const jane = await users.createUser('jane@test.com', PW, 'user');
      const { secret } = turnOn(jane);
      const { body: { mfaToken } } = await login('jane@test.com').expect(200);
      for (let i = 0; i < 4; i++) {
        expect((await verify({ mfaToken, code: '000000' }).expect(401)).body).toEqual({ error: 'That code is not right. Try again.' });
      }
      const fifth = await verify({ mfaToken, code: '000000' }).expect(401);
      // Five wrong in a row also lock the account (they count as wrong
      // passwords), which the answer says, beside the restart.
      expect(fifth.body).toEqual({ error: 'Too many wrong codes. Sign in again.', restart: true, lockedUntil: expect.any(String), lockMinutes: 15 });
      expect(events('login.locked')).toHaveLength(1);
      expect((await verify({ mfaToken, code: code(secret) }).expect(401)).body).toEqual({ error: 'Too many wrong codes. Sign in again.', restart: true });
      expect(sessionRows(jane.id)).toEqual([]);
    });

    test('a wrong code that locks the account sooner is the 423 a locked sign-in gets, with restart', async () => {
      const jane = await users.createUser('jane@test.com', PW, 'user');
      const { secret } = turnOn(jane);
      db.prepare('UPDATE users SET failed_logins = 3 WHERE id = ?').run(jane.id);
      const { body: { mfaToken } } = await login('jane@test.com').expect(200);
      await verify({ mfaToken, code: '000000' }).expect(401);
      const res = await verify({ mfaToken, code: '000000' }).expect(423);
      expect(res.body).toEqual({ error: 'Too many failed attempts. This account is locked.', lockedUntil: expect.any(String), lockMinutes: 15, restart: true });
      expect((await verify({ mfaToken, code: code(secret) }).expect(401)).body.restart).toBe(true);
    });

    test('a lock turns the second step away from a new address, and lets the owner through at a known one', async () => {
      const jane = await users.createUser('jane@test.com', PW, 'user');
      const { secret } = turnOn(jane);
      await signIn(jane, secret, HOME);                 // HOME is now a known address
      const fromAway = await login('jane@test.com', PW, AWAY).expect(200);
      const fromHome = await login('jane@test.com', PW, HOME).expect(200);
      lockNow(jane.id);
      const refused = await verify({ mfaToken: fromAway.body.mfaToken, code: code(secret, 1) }, AWAY).expect(423);
      expect(refused.body).toMatchObject({ error: 'Too many failed attempts. This account is locked.', restart: true });
      // At home: a wrong code counts nothing while the lock stands; the right one gets in.
      await verify({ mfaToken: fromHome.body.mfaToken, code: '000000' }, HOME).expect(401);
      expect(row(jane.id).failed_logins).toBe(0);
      const res = await verify({ mfaToken: fromHome.body.mfaToken, code: code(secret, 1) }, HOME).expect(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(row(jane.id).locked_until).not.toBeNull();   // left standing for everyone else
      expect(events('login.success').pop().details).toMatchObject({ mfa: 'totp', viaKnownAddress: true });
    });

    test('a password the rules now refuse: the demand for a new one waits for the code', async () => {
      const jane = await users.createUser('jane@test.com', 'password123', 'user');   // short and common: from before the rules
      const { secret } = turnOn(jane);
      const first = await login('jane@test.com', 'password123').expect(200);
      expect(first.body.mfaRequired).toBe(true);
      expect(row(jane.id).must_change_password).toBe(0);
      const res = await verify({ mfaToken: first.body.mfaToken, code: code(secret) }).expect(200);
      expect(res.body.user).toMatchObject({ mustChangePassword: true, passwordChangeReason: 'rules' });
      expect(row(jane.id).must_change_password).toBe(1);
    });

    test('the half-made sign-in ends when the account changes under it', async () => {
      const jane = await users.createUser('jane@test.com', PW, 'user');
      const { secret } = turnOn(jane);
      const ended = { error: 'Sign in again.', restart: true };
      // Signed out everywhere (a password reset) after the password step.
      let first = await login('jane@test.com').expect(200);
      db.prepare('UPDATE users SET sessions_valid_from = ? WHERE id = ?').run(new Date(Date.now() + 2000).toISOString(), jane.id);
      expect((await verify({ mfaToken: first.body.mfaToken, code: code(secret) }).expect(401)).body).toEqual(ended);
      db.prepare('UPDATE users SET sessions_valid_from = NULL WHERE id = ?').run(jane.id);
      // Disabled.
      first = await login('jane@test.com').expect(200);
      users.setDisabled(jane.id, true);
      expect((await verify({ mfaToken: first.body.mfaToken, code: code(secret) }).expect(401)).body).toEqual(ended);
      users.setDisabled(jane.id, false);
      // 2-step turned off by an admin meanwhile.
      first = await login('jane@test.com').expect(200);
      mfa.turnOff(jane.id);
      expect((await verify({ mfaToken: first.body.mfaToken, code: code(secret) }).expect(401)).body).toEqual(ended);
      expect(sessionRows(jane.id)).toEqual([]);
    });

    test('a missing code is a 400 that counts nothing; a session token or nonsense is no mfaToken', async () => {
      const jane = await users.createUser('jane@test.com', PW, 'user');
      turnOn(jane);
      const { body: { mfaToken } } = await login('jane@test.com').expect(200);
      for (const body of [{ mfaToken }, { mfaToken, code: '' }, { mfaToken, code: { x: 1 } }]) {
        expect((await verify(body).expect(400)).body.error).toBe('Enter the 6-digit code from your authenticator app, or a recovery code.');
      }
      expect(row(jane.id).failed_logins).toBe(0);
      const timedOut = { error: 'Your sign-in timed out. Sign in again.', restart: true };
      const sessionToken = auth.signSession(jane, { sid: sessions.startSession(jane.id) });
      expect((await verify({ mfaToken: sessionToken, code: '123456' }).expect(401)).body).toEqual(timedOut);
      expect((await verify({ code: '123456' }).expect(401)).body).toEqual(timedOut);
      expect((await verify({ mfaToken: 'nonsense', code: '123456' }).expect(401)).body).toEqual(timedOut);
    });

    test('without 2-step, /login is as before, with where the account stands', async () => {
      await users.createUser('bob@test.com', PW, 'user');
      const res = await login('bob@test.com').expect(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(res.body.mfaRequired).toBeUndefined();
      expect(res.body.user).toMatchObject({ mfaEnabled: false, mfaSetupRequired: false });
      expect(events('login.password_ok')).toEqual([]);
    });
  });

  describe('admins must turn it on (MFA_REQUIRED_FOR_ADMINS)', () => {
    beforeEach(() => { process.env.MFA_REQUIRED_FOR_ADMINS = 'true'; });

    test('an admin without 2-step gets a session, then only what setting it up takes', async () => {
      const boss = await users.createUser('boss@test.com', PW, 'admin');
      const res = await login('boss@test.com').expect(200);
      expect(res.body.user).toMatchObject({ role: 'admin', mfaEnabled: false, mfaSetupRequired: true });
      const { token } = res.body;
      const gate = { error: 'Set up 2-step sign-in to continue.', code: 'mfa_setup_required' };
      expect((await as(token, 'get', '/api/invoices').expect(403)).body).toEqual(gate);
      expect((await as(token, 'post', '/api/auth/reauth').send({ password: PW }).expect(403)).body).toEqual(gate);
      expect((await as(token, 'post', '/api/auth/sign-out-everywhere').expect(403)).body).toEqual(gate);
      expect((await as(token, 'post', '/api/auth/mfa/recovery-codes').send({ password: PW }).expect(403)).body).toEqual(gate);
      expect((await as(token, 'get', '/api/auth/me?x=1').expect(200)).body.user).toMatchObject({ mfaEnabled: false, mfaSetupRequired: true });
      await as(token, 'get', '/api/auth/sign-ins').expect(200);
      expect((await as(token, 'get', '/api/auth/mfa').expect(200)).body).toEqual({ enabled: false, enabledAt: null, required: true, recoveryCodesLeft: 0 });
      const setup = await as(token, 'post', '/api/auth/mfa/setup').expect(200);
      const on = await as(token, 'post', '/api/auth/mfa/enable').send({ code: mfa.codeAt(setup.body.secret) }).expect(200);
      expect(on.body.recoveryCodes).toHaveLength(10);
      // The same session goes on, now with everything open.
      await as(token, 'get', '/api/invoices').expect(200);
      expect((await as(token, 'get', '/api/auth/me').expect(200)).body.user).toMatchObject({ mfaEnabled: true, mfaSetupRequired: false });
      expect((await as(token, 'get', '/api/auth/mfa').expect(200)).body).toMatchObject({ enabled: true, required: true, recoveryCodesLeft: 10 });
      // And the next sign-in asks for a code.
      expect((await login('boss@test.com').expect(200)).body.mfaRequired).toBe(true);
      expect(boss.role).toBe('admin');
    });

    test('a temporary password comes first, then 2-step', async () => {
      await users.createUser('boss@test.com', 'Temp-pass-2026-x', 'admin', { temporary: true });
      const { body: { token } } = await login('boss@test.com', 'Temp-pass-2026-x').expect(200);
      expect((await as(token, 'get', '/api/auth/mfa').expect(403)).body.code).toBe('password_change_required');
      const changed = await as(token, 'post', '/api/auth/change-password')
        .send({ currentPassword: 'Temp-pass-2026-x', newPassword: 'My-own-pass-2026' }).expect(200);
      expect((await as(changed.body.token, 'get', '/api/invoices').expect(403)).body.code).toBe('mfa_setup_required');
      await as(changed.body.token, 'get', '/api/auth/mfa').expect(200);
    });

    test('anyone else is never asked, and may turn it on', async () => {
      const bob = await users.createUser('bob@test.com', PW, 'user');
      const { token } = await plainSignIn(bob);
      await as(token, 'get', '/api/invoices').expect(200);
      expect((await as(token, 'get', '/api/auth/mfa').expect(200)).body).toEqual({ enabled: false, enabledAt: null, required: false, recoveryCodesLeft: 0 });
      const setup = await as(token, 'post', '/api/auth/mfa/setup').expect(200);
      await as(token, 'post', '/api/auth/mfa/enable').send({ code: mfa.codeAt(setup.body.secret) }).expect(200);
      expect((await as(token, 'get', '/api/auth/me').expect(200)).body.user).toMatchObject({ mfaEnabled: true, mfaSetupRequired: false });
    });

    test('off by default while the test suite runs: an admin then is not gated', async () => {
      delete process.env.MFA_REQUIRED_FOR_ADMINS;
      await users.createUser('boss@test.com', PW, 'admin');
      const res = await login('boss@test.com').expect(200);
      expect(res.body.user).toMatchObject({ mfaSetupRequired: false });
      await as(res.body.token, 'get', '/api/invoices').expect(200);
    });
  });

  describe('setting it up and looking after it', () => {
    test('set-up: a secret, its otpauth URL and QR code, not cached; 409 once on', async () => {
      const bob = await users.createUser('bob@test.com', PW, 'user');
      const { token } = await plainSignIn(bob);
      const res = await as(token, 'post', '/api/auth/mfa/setup').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        secret: expect.stringMatching(/^[A-Z2-7]{32}$/),
        otpauthUrl: `otpauth://totp/Financial%20Automation:bob%40test.com?secret=${res.body.secret}&issuer=Financial%20Automation&algorithm=SHA1&digits=6&period=30`,
        qrSvg: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
      });
      await as(token, 'post', '/api/auth/mfa/enable').send({ code: mfa.codeAt(res.body.secret) }).expect(200);
      expect((await as(token, 'post', '/api/auth/mfa/setup').expect(409)).body).toEqual({ error: '2-step sign-in is already on.' });
      expect((await as(token, 'post', '/api/auth/mfa/enable').send({ code: '123456' }).expect(409)).body).toEqual({ error: '2-step sign-in is already on.' });
    });

    test('enable: a wrong code points at the clock; none without set-up; a right one ends the other sessions and keeps this one', async () => {
      const bob = await users.createUser('bob@test.com', PW, 'user');
      const here = await plainSignIn(bob);
      const there = await plainSignIn(bob, AWAY);
      expect((await as(here.token, 'post', '/api/auth/mfa/enable').send({ code: '123456' }).expect(400)).body)
        .toEqual({ error: 'Start setting up 2-step sign-in first.' });
      const { body: { secret } } = await as(here.token, 'post', '/api/auth/mfa/setup').expect(200);
      expect((await as(here.token, 'post', '/api/auth/mfa/enable').send({ code: '000000' }).expect(400)).body)
        .toEqual({ error: 'That code is not right. Check the time on your phone and try again.' });
      const res = await as(here.token, 'post', '/api/auth/mfa/enable').send({ code: mfa.codeAt(secret) }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ enabled: true, recoveryCodes: expect.any(Array) });
      expect(res.body.recoveryCodes).toHaveLength(10);
      await as(here.token, 'get', '/api/invoices').expect(200);
      await as(there.token, 'get', '/api/invoices').expect(401);
      expect(sessionRows(bob.id).find(s => s.id === there.sid)).toMatchObject({ ended_reason: 'mfa_enabled' });
      expect(events('mfa.enable')).toEqual([expect.objectContaining({ actor_id: bob.id, target_user_id: bob.id })]);
      // The code that turned it on cannot then sign anyone in.
      const first = await login('bob@test.com').expect(200);
      await verify({ mfaToken: first.body.mfaToken, code: mfa.codeAt(secret) }).expect(401);
    });

    test('new recovery codes: the password first; the old ones stop working; other sessions end', async () => {
      const bob = await users.createUser('bob@test.com', PW, 'user');
      const { secret, recoveryCodes } = turnOn(bob);
      const token = await signIn(bob, secret);
      const other = await signIn(bob, secret, AWAY, 1);
      expect((await as(token, 'post', '/api/auth/mfa/recovery-codes').send({ password: 'wrong-password-1' }).expect(400)).body)
        .toEqual({ error: 'Current password is incorrect' });
      const res = await as(token, 'post', '/api/auth/mfa/recovery-codes').send({ password: PW }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ recoveryCodes: expect.any(Array) });
      expect(res.body.recoveryCodes).toHaveLength(10);
      expect(res.body.recoveryCodes).not.toContain(recoveryCodes[0]);
      expect(mfa.useRecoveryCode(bob.id, recoveryCodes[0])).toBeNull();
      expect(mfa.useRecoveryCode(bob.id, res.body.recoveryCodes[0])).toBe(9);
      await as(token, 'get', '/api/invoices').expect(200);
      await as(other, 'get', '/api/invoices').expect(401);
      expect(events('mfa.recovery_codes')).toHaveLength(1);
    });

    test('turning it off: the password and a code; anyone but an admin', async () => {
      const bob = await users.createUser('bob@test.com', PW, 'user');
      const { secret, recoveryCodes } = turnOn(bob);
      const token = await signIn(bob, secret);
      const other = await signIn(bob, secret, AWAY, 1);
      expect((await as(token, 'post', '/api/auth/mfa/disable').send({ password: PW }).expect(400)).body)
        .toEqual({ error: 'Your current password and a code are required' });
      expect((await as(token, 'post', '/api/auth/mfa/disable').send({ password: 'wrong-password-1', code: recoveryCodes[0] }).expect(400)).body)
        .toEqual({ error: 'Current password is incorrect' });
      expect((await as(token, 'post', '/api/auth/mfa/disable').send({ password: PW, code: '000000' }).expect(400)).body)
        .toEqual({ error: 'That code is not right. Try again.' });
      expect((await as(token, 'post', '/api/auth/mfa/disable').send({ password: PW, code: recoveryCodes[0] }).expect(200)).body)
        .toEqual({ success: true, enabled: false });
      expect(mfa.status(bob.id)).toMatchObject({ enabled: false, recoveryCodesLeft: 0 });
      await as(token, 'get', '/api/invoices').expect(200);
      await as(other, 'get', '/api/invoices').expect(401);
      expect(events('mfa.disable')).toHaveLength(1);
      expect((await as(token, 'post', '/api/auth/mfa/disable').send({ password: PW, code: '123456' }).expect(409)).body)
        .toEqual({ error: "2-step sign-in isn't on for this account." });
      // The next sign-in is the password alone.
      expect((await login('bob@test.com').expect(200)).body.token).toEqual(expect.any(String));

      const boss = await users.createUser('boss@test.com', PW, 'admin');
      const bossCodes = turnOn(boss);
      allowCodesAgain(boss);
      const bossToken = await signIn(boss, bossCodes.secret);
      expect((await as(bossToken, 'post', '/api/auth/mfa/disable').send({ password: PW, code: bossCodes.recoveryCodes[0] }).expect(403)).body)
        .toEqual({ error: 'Admins must keep 2-step sign-in on.' });
      expect(mfa.status(boss.id).enabled).toBe(true);
    });
  });

  describe("confirm it's you", () => {
    test('a password marks this session, and only this one, for ten minutes; a wrong one is a 400', async () => {
      const bob = await users.createUser('bob@test.com', PW, 'user');
      const here = await plainSignIn(bob);
      const there = await plainSignIn(bob, AWAY);
      expect((await as(here.token, 'post', '/api/auth/reauth').send({ password: 'wrong-password-1' }).expect(400)).body)
        .toEqual({ error: 'Current password is incorrect' });
      expect((await as(here.token, 'post', '/api/auth/reauth').send({}).expect(400)).body.error)
        .toBe('Enter your password, or a code from your authenticator app.');
      const before = Date.now();
      const res = await as(here.token, 'post', '/api/auth/reauth').send({ password: PW }).expect(200);
      expect(res.body).toEqual({ success: true, until: expect.any(String) });
      const until = Date.parse(res.body.until);
      expect(until).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
      expect(until).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
      expect(sessions.liveSession(here.sid).reauthAt).toBe(until - 10 * 60 * 1000);
      expect(sessions.liveSession(there.sid).reauthAt).toBeNull();
      expect(events('session.reauth')).toEqual([expect.objectContaining({ actor_id: bob.id, details: { method: 'password', ip: HOME, ua: UA } })]);
    });

    test('a code needs 2-step on, and is good once', async () => {
      const bob = await users.createUser('bob@test.com', PW, 'user');
      const plain = await plainSignIn(bob);
      expect((await as(plain.token, 'post', '/api/auth/reauth').send({ code: '123456' }).expect(400)).body.error)
        .toBe("2-step sign-in isn't on for this account. Use your password.");
      const { secret } = turnOn(bob);
      const token = await signIn(bob, secret);
      const c = code(secret, 1);
      await as(token, 'post', '/api/auth/reauth').send({ code: c }).expect(200);
      expect(events('session.reauth')[0].details.method).toBe('totp');
      expect((await as(token, 'post', '/api/auth/reauth').send({ code: c }).expect(400)).body).toEqual({ error: 'That code is not right. Try again.' });
    });

    test('recentlyConfirmed: within ten minutes of this session confirming; a test-suite token with no session always', async () => {
      const bob = await users.createUser('bob@test.com', PW, 'user');
      const sid = sessions.startSession(bob.id);
      const req = { user: { id: bob.id, sid } };
      expect(auth.recentlyConfirmed(req)).toBe(false);
      sessions.markReauthenticated(sid, Date.now() - 9 * 60 * 1000);
      expect(auth.recentlyConfirmed(req)).toBe(true);
      sessions.markReauthenticated(sid, Date.now() - 11 * 60 * 1000);
      expect(auth.recentlyConfirmed(req)).toBe(false);
      expect(auth.recentlyConfirmed({ user: { id: bob.id, sid: null } })).toBe(true);
      expect(auth.recentlyConfirmed({})).toBe(false);
    });
  });
});
