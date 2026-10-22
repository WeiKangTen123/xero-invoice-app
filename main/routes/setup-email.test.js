// Setup -> Email (routes/setup.js): the server-wide mail account and the app's
// public address. Admins set them; a save takes effect at once, with no
// restart; the password is never sent back; and Send test email sends one to
// the admin. main/.env is never touched: ENV_FILE points at a file of the
// test's own (scripts/jest.setup.js). No mail leaves the test.
const fs      = require('fs');
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_NAME', 'APP_BASE_URL', 'XERO_OAUTH_REDIRECT_URI'];
const GOOD = {
  SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_USER: 'robot@firm.test', SMTP_PASS: 'abcd efgh ijkl mnop',
  SMTP_FROM_NAME: 'Acme Books', APP_BASE_URL: 'https://app.firm.test',
};

describe('routes/setup — email', () => {
  let app, users, mailer, jwtSecret, admin, member, sent, saved, envFile;

  beforeEach(async () => {
    jest.resetModules();
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    envFile = process.env.ENV_FILE;
    expect(envFile).toMatch(/test\.env$/);   // never the real main/.env
    fs.rmSync(envFile, { force: true });
    require('../db/migrate').run();
    users  = require('../utils/users');
    mailer = require('../utils/mailer');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    sent = [];
    const json = require('nodemailer').createTransport({ jsonTransport: true });
    mailer._setTransportForTests({ sendMail: async msg => { const info = await json.sendMail(msg); sent.push(JSON.parse(info.message)); return info; } });
    app = express();
    app.use(express.json());
    app.use('/api/setup', require('./setup'));
    app.use('/api/auth', require('./auth'));
    admin  = await users.createUser('ada@firm.test', 'Admin-pass-2026', 'admin');
    member = await users.createUser('mo@firm.test', 'Member-pass-2026', 'user');
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(envFile, { force: true });
    jest.restoreAllMocks();
  });

  const bearer = u => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const get  = (u = admin) => request(serverFor(app)).get('/api/setup').set('Authorization', bearer(u)).expect(200).then(r => r.body);
  const save = (body, u = admin) => request(serverFor(app)).post('/api/setup').set('Authorization', bearer(u)).send(body);
  const testEmail = (u = admin) => request(serverFor(app)).post('/api/setup/test/email').set('Authorization', bearer(u));

  test('the email section, labelled, with help, and the password masked', async () => {
    let body = await get();
    expect(Object.keys(body.email)).toEqual(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_NAME', 'APP_BASE_URL']);
    expect(body.email.SMTP_PASS).toEqual({
      value: '', isSet: false, readOnly: false, masked: '', label: 'Password',
      hint: 'For Gmail: an App Password (myaccount.google.com/apppasswords) for the address above.',
    });
    for (const meta of Object.values(body.email)) expect(meta).toMatchObject({ label: expect.any(String), hint: expect.any(String) });

    await save(GOOD).expect(200);
    body = await get();
    expect(body.email.SMTP_HOST).toMatchObject({ value: 'smtp.gmail.com', isSet: true, readOnly: false });
    expect(body.email.SMTP_PASS).toMatchObject({ value: '', isSet: true, masked: '••••••••••••mnop' });
    expect(JSON.stringify(body)).not.toContain('abcd efgh');

    // Someone who is not an admin sees it read-only, and not even the end of the password.
    const theirs = await get(member);
    expect(theirs.email.SMTP_HOST).toMatchObject({ value: 'smtp.gmail.com', readOnly: true });
    expect(theirs.email.SMTP_PASS).toMatchObject({ value: '', isSet: true, readOnly: true, masked: '••••••••••••' });
  });

  test('a save takes effect at once, with no restart, and is written to the env file', async () => {
    expect((await request(serverFor(app)).get('/api/auth/status').expect(200)).body.mail).toBe(false);
    await save(GOOD).expect(200);
    expect(mailer.isConfigured()).toBe(true);
    expect(mailer.appBaseUrl()).toBe('https://app.firm.test');
    expect((await request(serverFor(app)).get('/api/auth/status').expect(200)).body.mail).toBe(true);
    const file = fs.readFileSync(envFile, 'utf8');
    for (const [k, v] of Object.entries(GOOD)) expect(file).toContain(`${k}=${v}`);

    // A blank password keeps the saved one; a new one replaces it.
    await save({ SMTP_PASS: '', SMTP_HOST: 'smtp.office365.com' }).expect(200);
    expect(process.env.SMTP_PASS).toBe('abcd efgh ijkl mnop');
    expect(process.env.SMTP_HOST).toBe('smtp.office365.com');
    await save({ SMTP_PASS: '  new-app-pass  ' }).expect(200);
    expect(process.env.SMTP_PASS).toBe('new-app-pass');
  });

  test('the app address is kept as its origin', async () => {
    await save({ APP_BASE_URL: ' https://app.firm.test/login?x=1 ' }).expect(200);
    expect(process.env.APP_BASE_URL).toBe('https://app.firm.test');
  });

  test('values that cannot work are refused, and nothing of the save is applied', async () => {
    const cases = [
      [{ SMTP_HOST: 'smtp gmail.com' }, 'SMTP_HOST'], [{ SMTP_HOST: '-smtp.test' }, 'SMTP_HOST'],
      [{ SMTP_PORT: 'abc' }, 'SMTP_PORT'], [{ SMTP_PORT: '70000' }, 'SMTP_PORT'], [{ SMTP_PORT: '0' }, 'SMTP_PORT'],
      [{ SMTP_USER: 'robot' }, 'SMTP_USER'], [{ SMTP_FROM_NAME: 'x'.repeat(101) }, 'SMTP_FROM_NAME'],
      [{ APP_BASE_URL: 'ftp://app.firm.test' }, 'APP_BASE_URL'], [{ APP_BASE_URL: 'app.firm.test' }, 'APP_BASE_URL'],
      // A line break would write a setting of the sender's choosing into main/.env.
      [{ SMTP_PASS: 'pass\nJWT_SECRET=mine' }, 'SMTP_PASS'], [{ SLACK_WEBHOOK_URL: 'https://hooks.test/x\r\nAPP_BASE_URL=https://evil.test' }, 'SLACK_WEBHOOK_URL'],
      [{ SMTP_HOST: { $ne: '' } }, 'SMTP_HOST'],
    ];
    for (const [body, field] of cases) {
      const res = await save({ ...body, DEFAULT_CURRENCY: 'USD' }).expect(400);
      expect(res.body.errors.map(e => e.field)).toEqual([field]);
    }
    expect(fs.existsSync(envFile)).toBe(false);
    expect(process.env.SMTP_HOST).toBeUndefined();
    expect(users.getUserConfig(admin.id).DEFAULT_CURRENCY).toBeUndefined();
    expect(process.env.JWT_SECRET).not.toBe('mine');
  });

  test('only an admin can set them; anyone else\'s save of them is ignored', async () => {
    await save({ ...GOOD, DEFAULT_CURRENCY: 'USD' }, member).expect(200);
    expect(process.env.SMTP_HOST).toBeUndefined();
    expect(fs.existsSync(envFile)).toBe(false);
    expect(users.getUserConfig(member.id).DEFAULT_CURRENCY).toBe('USD');
  });

  describe('POST /test/email', () => {
    test("sends a test to the admin's own address", async () => {
      await save(GOOD).expect(200);
      const res = await testEmail().expect(200);
      expect(res.body).toEqual({ success: true, message: 'Test email sent to ada@firm.test — check the inbox (and spam).' });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        from: { name: 'Acme Books', address: 'robot@firm.test' }, to: [{ address: 'ada@firm.test' }], subject: 'Test email from Financial Automation',
      });
      expect(sent[0].text).toContain('https://app.firm.test');
    });

    test('says so when email is not set up, and sends nothing', async () => {
      const res = await testEmail().expect(400);
      expect(res.body).toMatchObject({ success: false, message: expect.stringMatching(/not set up/) });
      expect(sent).toEqual([]);
    });

    test("a send that fails is a 400 with the server's words, never the password", async () => {
      await save(GOOD).expect(200);
      jest.spyOn(require('../utils/logger'), 'warn').mockImplementation(() => {});
      mailer._setTransportForTests({ sendMail: async () => { throw new Error('Invalid login: 535-5.7.8 Username and Password not accepted (abcd efgh ijkl mnop)'); } });
      const res = await testEmail().expect(400);
      expect(res.body).toEqual({
        success: false,
        message: 'Invalid login: 535-5.7.8 Username and Password not accepted ([password])',
        error:   'Invalid login: 535-5.7.8 Username and Password not accepted ([password])',
      });
    });

    test('admins only', async () => {
      await save(GOOD).expect(200);
      await testEmail(member).expect(403);
      expect(sent).toEqual([]);
    });
  });
});
