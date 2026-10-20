const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// Slack is never reached (axios is mocked), and where an address is comes
// from this stand-in for utils/geoip.js, set per test.
jest.mock('axios', () => ({ post: jest.fn(async () => ({})) }));
jest.mock('../utils/geoip', () => ({ lookupIp: jest.fn(() => null), ready: jest.fn(async () => {}) }));

// Sessions (utils/sessions.js) through the routes: every sign-in starts one
// and its tokens carry its sid, Sign out ends it, the routes that keep this
// device signed in keep its session, and a token from before sessions were
// kept still works. Then the sign-in records: the browser on every login.*
// event, refusals, and the Slack alerts for a lock and a new country.
describe('routes/auth sessions and sign-in records', () => {
  let app, db, users, sessions, auth, axios, geoip;
  const PW   = 'Fixture-pass-2026';
  const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Safari/605.1.15';
  const HOUR = 60 * 60;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    db       = require('../db');
    users    = require('../utils/users');
    sessions = require('../utils/sessions');
    auth     = require('../middleware/auth-middleware');
    axios    = require('axios');
    geoip    = require('../utils/geoip');
    app = express();
    // As index.js: the client's own address comes from the proxy's header.
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/auth', require('./auth'));
    app.get('/api/invoices', auth.requireAuth, (req, res) => res.json({ sid: req.user.sid }));
  });
  afterEach(() => { delete process.env.SLACK_WEBHOOK_URL; });

  const login = (email, password, { ip = '203.0.113.5', ua = UA } = {}) => {
    const r = request(serverFor(app)).post('/api/auth/login').set('X-Forwarded-For', ip);
    return (ua ? r.set('User-Agent', ua) : r).send({ email, password });
  };
  const as = (token, verb, path, { ip = '203.0.113.5' } = {}) =>
    request(serverFor(app))[verb](path).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip).set('User-Agent', UA);
  const row = sid => db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  const adminEvents = () => db.prepare('SELECT * FROM admin_events ORDER BY id').all()
    .map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  // A token from before sessions were kept: no sid.
  const legacyToken = (u, secondsAgo = 0) => jwt.sign(
    { id: u.id, email: u.email, role: u.role, iat: Math.floor(Date.now() / 1000) - secondsAgo }, auth.jwtSecret(), { expiresIn: 24 * HOUR });
  // A token of this session made `secondsAgo` ago, as a sign-in would have.
  const sessionToken = (u, sid, secondsAgo = 0, extra = {}) => jwt.sign(
    { id: u.id, email: u.email, role: u.role, sid, iat: Math.floor(Date.now() / 1000) - secondsAgo, ...extra }, auth.jwtSecret(), { expiresIn: 24 * HOUR });
  // The new-country check runs after the response.
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));

  describe('sessions', () => {
    test('a sign-in starts a session with its address and browser, and the token carries its sid', async () => {
      const u = await users.createUser('jane@test.com', PW, 'user');
      const res = await login('jane@test.com', PW).expect(200);
      const { sid } = jwt.decode(res.body.token);
      expect(sid).toMatch(/^[0-9a-f]{32}$/);
      expect(row(sid)).toMatchObject({ user_id: u.id, first_ip: '203.0.113.5', last_ip: '203.0.113.5', user_agent: UA, ended_at: null });
      expect((await as(res.body.token, 'get', '/api/invoices').expect(200)).body).toEqual({ sid });
      // Each sign-in is its own session.
      const again = await login('jane@test.com', PW).expect(200);
      expect(jwt.decode(again.body.token).sid).not.toBe(sid);
      expect(sessions.listSessions(u.id).map(s => s.sid).sort()).toEqual([sid, jwt.decode(again.body.token).sid].sort());
    });

    test('the first account, made at registration, gets a session too', async () => {
      const res = await request(serverFor(app)).post('/api/auth/register').set('User-Agent', UA)
        .send({ email: 'first@test.com', password: 'first-admin-pass-1' }).expect(201);
      const { sid } = jwt.decode(res.body.token);
      expect(row(sid)).toMatchObject({ user_id: res.body.user.id, user_agent: UA });
    });

    test('a renewal keeps the sid: it is the same session', async () => {
      const u = await users.createUser('slide@test.com', PW, 'user');
      const sid = sessions.startSession(u.id);
      const res = await as(sessionToken(u, sid, 2 * HOUR), 'get', '/api/auth/me').expect(200);
      const renewed = jwt.verify(res.headers['x-session-token'], auth.jwtSecret());
      expect(renewed).toMatchObject({ id: u.id, sid, renewed: true });
      expect(res.body.user.sid).toBe(sid);
      await as(res.headers['x-session-token'], 'get', '/api/auth/me').expect(200);
      // Ending the session ends the renewal with it.
      sessions.endSession(sid, 'revoked');
      const refused = await as(res.headers['x-session-token'], 'get', '/api/auth/me').expect(401);
      expect(refused.body.error).toBe('You have been signed out. Sign in again.');
    });

    test('each request records the session in use, from where (throttled in sessions.js)', async () => {
      const u = await users.createUser('seen@test.com', PW, 'user');
      const { body: { token } } = await login('seen@test.com', PW).expect(200);
      const touch = jest.spyOn(sessions, 'touchSession');
      await as(token, 'get', '/api/invoices', { ip: '198.51.100.7' }).expect(200);
      expect(touch).toHaveBeenCalledWith(jwt.decode(token).sid, { ip: '198.51.100.7' });
      touch.mockRestore();
      // A token without a session touches none.
      const spy = jest.spyOn(sessions, 'touchSession');
      await as(legacyToken(u), 'get', '/api/invoices').expect(200);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    test('Sign out ends the session: the token, and any copy of it, is refused from then on, and it is recorded', async () => {
      const u = await users.createUser('bye@test.com', PW, 'user');
      const { body: { token } } = await login('bye@test.com', PW).expect(200);
      const { sid } = jwt.decode(token);
      const other = (await login('bye@test.com', PW).expect(200)).body.token;
      await as(token, 'post', '/api/auth/logout', { ip: '198.51.100.7' }).expect(200);
      expect(row(sid)).toMatchObject({ ended_at: expect.any(String), ended_reason: 'logout', ended_by: null });
      const refused = await as(token, 'get', '/api/auth/me').expect(401);
      expect(refused.body.error).toBe('You have been signed out. Sign in again.');
      await as(other, 'get', '/api/auth/me').expect(200);      // the other device stays signed in
      const event = adminEvents().pop();
      expect(event).toMatchObject({ action: 'logout', actor_id: u.id, actor_email: u.email, target_user_id: u.id, target_email: u.email });
      expect(event.details).toEqual({ ip: '198.51.100.7', ua: UA });
    });

    test('Sign out with a token due a renewal hands none back: it would be of the ended session', async () => {
      const u = await users.createUser('late@test.com', PW, 'user');
      const sid = sessions.startSession(u.id);
      const res = await as(sessionToken(u, sid, 2 * HOUR), 'post', '/api/auth/logout').expect(200);
      expect(res.headers['x-session-token']).toBeUndefined();
    });

    test('a token from before sessions were kept still works, and Sign out with it is still recorded', async () => {
      const u = await users.createUser('legacy@test.com', PW, 'user');
      const token = legacyToken(u);
      expect((await as(token, 'get', '/api/invoices').expect(200)).body).toEqual({ sid: null });
      await as(token, 'post', '/api/auth/logout').expect(200);
      expect(adminEvents().pop()).toMatchObject({ action: 'logout', target_user_id: u.id });
      // Nothing to end, so it runs out on its own.
      await as(token, 'get', '/api/auth/me').expect(200);
    });

    test('change-password keeps this session, ends the others as password_changed, and dates the password', async () => {
      const u = await users.createUser('cp@test.com', PW, 'user');
      const before = users.findById(u.id).password_changed_at;
      const mine   = (await login('cp@test.com', PW).expect(200)).body.token;
      const theirs = (await login('cp@test.com', PW).expect(200)).body.token;
      const sid = jwt.decode(mine).sid;
      await new Promise(resolve => setTimeout(resolve, 5));
      const res = await as(mine, 'post', '/api/auth/change-password').send({ currentPassword: PW, newPassword: 'my-new-pass-2026' }).expect(200);
      expect(jwt.decode(res.body.token).sid).toBe(sid);
      await as(res.body.token, 'get', '/api/auth/me').expect(200);
      expect(sessions.isSessionLive(sid)).toBe(true);
      expect(row(jwt.decode(theirs).sid)).toMatchObject({ ended_reason: 'password_changed', ended_by: null });
      await as(theirs, 'get', '/api/auth/me').expect(401);
      const after = users.findById(u.id).password_changed_at;
      expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    });

    test('sign-out-everywhere keeps this session and ends the others as signed_out_everywhere', async () => {
      const u = await users.createUser('all@test.com', PW, 'user');
      const mine   = (await login('all@test.com', PW).expect(200)).body.token;
      const theirs = (await login('all@test.com', PW).expect(200)).body.token;
      const res = await as(mine, 'post', '/api/auth/sign-out-everywhere').expect(200);
      expect(jwt.decode(res.body.token).sid).toBe(jwt.decode(mine).sid);
      await as(res.body.token, 'get', '/api/auth/me').expect(200);
      expect(row(jwt.decode(theirs).sid)).toMatchObject({ ended_reason: 'signed_out_everywhere' });
      await as(theirs, 'get', '/api/auth/me').expect(401);
      expect(sessions.listSessions(u.id).map(s => s.sid)).toEqual([jwt.decode(mine).sid]);
    });

    test('from a token with no session, those two give this device a new one and still end the rest', async () => {
      const u = await users.createUser('upgrade@test.com', PW, 'user');
      const theirs = (await login('upgrade@test.com', PW).expect(200)).body.token;
      const res = await as(legacyToken(u, 5), 'post', '/api/auth/sign-out-everywhere').expect(200);
      const { sid } = jwt.decode(res.body.token);
      expect(row(sid)).toMatchObject({ user_id: u.id, user_agent: UA, ended_at: null });
      await as(res.body.token, 'get', '/api/auth/me').expect(200);
      await as(theirs, 'get', '/api/auth/me').expect(401);
      expect(row(jwt.decode(theirs).sid).ended_reason).toBe('signed_out_everywhere');
    });
  });

  describe('sign-in records', () => {
    test('every login.* event names the browser, cut to 300 characters; null when none was sent', async () => {
      await users.createUser('ua@test.com', PW, 'user');
      await login('ua@test.com', PW).expect(200);
      await login('ua@test.com', 'wrong', { ua: `  ${'z'.repeat(400)}` }).expect(401);
      await login('nobody@test.com', 'wrong', { ua: null }).expect(401);
      const [success, failed, unknown] = adminEvents();
      expect(success).toMatchObject({ action: 'login.success', details: { ip: '203.0.113.5', ua: UA } });
      expect(failed.details).toEqual({ email: 'ua@test.com', ip: '203.0.113.5', ua: 'z'.repeat(300) });
      expect(unknown.details).toEqual({ email: 'nobody@test.com', ip: '203.0.113.5', ua: null });
    });

    test('attempts on a locked account are recorded as refused, at most one a minute per account', async () => {
      const u = await users.createUser('lock@test.com', PW, 'user');
      const other = await users.createUser('lock2@test.com', PW, 'user');
      for (let i = 0; i < 5; i++) await login('lock@test.com', 'wrong');
      for (let i = 0; i < 5; i++) await login('lock2@test.com', 'wrong');
      expect(adminEvents().filter(e => e.action === 'login.locked')).toHaveLength(2);
      await login('lock@test.com', PW).expect(423);
      await login('lock@test.com', 'wrong', { ip: '198.51.100.7' }).expect(423);
      await login('lock2@test.com', PW).expect(423);
      const refused = () => adminEvents().filter(e => e.action === 'login.refused');
      expect(refused().map(e => [e.target_user_id, e.details])).toEqual([
        [u.id,     { reason: 'locked', ip: '203.0.113.5', ua: UA }],
        [other.id, { reason: 'locked', ip: '203.0.113.5', ua: UA }],   // per account, not one for everyone
      ]);
      // A minute on, the next attempt is recorded again.
      db.prepare("UPDATE admin_events SET at = ? WHERE action = 'login.refused'").run(new Date(Date.now() - 61 * 1000).toISOString());
      await login('lock@test.com', 'wrong', { ip: '198.51.100.7' }).expect(423);
      expect(refused().filter(e => e.target_user_id === u.id).map(e => e.details.ip)).toEqual(['203.0.113.5', '198.51.100.7']);
      expect(users.findById(u.id).failed_logins).toBe(0);   // still nothing counted while locked
    });

    test('a right password on a disabled account, or an expired temporary one, is recorded as refused and why', async () => {
      const off = await users.createUser('off@test.com', PW, 'user');
      users.setDisabled(off.id, true);
      await login('off@test.com', PW).expect(403);
      const old = await users.createUser('old@test.com', PW, 'user', { temporary: true });
      db.prepare('UPDATE users SET temp_password_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), old.id);
      await login('old@test.com', PW).expect(401);
      expect(adminEvents().map(e => [e.action, e.actor_id, e.target_user_id, e.details])).toEqual([
        ['login.refused', null, off.id, { reason: 'disabled', ip: '203.0.113.5', ua: UA }],
        ['login.refused', null, old.id, { reason: 'expired_temporary', ip: '203.0.113.5', ua: UA }],
      ]);
      expect(sessions.listSessions(off.id)).toEqual([]);   // no session for a refused sign-in
    });

    test("the Account page's list carries the browser, and why a sign-in was refused", async () => {
      const u = await users.createUser('acct@test.com', PW, 'user');
      const { body: { token } } = await login('acct@test.com', PW).expect(200);
      db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(new Date(Date.now() + 60 * 1000).toISOString(), u.id);
      await login('acct@test.com', PW).expect(423);
      const res = await as(token, 'get', '/api/auth/sign-ins').expect(200);
      expect(res.body.events).toEqual([
        { at: expect.any(String), action: 'login.refused', ip: '203.0.113.5', ua: UA, reason: 'locked' },
        { at: expect.any(String), action: 'login.success', ip: '203.0.113.5', ua: UA },
      ]);
    });
  });

  describe('Slack security alerts', () => {
    beforeEach(() => { process.env.SLACK_WEBHOOK_URL = 'http://slack.test/hook'; });
    const posted = () => axios.post.mock.calls.map(([url, body]) => { expect(url).toBe('http://slack.test/hook'); return body.text; });

    test('a lock is posted once, with the address it came from', async () => {
      await users.createUser('guess@test.com', PW, 'user');
      for (let i = 0; i < 4; i++) await login('guess@test.com', 'wrong').expect(401);
      expect(posted()).toEqual([]);
      await login('guess@test.com', 'wrong').expect(423);
      await login('guess@test.com', 'wrong').expect(423);
      expect(posted()).toEqual(['🔒 guess@test.com locked for 15 min after 5 failed sign-ins (IP 203.0.113.5)']);
    });

    test('a sign-in from a country none of the last 90 days came from is posted; one from a known country is not', async () => {
      const places = {
        '203.0.113.5':  { country: 'Singapore', countryCode: 'SG', city: 'Singapore', org: 'Singtel' },
        '203.0.113.6':  { country: 'Singapore', countryCode: 'SG', city: 'Singapore', org: 'StarHub' },
        '198.51.100.7': { country: 'Malaysia', countryCode: 'MY', city: 'Kuala Lumpur', org: 'Maxis' },
      };
      geoip.lookupIp.mockImplementation(ip => places[ip] || null);
      await users.createUser('jane@test.com', PW, 'user');
      await login('jane@test.com', PW).expect(200);                              // the first: nothing to compare with
      await settle();
      await login('jane@test.com', PW, { ip: '203.0.113.6' }).expect(200);     // another Singapore address
      await settle();
      expect(posted()).toEqual([]);
      await login('jane@test.com', PW, { ip: '198.51.100.7' }).expect(200);
      await settle();
      expect(posted()).toEqual(['🌏 jane@test.com signed in from Malaysia for the first time in 90 days (IP 198.51.100.7)']);
      expect(geoip.ready).toHaveBeenCalled();
    });

    test('sign-ins older than 90 days do not count as seen, and are looked up no further back', async () => {
      geoip.lookupIp.mockImplementation(ip => (ip === '198.51.100.7' ? { country: 'Malaysia', countryCode: 'MY' } : { country: 'Singapore', countryCode: 'SG' }));
      const u = await users.createUser('back@test.com', PW, 'user');
      const ins = db.prepare("INSERT INTO admin_events (at, actor_id, target_user_id, target_email, action, details) VALUES (?, ?, ?, ?, 'login.success', ?)");
      ins.run(new Date(Date.now() - 100 * 24 * HOUR * 1000).toISOString(), u.id, u.id, u.email, JSON.stringify({ ip: '198.51.100.7' }));
      ins.run(new Date(Date.now() - 10 * 24 * HOUR * 1000).toISOString(), u.id, u.id, u.email, JSON.stringify({ ip: '203.0.113.5' }));
      await login('back@test.com', PW, { ip: '198.51.100.7' }).expect(200);
      await settle();
      expect(posted()).toEqual(['🌏 back@test.com signed in from Malaysia for the first time in 90 days (IP 198.51.100.7)']);
      expect(geoip.lookupIp.mock.calls.map(([ip]) => ip).sort()).toEqual(['198.51.100.7', '203.0.113.5']);
    });

    test('at most the 20 most recent earlier addresses are looked up', async () => {
      geoip.lookupIp.mockImplementation(ip => (ip === '203.0.113.5' ? { country: 'Malaysia', countryCode: 'MY' } : { country: 'Singapore', countryCode: 'SG' }));
      const u = await users.createUser('many@test.com', PW, 'user');
      const ins = db.prepare("INSERT INTO admin_events (at, actor_id, target_user_id, target_email, action, details) VALUES (?, ?, ?, ?, 'login.success', ?)");
      for (let i = 0; i < 30; i++) ins.run(new Date(Date.now() - (30 - i) * 60 * 1000).toISOString(), u.id, u.id, u.email, JSON.stringify({ ip: `10.9.0.${i}` }));
      await login('many@test.com', PW, { ip: '203.0.113.5' }).expect(200);
      await settle();
      const looked = geoip.lookupIp.mock.calls.map(([ip]) => ip);
      expect(looked).toHaveLength(21);   // this address and twenty earlier ones
      expect(looked).toContain('10.9.0.29');
      expect(looked).not.toContain('10.9.0.9');
      expect(posted()).toHaveLength(1);
    });

    test('the lookups stop at the first earlier sign-in from the same country', async () => {
      geoip.lookupIp.mockImplementation(() => ({ country: 'Singapore', countryCode: 'SG' }));
      const u = await users.createUser('home@test.com', PW, 'user');
      const ins = db.prepare("INSERT INTO admin_events (at, actor_id, target_user_id, target_email, action, details) VALUES (?, ?, ?, ?, 'login.success', ?)");
      for (let i = 0; i < 5; i++) ins.run(new Date(Date.now() - (5 - i) * 60 * 1000).toISOString(), u.id, u.id, u.email, JSON.stringify({ ip: `10.9.0.${i}` }));
      await login('home@test.com', PW, { ip: '203.0.113.5' }).expect(200);
      await settle();
      expect(geoip.lookupIp.mock.calls.map(([ip]) => ip)).toEqual(['203.0.113.5', '10.9.0.4']);
      expect(posted()).toEqual([]);
    });

    test('no alert when the address has no country, the earlier ones have none, or the lookup fails; the sign-in goes through regardless', async () => {
      await users.createUser('quiet@test.com', PW, 'user');
      await login('quiet@test.com', PW, { ip: '10.0.0.1' }).expect(200);
      // A private address: nowhere to name.
      geoip.lookupIp.mockImplementation(ip => (ip === '10.0.0.2' ? { private: true } : null));
      await login('quiet@test.com', PW, { ip: '10.0.0.2' }).expect(200);
      await settle();
      // A public address, but no earlier sign-in has a country to compare with.
      geoip.lookupIp.mockImplementation(ip => (ip === '198.51.100.7' ? { country: 'Malaysia', countryCode: 'MY' } : null));
      await login('quiet@test.com', PW, { ip: '198.51.100.7' }).expect(200);
      await settle();
      // The lookup throwing.
      geoip.lookupIp.mockImplementation(() => { throw new Error('database corrupt'); });
      await login('quiet@test.com', PW, { ip: '203.0.113.9' }).expect(200);
      await settle();
      geoip.ready.mockImplementation(async () => { throw new Error('cannot open'); });
      await login('quiet@test.com', PW, { ip: '203.0.113.10' }).expect(200);
      await settle();
      expect(posted()).toEqual([]);
    });

    test('a Slack failure never fails the sign-in', async () => {
      axios.post.mockImplementation(async () => { throw new Error('slack down'); });
      await users.createUser('down@test.com', PW, 'user');
      for (let i = 0; i < 4; i++) await login('down@test.com', 'wrong').expect(401);
      await login('down@test.com', 'wrong').expect(423);
      expect(axios.post).toHaveBeenCalledTimes(1);
      // Nor the alert itself throwing (or a stand-in for notify.js without it).
      const notify = require('../utils/notify');
      jest.spyOn(notify, 'notifySecurity').mockImplementation(() => { throw new Error('boom'); });
      await users.createUser('down2@test.com', PW, 'user');
      for (let i = 0; i < 4; i++) await login('down2@test.com', 'wrong').expect(401);
      await login('down2@test.com', 'wrong').expect(423);
      notify.notifySecurity.mockRestore();
    });
  });
});
