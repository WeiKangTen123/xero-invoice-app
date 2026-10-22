// Setup's Test LLM, Test IMAP and Test Xero keep their outcome for the "Get
// set up" checklist (utils/onboarding.js), and a save that changes the
// settings a result was about forgets it. The privacy contact is a
// server-wide setting an admin sets here. Real route, users and database;
// the Gemini call, the mail server and Xero are stand-ins.
jest.mock('axios');
jest.mock('../email/llm-parser', () => ({ extractWithRetry: jest.fn() }));

// node-imap, answering the next connect with whatever `mockImapOutcome` says.
let mockImapOutcome = 'ready';
jest.mock('imap', () => {
  const EventEmitter = require('events');
  class FakeImap extends EventEmitter {
    connect() {
      setImmediate(() => (mockImapOutcome === 'ready' ? this.emit('ready') : this.emit('error', new Error(mockImapOutcome))));
    }
    end() {}
  }
  return jest.fn(() => new FakeImap());
});

const fs      = require('fs');
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/setup — Test results and the privacy contact', () => {
  let app, users, onboarding, llm, axios, jwtSecret, user;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockImapOutcome = 'ready';
    delete process.env.PRIVACY_CONTACT_EMAIL;
    try { fs.unlinkSync(process.env.ENV_FILE); } catch (_) { /* none yet */ }
    require('../db/migrate').run();
    users      = require('../utils/users');
    onboarding = require('../utils/onboarding');
    llm        = require('../email/llm-parser');
    axios      = require('axios');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/setup', require('./setup'));
    user = await users.createUser('t@gmail.com', 'password123', 'user');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  const auth = (u = user) => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const test_ = (kind, u = user) => request(serverFor(app)).post(`/api/setup/test/${kind}`).set('Authorization', auth(u));
  const save  = (body, u = user) => request(serverFor(app)).post('/api/setup').set('Authorization', auth(u)).send(body);
  const last  = kind => onboarding.lastTest(user.id, kind);

  describe('Test LLM', () => {
    test('a pass is kept as passed, with when', async () => {
      llm.extractWithRetry.mockResolvedValue({});
      const at = Date.now();
      await test_('llm').expect(200);
      expect(last('llm')).toMatchObject({ ok: true, message: 'LLM API connected successfully' });
      expect(Date.parse(last('llm').checkedAt)).toBeGreaterThanOrEqual(at - 1000);
    });

    test('a failure is kept with its reason, on one line and never with a key in it', async () => {
      llm.extractWithRetry.mockRejectedValue(new Error('API key not valid:\n AIzaSyD-secret0123456789 was refused'));
      const res = await test_('llm').expect(400);
      expect(res.body.success).toBe(false);
      expect(last('llm')).toMatchObject({ ok: false, message: 'API key not valid: AIza… was refused' });
    });
  });

  describe('Test IMAP', () => {
    test('a mailbox not set up is kept as a failed test', async () => {
      await test_('imap').expect(400);
      expect(last('imap')).toMatchObject({ ok: false, message: expect.stringMatching(/^Mailbox not configured/) });
    });

    test('a connection that works is kept as passed; one refused, as failed with why', async () => {
      users.saveUserConfig(user.id, { IMAP_PASS: 'app-pw' });
      await test_('imap').expect(200);
      expect(last('imap')).toMatchObject({ ok: true, message: 'IMAP connected successfully' });
      mockImapOutcome = 'Invalid credentials (Failure)';
      await test_('imap').expect(400);
      expect(last('imap')).toMatchObject({ ok: false, message: 'Invalid credentials (Failure)' });
    });
  });

  describe('Test Xero', () => {
    beforeEach(() => {
      axios.post.mockResolvedValue({ data: { access_token: 'at', expires_in: 1800 } });
      axios.get.mockResolvedValue({ data: [{ tenantId: 't-1', tenantName: 'Org One' }] });
      users.saveUserConfig(user.id, { XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs' });
    });

    test('a Custom Connection that works is kept as passed', async () => {
      await test_('xero').expect(200);
      expect(last('xero')).toMatchObject({ ok: true, message: 'Xero connected successfully via Custom Connection' });
    });

    test('a refusal is kept as failed, with the message the button showed', async () => {
      axios.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { error: 'invalid_client' } },
      }));
      const res = await test_('xero').expect(400);
      expect(last('xero')).toMatchObject({ ok: false, message: res.body.message });
    });

    test('a demo account has nothing to test, and nothing is kept', async () => {
      const demo = await users.createUser('demo@gmail.com', 'password123', 'user', { demo: true });
      await test_('xero', demo).expect(400);
      expect(onboarding.lastTest(demo.id, 'xero')).toBeNull();
    });
  });

  test('a record that cannot be written never changes the answer', async () => {
    jest.spyOn(onboarding, 'recordTest').mockImplementation(() => { throw new Error('database is locked'); });
    llm.extractWithRetry.mockResolvedValue({});
    const res = await test_('llm').expect(200);
    expect(res.body).toEqual({ success: true, message: 'LLM API connected successfully' });
  });

  describe('a save that changes what was tested', () => {
    beforeEach(() => {
      users.saveUserConfig(user.id, { IMAP_PASS: 'app-pw', XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: 'cs' });
      for (const kind of ['llm', 'imap', 'xero']) onboarding.recordTest(user.id, kind, { ok: true, message: 'ok' });
    });

    test('a new mailbox password forgets the mailbox test only', async () => {
      await save({ IMAP_PASS: 'new-app-pw' }).expect(200);
      expect(last('imap')).toBeNull();
      expect(last('xero')).toMatchObject({ ok: true });
      expect(last('llm')).toMatchObject({ ok: true });
    });

    test('a new Custom Connection client ID forgets the Xero test only', async () => {
      await save({ XERO_CLIENT_ID: 'cc-2' }).expect(200);
      expect(last('xero')).toBeNull();
      expect(last('imap')).toMatchObject({ ok: true });
    });

    test('saving the same values again, a blank secret, or a setting no test is about keeps them all', async () => {
      await save({ XERO_CLIENT_ID: 'cc', XERO_CLIENT_SECRET: '', IMAP_PASS: '', IMAP_HOST: '', IMAP_FILTER_FROM: 'bills@supplier.com', TIMEZONE: 'Asia/Singapore' }).expect(200);
      for (const kind of ['llm', 'imap', 'xero']) expect(last(kind)).toMatchObject({ ok: true });
    });
  });

  describe('the privacy contact (server-wide, admin)', () => {
    let admin;
    beforeEach(async () => { admin = await users.createUser('boss@gmail.com', 'password123', 'admin'); });

    test('offered in its own section, with its label and hint; read-only to anyone but an admin', async () => {
      const mine = await request(serverFor(app)).get('/api/setup').set('Authorization', auth(admin)).expect(200);
      expect(mine.body.privacy.PRIVACY_CONTACT_EMAIL).toMatchObject({
        value: '', isSet: false, readOnly: false, label: 'Privacy contact email', hint: expect.stringMatching(/privacy notice/),
      });
      const theirs = await request(serverFor(app)).get('/api/setup').set('Authorization', auth()).expect(200);
      expect(theirs.body.privacy.PRIVACY_CONTACT_EMAIL.readOnly).toBe(true);
    });

    test('an admin sets it: saved to the env file and in use at once', async () => {
      await save({ PRIVACY_CONTACT_EMAIL: ' privacy@firm.example ' }, admin).expect(200);
      expect(process.env.PRIVACY_CONTACT_EMAIL).toBe('privacy@firm.example');
      expect(fs.readFileSync(process.env.ENV_FILE, 'utf8')).toContain('PRIVACY_CONTACT_EMAIL=privacy@firm.example');
      expect(onboarding.privacyContact()).toBe('privacy@firm.example');
    });

    test('something that is not an email address is refused', async () => {
      const res = await save({ PRIVACY_CONTACT_EMAIL: 'not an address' }, admin).expect(400);
      expect(res.body.errors).toEqual([{ field: 'PRIVACY_CONTACT_EMAIL', error: 'Privacy contact must be an email address, such as privacy@example.com' }]);
      expect(process.env.PRIVACY_CONTACT_EMAIL).toBeUndefined();
    });

    test('anyone else sending it changes nothing', async () => {
      await save({ PRIVACY_CONTACT_EMAIL: 'me@gmail.com' }).expect(200);
      expect(process.env.PRIVACY_CONTACT_EMAIL).toBeUndefined();
    });
  });
});
