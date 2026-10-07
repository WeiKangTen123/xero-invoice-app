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
