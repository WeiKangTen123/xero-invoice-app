// Stored secrets never travel back to the browser. GET /api/setup used to
// return the raw client secret and IMAP password on every page load, and the
// page posted them back on save.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/setup — secrets', () => {
  let app, users, jwtSecret, user;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/setup', require('./setup'));
    user = await users.createUser('s@test.com', 'password123', 'auto');
  });

  const auth = () => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;
  const flat = body => Object.assign({}, ...Object.values(body));

  test('a stored secret is reported as set but its value is never returned', async () => {
    users.saveUserConfig(user.id, { IMAP_PASS: 'hunter2', IMAP_HOST: 'imap.test' });
    const { body } = await request(serverFor(app)).get('/api/setup').set('Authorization', auth()).expect(200);
    const all = flat(body);
    expect(all.IMAP_PASS).toMatchObject({ value: '', isSet: true });
    expect(all.IMAP_HOST).toMatchObject({ value: 'imap.test', isSet: true });
  });

  test('saving with a blank secret keeps the stored one; a new value replaces it', async () => {
    users.saveUserConfig(user.id, { IMAP_PASS: 'hunter2' });
    await request(serverFor(app)).post('/api/setup').set('Authorization', auth()).send({ IMAP_PASS: '', IMAP_HOST: 'imap.new' }).expect(200);
    expect(users.getUserConfig(user.id).IMAP_PASS).toBe('hunter2');
    expect(users.getUserConfig(user.id).IMAP_HOST).toBe('imap.new');
    await request(serverFor(app)).post('/api/setup').set('Authorization', auth()).send({ IMAP_PASS: 'new-pass' }).expect(200);
    expect(users.getUserConfig(user.id).IMAP_PASS).toBe('new-pass');
  });

  // A blank box with a grey "Saved" in it read as unset. A stored secret now
  // comes back as dots and its last four characters, enough to tell which one
  // it is, and the mailbox password says whose mailbox it opens. Never more.
  test('a stored secret comes back as dots and its last four characters, never in full', async () => {
    users.saveUserConfig(user.id, { IMAP_PASS: 'abcd efgh ijkl tqwz', XERO_OAUTH_CLIENT_SECRET: 'short-one' });
    const { body, text } = await request(serverFor(app)).get('/api/setup').set('Authorization', auth()).expect(200);
    const all = flat(body);
    expect(all.IMAP_PASS).toMatchObject({ value: '', isSet: true, masked: '••••••••••••tqwz', account: 's@test.com' });
    // Too short to spare four characters: dots only.
    expect(all.XERO_OAUTH_CLIENT_SECRET).toMatchObject({ value: '', isSet: true, masked: '••••••••••••' });
    expect(all.XERO_CLIENT_SECRET).toMatchObject({ isSet: false, masked: '' });
    expect(text).not.toContain('abcd efgh');
    expect(text).not.toContain('short-one');
    // A typed mailbox user is the account the password is for.
    users.saveUserConfig(user.id, { IMAP_USER: 'accounts@firm.test' });
    expect(flat((await request(serverFor(app)).get('/api/setup').set('Authorization', auth())).body).IMAP_PASS.account).toBe('accounts@firm.test');
  });

  // The old single-key field (Gemini_API_KEY) works but was never listed, so
  // an account running on it read "No API keys added yet".
  describe('the Gemini key list', () => {
    const keys = () => request(serverFor(app)).get('/api/setup/llm-keys').set('Authorization', auth()).expect(200).then(r => r.body);
    const saved = process.env.Gemini_API_KEY;
    afterEach(() => { if (saved === undefined) delete process.env.Gemini_API_KEY; else process.env.Gemini_API_KEY = saved; });

    test('lists the old single-field key, in use only while no key is added', async () => {
      users.saveUserConfig(user.id, { Gemini_API_KEY: 'AIzaLegacyKey0000Zz99' });
      expect(await keys()).toEqual({ serverKey: false, keys: [{ id: 'legacy', label: null, createdAt: null, keyMasked: 'AIza••••Zz99', legacy: true, inUse: true }] });
      users.addGeminiKey(user.id, 'AIzaAddedKey11111Ab12', 'main');
      const { keys: list } = await keys();
      expect(list.map(k => [k.id === 'legacy' ? 'legacy' : 'added', k.keyMasked, k.inUse])).toEqual([['added', 'AIza••••Ab12', true], ['legacy', 'AIza••••Zz99', false]]);
    });

    test('removing it clears the old field; removing it twice is not found', async () => {
      users.saveUserConfig(user.id, { Gemini_API_KEY: 'AIzaLegacyKey0000Zz99' });
      await request(serverFor(app)).delete('/api/setup/llm-keys/legacy').set('Authorization', auth()).expect(200);
      expect(users.getUserConfig(user.id).Gemini_API_KEY).toBeUndefined();
      expect((await keys()).keys).toEqual([]);
      await request(serverFor(app)).delete('/api/setup/llm-keys/legacy').set('Authorization', auth()).expect(404);
    });

    test('says when the server\'s shared key is what an account with none of its own runs on', async () => {
      delete process.env.Gemini_API_KEY;
      expect(await keys()).toEqual({ keys: [], serverKey: false });
      process.env.Gemini_API_KEY = 'AIzaServerShared000';
      expect(await keys()).toEqual({ keys: [], serverKey: true });
      users.addGeminiKey(user.id, 'AIzaAddedKey11111Ab12', null);
      expect((await keys()).serverKey).toBe(false);
    });

    test('a key added is listed straight away', async () => {
      await request(serverFor(app)).post('/api/setup/llm-keys').set('Authorization', auth()).send({ apiKey: 'AIzaNewKey2222222Cd34', label: 'second' }).expect(201);
      expect((await keys()).keys).toMatchObject([{ label: 'second', keyMasked: 'AIza••••Cd34', inUse: true }]);
    });
  });
});

// Six of the seven mailbox boxes can be worked out from the account, so the
// form should offer them rather than demand them. See email/imap-settings.js.
describe('routes/setup — mailbox settings the user should not have to type', () => {
  let app, users, jwtSecret, user;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/setup', require('./setup'));
    user = await users.createUser(`auto${Date.now()}@gmail.com`, 'password123', 'user');
  });

  const auth = () => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;
  const flat = body => Object.assign({}, ...Object.values(body));
  const get  = () => request(serverFor(app)).get('/api/setup').set('Authorization', auth()).expect(200);

  test('each automatic field reports the value a blank box will use', async () => {
    const { body } = await get();
    const all = flat(body);
    expect(all.IMAP_HOST).toMatchObject({ value: '', isSet: false, auto: 'imap.gmail.com' });
    expect(all.IMAP_USER.auto).toBe(user.email);
    expect(all.IMAP_PORT.auto).toBe('993');
    expect(all.IMAP_POLL_INTERVAL_MS.auto).toBe('60000');
    expect(all.IMAP_LOOKBACK_DAYS.auto).toBe('100');
  });

  test('the password and the sender filter have nothing to offer', async () => {
    const all = flat((await get()).body);
    expect(all.IMAP_PASS.auto).toBeNull();
    expect(all.IMAP_FILTER_FROM.auto).toBeNull();
  });

  test('a value that was typed is returned as the value, and stops being automatic', async () => {
    users.saveUserConfig(user.id, { IMAP_HOST: 'mail.example.com' });
    const all = flat((await get()).body);
    expect(all.IMAP_HOST).toMatchObject({ value: 'mail.example.com', isSet: true, auto: 'imap.gmail.com' });
  });
});

// Expense claims were posted as bills owed to the shop on the receipt. The
// claimant's own name, set here, is who Xero records the claim as owed to.
describe('routes/setup — the payee name for expense claims', () => {
  let app, users, jwtSecret, user;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/setup', require('./setup'));
    user = await users.createUser(`payee${Date.now()}@test.com`, 'password123', 'user');
  });

  const auth = () => `Bearer ${jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret())}`;

  test('appears in the defaults section with a plain label, and saves and clears', async () => {
    let { body } = await request(serverFor(app)).get('/api/setup').set('Authorization', auth()).expect(200);
    expect(body.defaults.CLAIM_PAYEE_NAME).toMatchObject({
      value: '', isSet: false, label: 'Your name for expense claims (the payee in Xero)',
    });

    await request(serverFor(app)).post('/api/setup').set('Authorization', auth()).send({ CLAIM_PAYEE_NAME: 'Jane Tan' }).expect(200);
    expect(users.getUserConfig(user.id).CLAIM_PAYEE_NAME).toBe('Jane Tan');
    ({ body } = await request(serverFor(app)).get('/api/setup').set('Authorization', auth()).expect(200));
    expect(body.defaults.CLAIM_PAYEE_NAME).toMatchObject({ value: 'Jane Tan', isSet: true });

    await request(serverFor(app)).post('/api/setup').set('Authorization', auth()).send({ CLAIM_PAYEE_NAME: '' }).expect(200);
    expect(users.getUserConfig(user.id).CLAIM_PAYEE_NAME).toBeUndefined();
  });
});
