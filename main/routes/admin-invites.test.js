// Inviting people and sending reset links from the Admin page (routes/admin.js),
// end to end with the link's other half (routes/auth.js set-password). Real
// routes, users, tokens and database; mail goes through nodemailer's
// jsonTransport and never leaves the test.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

const DAY  = 24 * 60 * 60 * 1000;
const SMTP = { SMTP_HOST: 'smtp.firm.test', SMTP_USER: 'robot@firm.test', SMTP_PASS: 'smtp-secret-pass', APP_BASE_URL: 'https://app.firm.test' };
const ENV_KEYS = [...Object.keys(SMTP), 'SMTP_PORT', 'SMTP_FROM_NAME', 'XERO_OAUTH_REDIRECT_URI'];
const LINK = /^https:\/\/app\.firm\.test\/set-password#t=([A-Za-z0-9_-]{43})$/;

describe('routes/admin — invites and reset links', () => {
  let app, db, users, tokens, mailer, auditLog, jwtSecret, authRoutes, sent, saved, admin;

  beforeEach(async () => {
    jest.resetModules();
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, SMTP);
    require('../db/migrate').run();
    db       = require('../db');
    users    = require('../utils/users');
    tokens   = require('../utils/auth-tokens');
    mailer   = require('../utils/mailer');
    auditLog = require('../utils/audit-log');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    sent = [];
    const json = require('nodemailer').createTransport({ jsonTransport: true });
    mailer._setTransportForTests({ sendMail: async msg => { const info = await json.sendMail(msg); sent.push(JSON.parse(info.message)); return info; } });
    authRoutes = require('./auth');
    app = express();
    app.use(express.json());
    app.use('/api/admin', require('./admin'));
    app.use('/api/auth', authRoutes);
    admin = await users.createUser('ada@gmail.com', 'Admin-pass-2026', 'auto');
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    jest.restoreAllMocks();
  });

  const auth = () => `Bearer ${jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, jwtSecret())}`;
  const as = (verb, path, body) => request(serverFor(app))[verb](`/api/admin${path}`).set('Authorization', auth()).send(body);
  const invite = body => as('post', '/users', { email: 'new@outlook.com', role: 'user', ...body });
  const tokenIn = mail => /\/set-password#t=([A-Za-z0-9_-]{43})/.exec(mail.text)[1];
  const lastEvent = action => auditLog.listAdminEvents({ action, limit: 1 }).events[0];
  const near = (iso, ms) => expect(Math.abs(Date.parse(iso) - (Date.now() + ms))).toBeLessThan(60 * 1000);

  describe('POST /users without a password: an invite', () => {
    test('the account is made with no password and the invite emailed; no link comes back', async () => {
      const res = await invite({}).expect(201);
      expect(Object.keys(res.body).sort()).toEqual(['copied', 'invite', 'success', 'user']);
      expect(res.body.invite).toEqual({ emailed: true, link: null, expiresAt: expect.any(String) });
      near(res.body.invite.expiresAt, 7 * DAY);
      expect(res.body.user).toMatchObject({
        email: 'new@outlook.com', role: 'user', invited: true, inviteExpiresAt: res.body.invite.expiresAt, inviteExpired: false,
        mustChangePassword: false, tempPasswordExpiresAt: null, passwordChangedAt: null,
      });
      expect(users.findByEmail('new@outlook.com').password).toBe('!');

      expect(sent).toHaveLength(1);
      const mail = sent[0];
      expect(mail).toMatchObject({ subject: "You're invited to Financial Automation", to: [{ address: 'new@outlook.com' }] });
      expect(mail.text).toContain('ada@gmail.com has invited you to Financial Automation, with the account new@outlook.com.');
      const raw = tokenIn(mail);
      expect(mail.subject).not.toContain(raw);
      // Only the hash is kept; the link is in the mail and nowhere else.
      expect(JSON.stringify(db.prepare('SELECT * FROM auth_tokens').all())).not.toContain(raw);
      expect(JSON.stringify(res.body)).not.toContain(raw);

      const event = lastEvent('user.create');
      expect(event.details).toEqual({ role: 'user', demo: false, copied: [], invited: true, emailed: true, expiresAt: res.body.invite.expiresAt });
      expect(event.summary).toBe('Created new@outlook.com and invited them by email');
    });

    test('without email set up, the link comes back once, for the admin to hand over, and it works', async () => {
      delete process.env.SMTP_PASS;
      const res = await invite({ role: 'admin', demo: true }).expect(201);
      expect(res.body.invite).toEqual({ emailed: false, link: expect.stringMatching(LINK), expiresAt: expect.any(String) });
      expect(res.body.user).toMatchObject({ role: 'admin', demo: true, invited: true });
      expect(sent).toEqual([]);
      const raw = LINK.exec(res.body.invite.link)[1];
      // Never again: the Users list does not carry it.
      const listed = await as('get', '/users').expect(200);
      expect(JSON.stringify(listed.body)).not.toContain(raw);
      expect(listed.body.users.find(u => u.email === 'new@outlook.com')).toMatchObject({ invited: true, inviteExpired: false });
      expect(lastEvent('user.create').summary).toBe('Created new@outlook.com as an admin as a demo account and invited them (link handed over, not emailed)');

      await request(serverFor(app)).post('/api/auth/set-password').send({ token: raw, password: 'My-own-pass-2026' }).expect(200);
      expect(await users.validatePassword('new@outlook.com', 'My-own-pass-2026')).toMatchObject({ invited: false, role: 'admin', demo: true });
    });

    test('a mail that fails hands the link back with what went wrong, never the mail password', async () => {
      jest.spyOn(require('../utils/logger'), 'warn').mockImplementation(() => {});
      mailer._setTransportForTests({ sendMail: async () => { throw new Error('Invalid login: 535 smtp-secret-pass rejected'); } });
      const res = await invite({}).expect(201);
      expect(res.body.invite).toEqual({ emailed: false, link: expect.stringMatching(LINK), expiresAt: expect.any(String), emailError: 'Invalid login: 535 [password] rejected' });
      expect(JSON.stringify(res.body)).not.toContain('smtp-secret-pass');
      expect(lastEvent('user.create').details).toMatchObject({ invited: true, emailed: false });
    });

    test('with no public address for the link, nothing is made', async () => {
      delete process.env.APP_BASE_URL;
      const res = await invite({}).expect(409);
      expect(res.body).toEqual({ error: expect.stringMatching(/APP_BASE_URL/), code: 'NO_APP_URL' });
      expect(users.findByEmail('new@outlook.com')).toBeNull();
      // The Xero redirect's origin will do.
      process.env.XERO_OAUTH_REDIRECT_URI = 'https://app.firm.test/api/xero/oauth/callback';
      await invite({}).expect(201);
    });

    test('every check of the password path still applies', async () => {
      for (const body of [{ email: 42 }, { email: '   ' }, { email: undefined }]) {
        expect((await invite(body).expect(400)).body.error).toBe('Email is required');
      }
      expect((await invite({ email: 'not-an-address' }).expect(400)).body.error).toBe('Enter a valid email address');
      expect((await invite({ role: 'owner' }).expect(400)).body.error).toBe("Role must be 'admin' or 'user'");
      expect((await invite({ demo: 'yes' }).expect(400)).body.error).toBe('demo must be true or false');
      expect((await invite({ copyFrom: { mailbox: true } }).expect(400)).body.error).toMatch(/sender filter is required/);
      expect(users.findByEmail('new@outlook.com')).toBeNull();
      expect(sent).toEqual([]);

      users.saveUserConfig(admin.id, { DEFAULT_CURRENCY: 'SGD' });
      expect((await invite({ copyFrom: { defaults: true } }).expect(201)).body.copied).toEqual(['defaults']);
      expect((await invite({ email: 'NEW@outlook.com' }).expect(409)).body.code).toBe('EMAIL_EXISTS');
    });

    test('an invite link that cannot be made takes the account with it', async () => {
      jest.spyOn(require('../utils/logger'), 'error').mockImplementation(() => {});
      jest.spyOn(tokens, 'issue').mockImplementation(() => { throw new Error('disk full'); });
      const res = await invite({}).expect(500);
      expect(res.body.error).toBe('Could not make the invite link, so the account was not created. Try again.');
      expect(users.findByEmail('new@outlook.com')).toBeNull();
      expect(sent).toEqual([]);
    });

    test('with a password it is the temporary-password path as before: no invite, no email', async () => {
      const res = await invite({ password: 'Temp-pass-2026-x' }).expect(201);
      expect(Object.keys(res.body).sort()).toEqual(['copied', 'success', 'user']);
      expect(res.body.user).toMatchObject({ mustChangePassword: true, invited: false });
      expect(sent).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get().n).toBe(0);
      expect(lastEvent('user.create').details).toMatchObject({ temporary: true });
      // An empty or non-text password is still refused, not taken as an invite.
      expect((await invite({ email: 'other@outlook.com', password: '' }).expect(400)).body.error).toBe('Email and password are required');
    });
  });

  describe('POST /users/:id/invite', () => {
    test('a new invite replaces the old one', async () => {
      const created = (await invite({}).expect(201)).body.user;
      const first = tokenIn(sent[0]);
      const res = await as('post', `/users/${created.id}/invite`).expect(200);
      expect(res.body).toEqual({ invite: { emailed: true, link: null, expiresAt: expect.any(String) } });
      near(res.body.invite.expiresAt, 7 * DAY);
      expect(sent).toHaveLength(2);
      expect(tokens.peek(first)).toEqual({ ok: false, reason: 'invalid' });
      expect(tokens.peek(tokenIn(sent[1]))).toMatchObject({ ok: true, purpose: 'invite', createdBy: admin.id });
      expect(lastEvent('user.invite')).toMatchObject({ targetEmail: 'new@outlook.com', details: { emailed: true }, summary: 'Sent new@outlook.com a new invite by email' });
    });

    test('refused for an account that has a password, a disabled one, or none at all', async () => {
      const real = await users.createUser('real@outlook.com', 'Real-pass-2026', 'user');
      expect((await as('post', `/users/${real.id}/invite`).expect(409)).body.code).toBe('NOT_INVITED');
      const created = (await invite({}).expect(201)).body.user;
      users.setDisabled(created.id, true);
      expect((await as('post', `/users/${created.id}/invite`).expect(409)).body.code).toBe('DISABLED');
      await as('post', '/users/nobody/invite').expect(404);
    });
  });

  describe('DELETE /users/:id/invite', () => {
    test('the link stops working and the account stays, invited, with none', async () => {
      const created = (await invite({}).expect(201)).body.user;
      const raw = tokenIn(sent[0]);
      await as('delete', `/users/${created.id}/invite`).expect(200, { success: true });
      expect(users.getUser(created.id)).toMatchObject({ invited: true, inviteExpiresAt: null, inviteExpired: true });
      expect((await request(serverFor(app)).post('/api/auth/link-info').send({ token: raw }).expect(410)).body.reason).toBe('invalid');
      expect(lastEvent('user.invite_revoke')).toMatchObject({ details: { revoked: 1 }, summary: 'Revoked the invite of new@outlook.com' });
      // A new invite brings it back.
      await as('post', `/users/${created.id}/invite`).expect(200);
      expect(users.getUser(created.id).inviteExpired).toBe(false);
    });

    test('refused for an account with a password', async () => {
      const real = await users.createUser('real@outlook.com', 'Real-pass-2026', 'user');
      expect((await as('delete', `/users/${real.id}/invite`).expect(409)).body.code).toBe('NOT_INVITED');
      await as('delete', '/users/nobody/invite').expect(404);
    });
  });

  describe('POST /users/:id/reset-link', () => {
    test('a link good for a day, emailed; nothing about the account changes until it is used', async () => {
      const real = await users.createUser('real@outlook.com', 'Real-pass-2026', 'user');
      const before = users.findById(real.id);
      const res = await as('post', `/users/${real.id}/reset-link`).expect(200);
      expect(res.body).toEqual({ reset: { emailed: true, link: null, expiresAt: expect.any(String) } });
      near(res.body.reset.expiresAt, DAY);
      expect(users.findById(real.id)).toEqual(before);
      expect(sent[0]).toMatchObject({ subject: 'Reset your Financial Automation password', to: [{ address: 'real@outlook.com' }] });
      expect(sent[0].text).toContain('ada@gmail.com has sent you a link to set a new password for real@outlook.com');
      expect(sent[0].text).toContain('(in 24 hours)');
      expect(lastEvent('user.reset_link')).toMatchObject({ details: { emailed: true }, summary: 'Sent real@outlook.com a password reset link by email' });

      const raw = tokenIn(sent[0]);
      expect((await request(serverFor(app)).post('/api/auth/link-info').send({ token: raw }).expect(200)).body)
        .toMatchObject({ purpose: 'reset', email: 'real@outlook.com', invitedBy: 'ada@gmail.com' });
      await request(serverFor(app)).post('/api/auth/set-password').send({ token: raw, password: 'Fresh-pass-2026' }).expect(200);
      expect(await users.validatePassword('real@outlook.com', 'Fresh-pass-2026')).toMatchObject({ id: real.id });
    });

    test('without email set up the link comes back to hand over', async () => {
      const real = await users.createUser('real@outlook.com', 'Real-pass-2026', 'user');
      delete process.env.SMTP_HOST;
      const res = await as('post', `/users/${real.id}/reset-link`).expect(200);
      expect(res.body.reset).toEqual({ emailed: false, link: expect.stringMatching(LINK), expiresAt: expect.any(String) });
      expect(sent).toEqual([]);
    });

    test("refused for an account still waiting on its invite, a disabled one, your own, or with no app address", async () => {
      const created = (await invite({}).expect(201)).body.user;
      const res = await as('post', `/users/${created.id}/reset-link`).expect(409);
      expect(res.body).toEqual({ error: expect.stringMatching(/hasn't accepted its invite yet/), code: 'INVITED' });
      const real = await users.createUser('real@outlook.com', 'Real-pass-2026', 'user');
      users.setDisabled(real.id, true);
      expect((await as('post', `/users/${real.id}/reset-link`).expect(409)).body.code).toBe('DISABLED');
      expect((await as('post', `/users/${admin.id}/reset-link`).expect(400)).body.error).toBe('Change your own password from the Account page');
      await as('post', '/users/nobody/reset-link').expect(404);
      users.setDisabled(real.id, false);
      delete process.env.APP_BASE_URL;
      expect((await as('post', `/users/${real.id}/reset-link`).expect(409)).body.code).toBe('NO_APP_URL');
      expect(db.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE purpose = 'reset'").get().n).toBe(0);
    });

    test('admins only', async () => {
      const real = await users.createUser('real@outlook.com', 'Real-pass-2026', 'user');
      const asUser = `Bearer ${jwt.sign({ id: real.id, email: real.email, role: 'user' }, jwtSecret())}`;
      for (const [verb, path] of [['post', '/users'], ['post', `/users/${real.id}/invite`], ['delete', `/users/${real.id}/invite`], ['post', `/users/${admin.id}/reset-link`]]) {
        await request(serverFor(app))[verb](`/api/admin${path}`).set('Authorization', asUser).send({ email: 'x@y.test' }).expect(403);
      }
      expect(sent).toEqual([]);
    });
  });
});
