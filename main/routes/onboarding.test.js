// GET /api/onboarding and POST /api/onboarding/notice: the privacy notice
// every account reads once (and again when its words change), who it names
// as the person to ask, and the "Get set up" checklist's four steps. Real
// router, users and database; the watcher's state is the only thing stood in.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/onboarding', () => {
  let app, db, users, onboarding, registry, jwtSecret;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.PRIVACY_CONTACT_EMAIL;
    delete process.env.Gemini_API_KEY;
    require('../db/migrate').run();
    db         = require('../db');
    users      = require('../utils/users');
    onboarding = require('../utils/onboarding');
    registry   = require('../email/watcher-registry');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/onboarding', require('./onboarding'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  let seq = 0;
  const make = (role = 'user', opts = {}) => users.createUser(`p${seq++}@gmail.com`, 'password123', role, opts);
  const auth = u => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const get  = u => request(serverFor(app)).get('/api/onboarding').set('Authorization', auth(u));
  const ack  = (u, body) => request(serverFor(app)).post('/api/onboarding/notice').set('Authorization', auth(u)).send(body);
  const events = u => db.prepare("SELECT * FROM admin_events WHERE action = 'notice.acknowledged' AND actor_id = ?").all(String(u.id));

  test('signed out is refused', async () => {
    await request(serverFor(app)).get('/api/onboarding').expect(401);
    await request(serverFor(app)).post('/api/onboarding/notice').send({ version: 1 }).expect(401);
  });

  describe('the privacy notice', () => {
    test('required for a new account; once acknowledged, no longer; the time, version and an audit event are kept', async () => {
      const u = await make();
      const before = await get(u).expect(200);
      expect(before.body.notice).toMatchObject({ required: true, version: 1 });

      const at = Date.now();
      await ack(u, { version: 1 }).expect(200, { success: true });

      const after = await get(u).expect(200);
      expect(after.body.notice.required).toBe(false);
      const row = db.prepare('SELECT notice_version, notice_seen_at FROM user_onboarding WHERE user_id = ?').get(String(u.id));
      expect(row.notice_version).toBe(1);
      expect(Date.parse(row.notice_seen_at)).toBeGreaterThanOrEqual(at - 1000);
      const ev = events(u);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actor_email: u.email, target_user_id: String(u.id) });
      expect(JSON.parse(ev[0].details)).toEqual({ version: 1 });
    });

    test('pressing it again keeps the first time and records no second event', async () => {
      const u = await make();
      await ack(u, { version: 1 }).expect(200);
      const first = db.prepare('SELECT notice_seen_at FROM user_onboarding WHERE user_id = ?').get(String(u.id)).notice_seen_at;
      await new Promise(r => setTimeout(r, 5));
      await ack(u, { version: 1 }).expect(200, { success: true });
      expect(db.prepare('SELECT notice_seen_at FROM user_onboarding WHERE user_id = ?').get(String(u.id)).notice_seen_at).toBe(first);
      expect(events(u)).toHaveLength(1);
    });

    test('each account reads it for itself', async () => {
      const a = await make(), b = await make();
      await ack(a, { version: 1 }).expect(200);
      expect((await get(b)).body.notice.required).toBe(true);
    });

    test('a newer version asks again; the old one is refused as changed, the new one taken', async () => {
      const u = await make();
      await ack(u, { version: 1 }).expect(200);
      jest.spyOn(onboarding, 'currentNoticeVersion').mockReturnValue(2);

      const asked = await get(u).expect(200);
      expect(asked.body.notice).toMatchObject({ required: true, version: 2 });

      const stale = await ack(u, { version: 1 }).expect(409);
      expect(stale.body).toMatchObject({ code: 'NOTICE_CHANGED', version: 2 });
      expect(stale.body.error).toMatch(/reload the page/i);
      expect((await get(u)).body.notice.required).toBe(true);

      await ack(u, { version: 2 }).expect(200);
      expect((await get(u)).body.notice.required).toBe(false);
      expect(events(u).map(e => JSON.parse(e.details).version)).toEqual([1, 2]);
    });

    test('a version that is not a number, or one not issued yet, is refused and nothing is recorded', async () => {
      const u = await make();
      for (const body of [{}, { version: 'one' }, { version: 0 }, { version: 2 }, { version: 1.5 }]) {
        const res = await ack(u, body).expect(400);
        expect(res.body.error).toBe('version must be 1');
      }
      expect((await get(u)).body.notice.required).toBe(true);
      expect(events(u)).toHaveLength(0);
    });

    test('a failed record is a failed request, and the notice is asked again', async () => {
      const u = await make();
      jest.spyOn(onboarding, 'acknowledgeNotice').mockImplementation(() => { throw new Error('disk full'); });
      const failing = express();
      failing.use(express.json());
      failing.use('/api/onboarding', require('./onboarding'));
      failing.use((err, req, res, next) => res.status(500).json({ error: 'Internal server error' }));
      await request(serverFor(failing)).post('/api/onboarding/notice').set('Authorization', auth(u)).send({ version: 1 }).expect(500);
      expect((await get(u)).body.notice.required).toBe(true);
    });
  });

  describe('who the notice names (contact)', () => {
    test('the address set in Setup, when there is one', async () => {
      const u = await make('admin');
      process.env.PRIVACY_CONTACT_EMAIL = ' privacy@firm.example ';
      expect((await get(u)).body.notice.contact).toBe('privacy@firm.example');
    });

    test('else the admin who signed in most recently, passing over a disabled one and anyone not an admin', async () => {
      const older    = await make('admin');
      const newer    = await make('admin');
      const disabled = await make('admin');
      const member   = await make('user');
      users.recordSuccessfulLogin(older.id, Date.parse('2026-10-01T00:00:00Z'));
      users.recordSuccessfulLogin(newer.id, Date.parse('2026-10-20T00:00:00Z'));
      users.recordSuccessfulLogin(disabled.id, Date.parse('2026-10-21T00:00:00Z'));
      users.recordSuccessfulLogin(member.id, Date.parse('2026-10-22T00:00:00Z'));
      users.setDisabled(disabled.id, true);
      expect((await get(member)).body.notice.contact).toBe(newer.email);
    });

    test('an admin who never signed in beats no one; with no admin at all it is null', async () => {
      const member = await make('user');
      expect((await get(member)).body.notice.contact).toBeNull();
      const admin = await make('admin');
      expect((await get(member)).body.notice.contact).toBe(admin.email);
    });
  });

  describe('the checklist', () => {
    const KEYS = ['llm', 'mailbox', 'xero', 'watcher'];

    test('an account with nothing set up: four steps, none done', async () => {
      const u = await make();
      const { body } = await get(u).expect(200);
      expect(Object.keys(body.checklist)).toEqual(KEYS);
      expect(body.checklist).toEqual({
        llm:     { done: false, detail: 'No key yet' },
        mailbox: { done: false, detail: 'Not set up yet' },
        xero:    { done: false, detail: 'Not connected' },
        watcher: { done: false, detail: 'Off' },
      });
      expect(body.demo).toBe(false);
    });

    test('partly set up: a key that passed its test is done; a mailbox not yet tested, and a failed Xero test, are not', async () => {
      const u = await make();
      users.addGeminiKey(u.id, 'AIzaFirstKey-0123456789', 'main');
      users.addGeminiKey(u.id, 'AIzaSecondKey-0123456789', 'spare');
      users.saveUserConfig(u.id, { IMAP_PASS: 'app-pw', XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'secret' });
      onboarding.recordTest(u.id, 'llm', { ok: true, message: 'LLM API connected successfully', at: '2026-10-22T03:00:00Z' });
      onboarding.recordTest(u.id, 'xero', { ok: false, message: 'Xero refused the client ID' });

      const { body } = await get(u).expect(200);
      expect(body.checklist.llm).toEqual({ done: true, detail: '2 keys · tested 22 Oct' });
      expect(body.checklist.mailbox).toEqual({ done: false, detail: `${u.email} · not tested yet` });
      expect(body.checklist.xero).toEqual({ done: false, detail: 'Last test failed: Xero refused the client ID' });
      expect(body.checklist.watcher).toEqual({ done: false, detail: 'Off' });
    });

    test("the date is the account's own day: late on the 21st in UTC is the 22nd in Singapore, the 21st in New York", async () => {
      const u = await make();
      users.addGeminiKey(u.id, 'AIzaFirstKey-0123456789');
      onboarding.recordTest(u.id, 'llm', { ok: true, at: '2026-10-21T20:00:00Z' });
      expect((await get(u)).body.checklist.llm.detail).toBe('1 key · tested 22 Oct');
      users.saveUserConfig(u.id, { TIMEZONE: 'America/New_York' });
      expect((await get(u)).body.checklist.llm.detail).toBe('1 key · tested 21 Oct');
    });

    test("a failed key test is said with its reason; the server's shared key counts as a key", async () => {
      const u = await make();
      process.env.Gemini_API_KEY = 'AIzaServerKey-0123456789';
      expect((await get(u)).body.checklist.llm).toEqual({ done: false, detail: 'Shared key · not tested yet' });
      onboarding.recordTest(u.id, 'llm', { ok: false, message: 'API key not valid' });
      expect((await get(u)).body.checklist.llm).toEqual({ done: false, detail: 'Last test failed: API key not valid' });
    });

    test('a demo account: Xero is the sample data, done; the rest is its own to set up', async () => {
      const u = await make('user', { demo: true });
      const { body } = await get(u).expect(200);
      expect(body.demo).toBe(true);
      expect(body.checklist.xero).toEqual({ done: true, detail: 'Sample data' });
      expect(body.checklist.mailbox.done).toBe(false);
      expect(body.checklist.watcher.done).toBe(false);
    });

    test('all done: each step works, and Xero names the company connected', async () => {
      const u = await make();
      users.addGeminiKey(u.id, 'AIzaFirstKey-0123456789');
      users.saveUserConfig(u.id, { IMAP_PASS: 'app-pw', XERO_CONNECTION_TYPE: 'custom', XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'secret' });
      db.prepare('INSERT INTO xero_tenants (user_id, tenant_id, tenant_name, connected_at) VALUES (?, ?, ?, ?)')
        .run(String(u.id), 't-1', 'Acme Pte Ltd', new Date().toISOString());
      const at = '2026-10-22T03:00:00Z';
      onboarding.recordTest(u.id, 'llm', { ok: true, at });
      onboarding.recordTest(u.id, 'imap', { ok: true, at });
      jest.spyOn(registry, 'isRunning').mockImplementation(id => String(id) === String(u.id));

      const { body } = await get(u).expect(200);
      expect(body.checklist).toEqual({
        llm:     { done: true, detail: '1 key · tested 22 Oct' },
        mailbox: { done: true, detail: `${u.email} · tested 22 Oct` },
        xero:    { done: true, detail: 'Acme Pte Ltd' },
        watcher: { done: true, detail: 'On' },
      });
    });

    test('an OAuth connection counts as Xero done without any Test; several companies are counted', async () => {
      const u = await make();
      users.saveUserConfig(u.id, {
        XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret', XERO_OAUTH_REFRESH_TOKEN: 'rt',
      });
      const ins = db.prepare('INSERT INTO xero_tenants (user_id, tenant_id, tenant_name, connected_at) VALUES (?, ?, ?, ?)');
      ins.run(String(u.id), 't-1', 'Acme Pte Ltd', '2026-10-01T00:00:00Z');
      ins.run(String(u.id), 't-2', 'Acme Holdings', '2026-10-02T00:00:00Z');
      expect((await get(u)).body.checklist.xero).toEqual({ done: true, detail: 'Acme Pte Ltd + 1 more' });
    });

    test('a connection Xero has stopped accepting is not done, and says so', async () => {
      const u = await make();
      users.saveUserConfig(u.id, { XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret' });
      db.prepare('INSERT INTO xero_tenants (user_id, tenant_id, tenant_name, connected_at) VALUES (?, ?, ?, ?)')
        .run(String(u.id), 't-1', 'Acme Pte Ltd', '2026-10-01T00:00:00Z');
      expect((await get(u)).body.checklist.xero).toEqual({ done: false, detail: 'Needs reconnecting' });
    });

    test('a checklist that cannot be read is null; the notice is still answered', async () => {
      const u = await make();
      jest.spyOn(onboarding, 'checklist').mockImplementation(() => { throw new Error('boom'); });
      const { body } = await get(u).expect(200);
      expect(body.checklist).toBeNull();
      expect(body.notice.required).toBe(true);
    });
  });
});
