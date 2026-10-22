// Invite and reset links through the real routes (routes/auth.js): asking
// for a reset on the sign-in page, reading a link, and setting a password
// with it. Real users, tokens, sessions and database. No mail leaves the
// test: it goes through nodemailer's jsonTransport, and Slack is a mock.
jest.mock('axios', () => ({ post: jest.fn(async () => ({})) }));

const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');

const MIN  = 60 * 1000;
const DAY  = 24 * 60 * MIN;
const SMTP = { SMTP_HOST: 'smtp.firm.test', SMTP_USER: 'robot@firm.test', SMTP_PASS: 'smtp-secret-pass', APP_BASE_URL: 'https://app.firm.test' };
const ENV_KEYS = [...Object.keys(SMTP), 'SMTP_PORT', 'SMTP_FROM_NAME', 'XERO_OAUTH_REDIRECT_URI', 'SLACK_WEBHOOK_URL'];
const PW = 'Fixture-pass-2026';

describe('routes/auth — invite and reset links', () => {
  let app, db, users, tokens, sessions, mailer, middleware, authRoutes, axios, sent, saved, admin;

  beforeEach(async () => {
    jest.resetModules();
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, SMTP);
    require('../db/migrate').run();
    db         = require('../db');
    users      = require('../utils/users');
    tokens     = require('../utils/auth-tokens');
    sessions   = require('../utils/sessions');
    mailer     = require('../utils/mailer');
    middleware = require('../middleware/auth-middleware');
    axios      = require('axios');
    sent = [];
    const json = require('nodemailer').createTransport({ jsonTransport: true });
    mailer._setTransportForTests({ sendMail: async msg => { const info = await json.sendMail(msg); sent.push(JSON.parse(info.message)); return info; } });
    authRoutes = require('./auth');
    app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    admin = await users.createUser('boss@firm.test', 'Boss-pass-2026', 'admin');
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    jest.restoreAllMocks();
  });

  const post = (path, body, ip = '203.0.113.5') => request(serverFor(app)).post(`/api/auth${path}`).set('X-Forwarded-For', ip).send(body);
  const settle = () => authRoutes.settled();
  const tokenIn = mail => /\/set-password#t=([A-Za-z0-9_-]{43})/.exec(mail.text)[1];
  const events = action => db.prepare('SELECT * FROM admin_events WHERE action = ? ORDER BY id').all(action)
    .map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  const unusedLinks = () => db.prepare('SELECT * FROM auth_tokens WHERE used_at IS NULL').all();

  describe('GET /status', () => {
    test('says whether the server can send email with links in it', async () => {
      const status = () => request(serverFor(app)).get('/api/auth/status').expect(200).then(r => r.body);
      expect(await status()).toEqual({ hasUsers: true, mail: true });
      delete process.env.APP_BASE_URL;
      expect((await status()).mail).toBe(false);   // nothing to start a link with
      process.env.XERO_OAUTH_REDIRECT_URI = 'https://app.firm.test/api/xero/oauth/callback';
      expect((await status()).mail).toBe(true);
      delete process.env.SMTP_PASS;
      expect(await status()).toEqual({ hasUsers: true, mail: false });
    });
  });

  describe('POST /forgot-password', () => {
    test('the same answer for an account, no account, a disabled one and an invited one; only the real one gets a link', async () => {
      const ana = await users.createUser('ana@test.com', PW, 'user');
      const dis = await users.createUser('dis@test.com', PW, 'user');
      users.setDisabled(dis.id, true);
      await users.createUser('inv@test.com', null, 'user', { invited: true });
      const before = users.findById(ana.id);

      const answers = [];
      for (const [i, email] of ['ana@test.com', 'nobody@test.com', 'dis@test.com', 'inv@test.com'].entries()) {
        const res = await post('/forgot-password', { email }, `198.51.100.${i + 1}`);
        answers.push({ status: res.status, body: res.body, type: res.headers['content-type'], length: res.headers['content-length'] });
      }
      expect(answers.every(a => JSON.stringify(a) === JSON.stringify(answers[0]))).toBe(true);
      expect(answers[0]).toMatchObject({ status: 200, body: { success: true } });

      await settle();
      expect(sent.map(m => m.to[0].address)).toEqual(['ana@test.com']);
      const mail = sent[0];
      expect(mail.subject).toBe('Reset your Financial Automation password');
      const raw = tokenIn(mail);
      expect(mail.subject).not.toContain(raw);
      expect(mail.text).toContain(`https://app.firm.test/set-password#t=${raw}`);
      expect(mail.text).toContain('(in 30 minutes)');
      expect(tokens.peek(raw)).toMatchObject({ ok: true, purpose: 'reset', createdBy: null });

      // In the trail for the three accounts, with where it came from and why
      // nothing went; nothing for the address with no account.
      expect(events('password.reset_requested').map(e => [e.target_email, e.actor_id, e.details])).toEqual([
        ['ana@test.com', null, expect.objectContaining({ ip: '198.51.100.1', emailed: true })],
        ['dis@test.com', null, expect.objectContaining({ ip: '198.51.100.3', emailed: false, reason: 'disabled' })],
        ['inv@test.com', null, expect.objectContaining({ ip: '198.51.100.4', emailed: false, reason: 'invited' })],
      ]);
      // Asking changes nothing about the account: its password still works.
      expect(users.findById(ana.id)).toEqual(before);
      expect(await users.validatePassword('ana@test.com', PW)).toMatchObject({ id: ana.id });
    });

    test('answers before the mail goes', async () => {
      await users.createUser('ana@test.com', PW, 'user');
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const sendMail = jest.fn(async () => { await gate; return {}; });
      mailer._setTransportForTests({ sendMail });
      await post('/forgot-password', { email: 'ana@test.com' }).expect(200, { success: true });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(sendMail).toHaveBeenCalledTimes(1);   // under way, still waiting on the server
      release();
      await settle();
      expect(events('password.reset_requested')[0].details.emailed).toBe(true);
    });

    test('three links an hour per address, however it is typed and wherever from; each replaces the last', async () => {
      await users.createUser('ana@test.com', PW, 'user');
      for (const [i, email] of ['ana@test.com', 'ANA@test.com', ' ana@TEST.com ', 'ana@test.com'].entries()) {
        await post('/forgot-password', { email }, `198.51.100.${i + 1}`).expect(200, { success: true });
        await settle();
      }
      expect(sent).toHaveLength(3);
      const links = sent.map(tokenIn);
      expect(links.map(raw => tokens.peek(raw).ok)).toEqual([false, false, true]);
      expect(unusedLinks()).toHaveLength(1);
      expect(events('password.reset_requested')).toHaveLength(3);
    });

    test('five requests a quarter hour from one address', async () => {
      for (let i = 0; i < 5; i++) await post('/forgot-password', { email: `x${i}@test.com` }).expect(200);
      const res = await post('/forgot-password', { email: 'x9@test.com' }).expect(429);
      expect(res.body.error).toMatch(/Too many requests/);
      await post('/forgot-password', { email: 'x9@test.com' }, '198.51.100.77').expect(200);
    });

    test('with email not set up nothing is sent and no link is made; the request is still recorded', async () => {
      await users.createUser('ana@test.com', PW, 'user');
      delete process.env.SMTP_PASS;
      await post('/forgot-password', { email: 'ana@test.com' }).expect(200, { success: true });
      await settle();
      expect(sent).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get().n).toBe(0);
      expect(events('password.reset_requested')[0].details).toMatchObject({ emailed: false, reason: 'mail_off' });
    });

    test('a mail that fails leaves no live link behind', async () => {
      await users.createUser('ana@test.com', PW, 'user');
      jest.spyOn(require('../utils/logger'), 'warn').mockImplementation(() => {});
      mailer._setTransportForTests({ sendMail: async () => { throw new Error('Connection refused'); } });
      await post('/forgot-password', { email: 'ana@test.com' }).expect(200, { success: true });
      await settle();
      expect(unusedLinks()).toEqual([]);
      expect(events('password.reset_requested')[0].details).toMatchObject({ emailed: false, reason: 'send_failed' });
    });

    test('anything that is not an address is answered the same, and does nothing', async () => {
      for (const body of [{}, { email: 42 }, { email: ['ana@test.com'] }, { email: 'not-an-address' }]) {
        await post('/forgot-password', body).expect(200, { success: true });
      }
      await settle();
      expect(sent).toEqual([]);
      expect(events('password.reset_requested')).toEqual([]);
    });
  });

  describe('POST /link-info', () => {
    test("an invite: for whom, from whom, until when; nothing is used up", async () => {
      const inv = await users.createUser('new@test.com', null, 'user', { invited: true });
      const raw = tokens.issue(inv.id, 'invite', { ttlMs: tokens.INVITE_TTL_MS, createdBy: admin.id });
      const res = await post('/link-info', { token: raw }).expect(200);
      expect(res.body).toEqual({ purpose: 'invite', email: 'new@test.com', invitedBy: 'boss@firm.test', expiresAt: tokens.peek(raw).expiresAt });
      await post('/link-info', { token: raw }).expect(200);
    });

    test('a reset asked for on the sign-in page has nobody behind it', async () => {
      const ana = await users.createUser('ana@test.com', PW, 'user');
      const raw = tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS });
      expect((await post('/link-info', { token: raw }).expect(200)).body).toMatchObject({ purpose: 'reset', email: 'ana@test.com', invitedBy: null });
    });

    test('410 with why: invalid, an expired invite, an expired reset, used, or an address that changed', async () => {
      const gone = { error: "This link isn't valid any more. Ask your administrator for a new one.", reason: 'invalid' };
      for (const token of [undefined, 42, '', 'x'.repeat(43), require('crypto').randomBytes(32).toString('base64url')]) {
        expect((await post('/link-info', { token }).expect(410)).body).toEqual(gone);
      }
      const inv = await users.createUser('new@test.com', null, 'user', { invited: true });
      const oldInvite = tokens.issue(inv.id, 'invite', { ttlMs: tokens.INVITE_TTL_MS, now: Date.now() - 8 * DAY });
      expect((await post('/link-info', { token: oldInvite }).expect(410)).body)
        .toEqual({ error: 'This invite has expired. Ask your administrator to send a new one.', reason: 'expired' });

      const ana = await users.createUser('ana@test.com', PW, 'user');
      const oldReset = tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS, now: Date.now() - 31 * MIN });
      expect((await post('/link-info', { token: oldReset }).expect(410)).body)
        .toEqual({ error: 'This link has expired. Request a new one.', reason: 'expired' });

      const used = tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS });
      tokens.consume(used, () => {});
      expect((await post('/link-info', { token: used }).expect(410)).body)
        .toEqual({ error: 'This link has already been used. If you set your password, sign in.', reason: 'used' });

      const moved = tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS });
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run('ana.new@test.com', ana.id);
      expect((await post('/link-info', { token: moved }).expect(410)).body).toEqual(gone);
    });
  });

  describe('POST /set-password', () => {
    test('a token and a password, as text, are required', async () => {
      for (const body of [{}, { token: 'x' }, { password: PW }, { token: 42, password: PW }, { token: 'x', password: ['a'] }]) {
        expect((await post('/set-password', body).expect(400)).body.error).toBe('A link and a new password are required');
      }
    });

    test('a password the rules refuse is a 400 with why, and the link still works', async () => {
      const ana = await users.createUser('ana@test.com', PW, 'user');
      const raw = tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS });
      expect((await post('/set-password', { token: raw, password: 'short' }).expect(400)).body.error).toBe('Password must be at least 12 characters');
      expect((await post('/set-password', { token: raw, password: 'ana@test.com' }).expect(400)).body.error).toBe('Password must not be your email address');
      expect(tokens.peek(raw).ok).toBe(true);
      expect(await users.validatePassword('ana@test.com', PW)).toMatchObject({ id: ana.id });
    });

    test('a reset sets the password, ends every session, unlocks the account, signs nobody in, and is confirmed by email', async () => {
      const ana  = await users.createUser('ana@test.com', PW, 'user', { temporary: true });
      const sids = [sessions.startSession(ana.id), sessions.startSession(ana.id)];
      const oldToken = middleware.signSession(users.findById(ana.id), { sid: sids[0] });
      for (let i = 0; i < 5; i++) users.recordFailedLogin(ana.id);
      expect(users.lockStatus(users.findById(ana.id))).not.toBeNull();
      const raw = tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS });

      const res = await post('/set-password', { token: raw, password: 'Brand-new-pass-2026' }).expect(200);
      expect(res.body).toEqual({ success: true, email: 'ana@test.com' });
      expect(res.headers[middleware.SESSION_TOKEN_HEADER.toLowerCase()]).toBeUndefined();

      const row = users.findById(ana.id);
      expect(row).toMatchObject({ failed_logins: 0, locked_until: null, lock_count: 0, must_change_password: 0, temp_password_expires_at: null });
      expect(row.sessions_valid_from).toEqual(expect.any(String));
      expect(sids.map(sid => db.prepare('SELECT ended_reason FROM sessions WHERE id = ?').get(sid).ended_reason)).toEqual(['password_reset', 'password_reset']);
      expect(middleware.sessionUser(oldToken).error).toBeTruthy();
      expect(await users.validatePassword('ana@test.com', PW)).toBeNull();
      expect(await users.validatePassword('ana@test.com', 'Brand-new-pass-2026')).toMatchObject({ id: ana.id });

      expect(events('password.set_via_link').map(e => [e.actor_email, e.target_email, e.details])).toEqual([
        ['ana@test.com', 'ana@test.com', expect.objectContaining({ purpose: 'reset', ip: '203.0.113.5' })],
      ]);

      await settle();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ subject: 'Your Financial Automation password was changed', to: [{ address: 'ana@test.com' }] });
      expect(sent[0].text).toMatch(/signed out/);
      expect(sent[0].html).toContain('href="https://app.firm.test/login"');
      expect(JSON.stringify(sent)).not.toContain('Brand-new-pass-2026');
      expect(JSON.stringify(sent)).not.toContain(raw);

      // Once only.
      expect((await post('/set-password', { token: raw, password: 'Another-pass-2026' }).expect(410)).body)
        .toEqual({ error: 'This link has already been used. If you set your password, sign in.', reason: 'used' });
    });

    test('an invited account cannot sign in until it accepts, then can; the admins hear of it', async () => {
      process.env.SLACK_WEBHOOK_URL = 'http://slack.test/hook';
      const inv = await users.createUser('new@test.com', null, 'user', { invited: true });
      const raw = tokens.issue(inv.id, 'invite', { ttlMs: tokens.INVITE_TTL_MS, createdBy: admin.id });
      for (const password of ['!', 'Whatever-pass-2026', '']) {
        await post('/login', { email: 'new@test.com', password }).expect(res => expect([400, 401]).toContain(res.status));
      }

      await post('/set-password', { token: raw, password: 'My-own-pass-2026' }).expect(200, { success: true, email: 'new@test.com' });
      await settle();
      expect(axios.post).toHaveBeenCalledWith('http://slack.test/hook', { text: '✅ new@test.com accepted their invite' });
      expect(sent).toEqual([]);   // no "password changed" mail for an invite
      expect(events('password.set_via_link')[0].details).toMatchObject({ purpose: 'invite' });

      const res = await post('/login', { email: 'new@test.com', password: 'My-own-pass-2026' }).expect(200);
      expect(res.body.user).toMatchObject({ email: 'new@test.com', invited: false, mustChangePassword: false });
      expect(users.findById(inv.id).password_changed_at).toEqual(expect.any(String));
    });

    test('two uses of one link at once: one gets through, the other reads used', async () => {
      const ana = await users.createUser('ana@test.com', PW, 'user');
      const raw = tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS });
      const results = await Promise.all([
        post('/set-password', { token: raw, password: 'First-pass-2026-x' }),
        post('/set-password', { token: raw, password: 'Second-pass-2026-y' }),
      ]);
      expect(results.map(r => r.status).sort()).toEqual([200, 410]);
      expect(results.find(r => r.status === 410).body.reason).toBe('used');
      const winner = results.find(r => r.status === 200) === results[0] ? 'First-pass-2026-x' : 'Second-pass-2026-y';
      expect(await users.validatePassword('ana@test.com', winner)).toMatchObject({ id: ana.id });
    });

    test('an expired, revoked or superseded link sets nothing', async () => {
      const ana = await users.createUser('ana@test.com', PW, 'user');
      const old = tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS, now: Date.now() - 31 * MIN });
      expect((await post('/set-password', { token: old, password: 'Brand-new-pass-2026' }).expect(410)).body.reason).toBe('expired');
      const first = tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS });
      tokens.issue(ana.id, 'reset', { ttlMs: tokens.RESET_TTL_MS });
      expect((await post('/set-password', { token: first, password: 'Brand-new-pass-2026' }).expect(410)).body.reason).toBe('invalid');
      expect(await users.validatePassword('ana@test.com', PW)).toMatchObject({ id: ana.id });
    });

    test('opening and using links: twenty failures a quarter hour from one address', async () => {
      for (let i = 0; i < 20; i++) await post('/link-info', { token: 'nope' }).expect(410);
      await post('/link-info', { token: 'nope' }).expect(429);
      await post('/set-password', { token: 'nope', password: PW }).expect(429);
      await post('/link-info', { token: 'nope' }, '198.51.100.9').expect(410);
    });
  });
});
