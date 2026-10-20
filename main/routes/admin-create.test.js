// POST /api/admin/users with `demo` and `copyFrom`: the new account is a
// demo one when asked, the admin's own LLM keys, posting defaults and mailbox
// are copied onto it group by group, the mailbox needs a sender filter of
// its own, no Xero credential ever goes across, and the audit event says
// what was done without a value in it. Real routes, users and database.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

const DEFAULTS = {
  DEFAULT_ACCOUNT_CODE: '429', DEFAULT_CURRENCY: 'SGD', ZERO_TAX_RATE: 'NONE', CLAIM_PAYEE_NAME: 'Ada Admin',
  MILEAGE_RATE: '0.60', MILEAGE_ACCOUNT_CODE: '493', PER_DIEM_RATE: '75.00', PER_DIEM_ACCOUNT_CODE: '494', TIMEZONE: 'Asia/Singapore',
};
const XERO = {
  XERO_CLIENT_ID: 'cc-id', XERO_CLIENT_SECRET: 'cc-secret', XERO_CONNECTION_TYPE: 'oauth',
  XERO_OAUTH_CLIENT_ID: 'oauth-id', XERO_OAUTH_CLIENT_SECRET: 'oauth-secret', XERO_OAUTH_REFRESH_TOKEN: 'rt-live',
  XERO_OAUTH_CONNECTED_AT: '2026-01-01T00:00:00.000Z',
};
const MAILBOX = { IMAP_PASS: 'app-pass', IMAP_FILTER_FROM: 'bills@vendor.test', IMAP_LOOKBACK_DAYS: '30' };

describe('POST /api/admin/users — demo accounts and copied settings', () => {
  let app, users, auditLog, jwtSecret, admin;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users    = require('../utils/users');
    auditLog = require('../utils/audit-log');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/admin', require('./admin'));
    // A Gmail admin with every group set up: the mailbox host, user and
    // port left to be worked out from the address, as most are.
    admin = await users.createUser('ada@gmail.com', 'password1234', 'auto');
    users.saveUserConfig(admin.id, { ...DEFAULTS, ...XERO, ...MAILBOX, Gemini_API_KEY: 'legacy-gemini-key' });
    users.addGeminiKey(admin.id, 'gemini-key-one', 'first');
    users.addGeminiKey(admin.id, 'gemini-key-two', null);
  });

  const auth = () => `Bearer ${jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, jwtSecret())}`;
  const create = body => request(serverFor(app)).post('/api/admin/users').set('Authorization', auth())
    .send({ email: 'new@outlook.com', password: 'Temp-pass-2026-x', role: 'user', ...body });
  const configOf = id => users.getUserConfig(id);
  const lastEvent = () => auditLog.listAdminEvents({ action: 'user.create', limit: 1 }).events[0];

  test('a plain create is a real account with nothing copied, as before', async () => {
    const res = await create({}).expect(201);
    expect(res.body).toMatchObject({ success: true, copied: [], user: { email: 'new@outlook.com', demo: false, mustChangePassword: true } });
    expect(configOf(res.body.user.id)).toEqual({});
    expect(users.getGeminiKeys(res.body.user.id)).toEqual([]);
    expect(lastEvent()).toMatchObject({ targetEmail: 'new@outlook.com', details: { role: 'user', demo: false, copied: [] }, summary: 'Created new@outlook.com' });
  });

  test('demo: true makes a demo account, listed as one', async () => {
    const res = await create({ demo: true }).expect(201);
    expect(res.body.user.demo).toBe(true);
    expect(users.isDemoUser(res.body.user.id)).toBe(true);
    const listed = await request(serverFor(app)).get('/api/admin/users').set('Authorization', auth()).expect(200);
    expect(listed.body.users.map(u => [u.email, u.demo])).toEqual([['ada@gmail.com', false], ['new@outlook.com', true]]);
    expect(lastEvent()).toMatchObject({ details: { demo: true, copied: [] }, summary: 'Created new@outlook.com as a demo account' });
  });

  test('demo must be a boolean', async () => {
    expect((await create({ demo: 'yes' }).expect(400)).body.error).toBe('demo must be true or false');
    expect(users.findByEmail('new@outlook.com')).toBeNull();
  });

  // A demo account's password is the admin's to choose and keep: it guards
  // sample data and is typed in front of people, so it may be short and it
  // is not temporary. Any other account's, an admin's on sample data
  // included, stays twelve characters and temporary.
  test('a demo account takes a short, permanent password; a real account does not', async () => {
    const res = await create({ email: 'demo@gmail.com', password: 'demo123', demo: true }).expect(201);
    expect(res.body.user).toMatchObject({ email: 'demo@gmail.com', demo: true, mustChangePassword: false });
    expect(users.findByEmail('demo@gmail.com')).toMatchObject({ must_change_password: 0, temp_password_expires_at: null });
    expect(await users.validatePassword('demo@gmail.com', 'demo123')).toMatchObject({ email: 'demo@gmail.com' });
    expect((await create({ password: 'demo123' }).expect(400)).body.error).toBe('Password must be at least 12 characters');
    expect((await create({ email: 'demo2@gmail.com', password: 'demo1', demo: true }).expect(400)).body.error).toBe('Password must be at least 6 characters');
  });

  test('a reset on a demo account is permanent and may be short; on a real account temporary', async () => {
    const demo = (await create({ email: 'demo@gmail.com', password: 'demo123', demo: true }).expect(201)).body.user;
    const real = (await create({}).expect(201)).body.user;
    const reset = (id, password) => request(serverFor(app)).patch(`/api/admin/users/${id}/password`).set('Authorization', auth()).send({ password });
    await reset(demo.id, 'demo456').expect(200);
    expect(users.findByEmail('demo@gmail.com')).toMatchObject({ must_change_password: 0, temp_password_expires_at: null });
    expect(await users.validatePassword('demo@gmail.com', 'demo456')).toMatchObject({ email: 'demo@gmail.com' });
    expect((await reset(real.id, 'demo456').expect(400)).body.error).toBe('Password must be at least 12 characters');
    await reset(real.id, 'Another-temp-2026').expect(200);
    expect(users.findByEmail('new@outlook.com').must_change_password).toBe(1);
  });

  // An admin can switch to real Xero (PUT /api/setup/data-source) and
  // manages every account, so one made on sample data keeps the full rule
  // and a temporary password, as any other account does.
  test('an admin made on sample data needs the full-length password, and it is temporary', async () => {
    expect((await create({ email: 'boss@gmail.com', password: 'demo123', role: 'admin', demo: true }).expect(400)).body.error)
      .toBe('Password must be at least 12 characters');
    expect(users.findByEmail('boss@gmail.com')).toBeNull();
    const res = await create({ email: 'boss@gmail.com', password: 'Temp-pass-2026-x', role: 'admin', demo: true }).expect(201);
    expect(res.body.user).toMatchObject({ email: 'boss@gmail.com', role: 'admin', demo: true, mustChangePassword: true });
    expect(users.findByEmail('boss@gmail.com').temp_password_expires_at).not.toBeNull();
  });

  test('a reset of an admin on sample data is full-length and temporary', async () => {
    const other = (await create({ email: 'boss@gmail.com', role: 'admin' }).expect(201)).body.user;
    users.setDemo(other.id, true);
    const reset = password => request(serverFor(app)).patch(`/api/admin/users/${other.id}/password`).set('Authorization', auth()).send({ password });
    expect((await reset('demo456').expect(400)).body.error).toBe('Password must be at least 12 characters');
    await reset('Another-temp-2026').expect(200);
    expect(users.findByEmail('boss@gmail.com')).toMatchObject({ is_demo: 1, must_change_password: 1 });
    expect(users.findByEmail('boss@gmail.com').temp_password_expires_at).not.toBeNull();
  });

  test('copyFrom.llm copies the legacy key and every key of the list', async () => {
    const res = await create({ copyFrom: { llm: true } }).expect(201);
    expect(res.body.copied).toEqual(['llm']);
    expect(configOf(res.body.user.id)).toEqual({ Gemini_API_KEY: 'legacy-gemini-key' });
    expect(users.getGeminiKeys(res.body.user.id).map(k => [k.apiKey, k.label])).toEqual([['gemini-key-one', 'first'], ['gemini-key-two', null]]);
  });

  test('copyFrom.defaults copies the posting defaults, the claim settings and the timezone', async () => {
    const res = await create({ copyFrom: { defaults: true } }).expect(201);
    expect(res.body.copied).toEqual(['defaults']);
    expect(configOf(res.body.user.id)).toEqual(DEFAULTS);
  });

  test('copyFrom.mailbox copies the mailbox as the admin\'s watcher resolves it, with the new account\'s own sender filter', async () => {
    const res = await create({ copyFrom: { mailbox: true }, mailboxFilterFrom: ' receipts@vendor.test ' }).expect(201);
    expect(res.body.copied).toEqual(['mailbox']);
    // Host, user and port were blank on the admin and worked out from
    // ada@gmail.com; copied blank they would be worked out from
    // new@outlook.com, a different mailbox. The admin's own filter is not
    // the new account's.
    expect(configOf(res.body.user.id)).toEqual({
      IMAP_HOST: 'imap.gmail.com', IMAP_PORT: '993', IMAP_USER: 'ada@gmail.com', IMAP_PASS: 'app-pass',
      IMAP_LOOKBACK_DAYS: '30', IMAP_FILTER_FROM: 'receipts@vendor.test',
    });
    expect(users.getImapSettings(res.body.user.id)).toMatchObject({ host: 'imap.gmail.com', user: 'ada@gmail.com', ready: true, filterFrom: 'receipts@vendor.test' });
  });

  test('the mailbox cannot be copied without a sender filter, and says why', async () => {
    for (const body of [{ copyFrom: { mailbox: true } }, { copyFrom: { mailbox: true }, mailboxFilterFrom: '   ' }]) {
      const res = await create(body).expect(400);
      expect(res.body.error).toMatch(/sender filter is required/i);
      expect(res.body.error).toMatch(/different senders/i);
      expect(res.body.error).toMatch(/marks an email it has processed as read/i);
    }
    expect(users.findByEmail('new@outlook.com')).toBeNull();
    // The filter alone is not a mailbox copy: without the group it is ignored.
    const res = await create({ mailboxFilterFrom: 'x@y.test' }).expect(201);
    expect(configOf(res.body.user.id)).toEqual({});
  });

  test('every group at once, on a demo account: nothing of Xero goes across, and the audit event names the groups and no value', async () => {
    const res = await create({ demo: true, copyFrom: { llm: true, defaults: true, mailbox: true }, mailboxFilterFrom: 'receipts@vendor.test' }).expect(201);
    expect(res.body.copied).toEqual(['llm', 'defaults', 'mailbox']);
    const config = configOf(res.body.user.id);
    expect(Object.keys(config).filter(k => k.startsWith('XERO'))).toEqual([]);
    expect(config).toMatchObject({ ...DEFAULTS, Gemini_API_KEY: 'legacy-gemini-key', IMAP_PASS: 'app-pass', IMAP_FILTER_FROM: 'receipts@vendor.test' });
    expect(users.getSetupStatus(res.body.user.id)).toMatchObject({ ready: true, missingConfig: [] });

    const event = lastEvent();
    expect(event.details).toEqual({ role: 'user', demo: true, copied: ['llm', 'defaults', 'mailbox'] });
    expect(event.summary).toBe('Created new@outlook.com as a demo account with the llm, defaults, mailbox settings copied');
    for (const secret of ['app-pass', 'legacy-gemini-key', 'gemini-key-one', 'cc-secret', 'oauth-secret', 'rt-live']) {
      expect(JSON.stringify(event)).not.toContain(secret);
    }
    // The admin's own settings are untouched.
    expect(configOf(admin.id)).toMatchObject({ ...DEFAULTS, ...XERO, ...MAILBOX });
  });

  test('a group the admin has nothing in is not reported as copied', async () => {
    users.saveUserConfig(admin.id, Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, ''])));
    const res = await create({ copyFrom: { defaults: true, llm: true } }).expect(201);
    expect(res.body.copied).toEqual(['llm']);
    expect(configOf(res.body.user.id)).toEqual({ Gemini_API_KEY: 'legacy-gemini-key' });
  });

  test('copyFrom that is not an object, or names no group, copies nothing', async () => {
    for (const copyFrom of ['llm', ['llm'], { xero: true }, { llm: 'true' }]) {
      const res = await create({ copyFrom }).expect(201);
      expect(res.body.copied).toEqual([]);
      expect(configOf(res.body.user.id)).toEqual({});
      users.deleteUser(res.body.user.id);
    }
  });
});
