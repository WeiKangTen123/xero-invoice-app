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
