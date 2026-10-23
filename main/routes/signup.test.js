// Sign-up: anyone may create an ordinary account from the sign-in page while
// an admin has Setup › Sign-up on (ALLOW_REGISTRATION). The switch is
// admin-only, takes 'true' or 'false', and works at once, with no restart;
// GET /auth/status says whether it is on, so the page offers "Create an
// account" only then; and an account made that way is a user, signed straight
// in. main/.env is never touched: ENV_FILE points at a file of the test's own
// (scripts/jest.setup.js).
const fs      = require('fs');
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('sign-up (Setup › Sign-up, /auth/register, /auth/status)', () => {
  let app, users, jwtSecret, admin, member, saved, envFile;

  beforeEach(async () => {
    jest.resetModules();
    saved = process.env.ALLOW_REGISTRATION;
    delete process.env.ALLOW_REGISTRATION;
    envFile = process.env.ENV_FILE;
    expect(envFile).toMatch(/test\.env$/);   // never the real main/.env
    fs.rmSync(envFile, { force: true });
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/setup', require('./setup'));
    app.use('/api/auth', require('./auth'));
    admin  = await users.createUser('ada@firm.test', 'Admin-pass-2026', 'admin');
    member = await users.createUser('mo@firm.test', 'Member-pass-2026', 'user');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOW_REGISTRATION; else process.env.ALLOW_REGISTRATION = saved;
    fs.rmSync(envFile, { force: true });
  });

  const bearer   = u => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const save     = (body, u = admin) => request(serverFor(app)).post('/api/setup').set('Authorization', bearer(u)).send(body);
  const status   = () => request(serverFor(app)).get('/api/auth/status').expect(200).then(r => r.body);
  const register = body => request(serverFor(app)).post('/api/auth/register').send(body);

  test('closed by default: the status says so, and a sign-up is refused', async () => {
    expect((await status()).signup).toBe(false);
    const res = await register({ email: 'new@firm.test', password: 'a-long-enough-one' }).expect(403);
    expect(res.body.error).toMatch(/disabled/i);
    expect(users.findByEmail('new@firm.test')).toBeNull();
  });

  test('an admin turns it on in Setup: at once, no restart; the status says so; a sign-up is a user, signed in', async () => {
    await save({ ALLOW_REGISTRATION: 'true' }).expect(200);
    expect(process.env.ALLOW_REGISTRATION).toBe('true');
    expect(fs.readFileSync(envFile, 'utf8')).toMatch(/^ALLOW_REGISTRATION=true$/m);
    expect((await status()).signup).toBe(true);

    const res = await register({ email: ' New@Firm.test ', password: 'a-long-enough-one' }).expect(201);
    expect(res.body.user).toMatchObject({ email: 'new@firm.test', role: 'user', mustChangePassword: false });
    expect(res.body.token).toEqual(expect.any(String));
    // The token it hands back is a working session.
    const me = await request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);
    expect(me.body.user).toMatchObject({ email: 'new@firm.test', role: 'user' });
  });

  test('the same rules as anywhere: a short password or a taken address is refused, plainly', async () => {
    await save({ ALLOW_REGISTRATION: 'true' }).expect(200);
    expect((await register({ email: 'new@firm.test', password: 'short' }).expect(400)).body.error)
      .toBe('Password must be at least 12 characters');
    expect((await register({ email: 'MO@firm.test', password: 'a-long-enough-one' }).expect(409)).body.error)
      .toBe('An account with this email already exists. Sign in instead.');
  });

  test('turned off again, it closes at once', async () => {
    await save({ ALLOW_REGISTRATION: 'true' }).expect(200);
    await save({ ALLOW_REGISTRATION: 'false' }).expect(200);
    expect((await status()).signup).toBe(false);
    await register({ email: 'late@firm.test', password: 'a-long-enough-one' }).expect(403);
  });

  test('the switch takes only on or off, and only from an admin', async () => {
    const bad = await save({ ALLOW_REGISTRATION: 'yes' }).expect(400);
    expect(bad.body.error).toBe('Sign-up must be on (true) or off (false)');
    await save({ ALLOW_REGISTRATION: 'TRUE' }).expect(200);
    expect(process.env.ALLOW_REGISTRATION).toBe('true');
    // A non-admin's save of a server-wide value is ignored, as for every other one.
    await save({ ALLOW_REGISTRATION: 'false' }, member).expect(200);
    expect(process.env.ALLOW_REGISTRATION).toBe('true');
  });

  test('Setup shows the switch to an admin, labelled, with what it does', async () => {
    const { body } = await request(serverFor(app)).get('/api/setup').set('Authorization', bearer(admin)).expect(200);
    expect(body.signup.ALLOW_REGISTRATION).toMatchObject({
      label: 'Let people create their own accounts',
      hint: expect.stringMatching(/Create an account/),
    });
  });
});
