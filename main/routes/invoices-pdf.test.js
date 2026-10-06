const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// GET /api/invoices/:id/pdf reads its own credentials, because a browser
// opening a PDF in a tab or iframe cannot send an Authorization header. Its
// Bearer path used to be a bare jwt.verify, so it served PDFs to a disabled
// account and to tokens a password reset or "sign out everywhere" had revoked.
describe('GET /api/invoices/:id/pdf — who may read it', () => {
  let app, users, jwtSecret, user;
  const PDF = Buffer.from('%PDF-1.4 test');

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/invoices', require('./invoices'));
    user = await users.createUser(`pdf${Date.now()}@test.com`, 'password123', 'user');
    require('../utils/pdf-store').forUser(user.id).save('inv1', PDF);
  });

  // A token that must be refused is minted a little in the past (see
  // admin.test.js): one from the cutoff's own second is meant to survive it.
  const sessionToken = (u, secondsAgo = 0) =>
    jwt.sign({ id: u.id, email: u.email, role: u.role, iat: Math.floor(Date.now() / 1000) - secondsAgo }, jwtSecret());
  const linkToken = u => jwt.sign({ userId: u.id, invoiceId: 'inv1', purpose: 'pdf' }, jwtSecret(), { expiresIn: '5m' });
  const withBearer = token => request(serverFor(app)).get('/api/invoices/inv1/pdf').set('Authorization', `Bearer ${token}`);
  const withLink   = token => request(serverFor(app)).get(`/api/invoices/inv1/pdf?token=${token}`);

  test('a current session gets the PDF, by Bearer token or by link', async () => {
    const res = await withBearer(sessionToken(user)).expect(200).expect('Content-Type', /application\/pdf/);
    expect(Buffer.from(res.body).toString()).toBe(PDF.toString());
    await withLink(linkToken(user)).expect(200);
  });

  test('no token, or a forged one, is refused as before', async () => {
    const none = await request(serverFor(app)).get('/api/invoices/inv1/pdf').expect(401);
    expect(none.body.error).toBe('Authentication required');
    const forged = await withBearer(jwt.sign({ id: user.id }, 'not-the-secret')).expect(401);
    expect(forged.body.error).toBe('Invalid or expired token');
  });

  test('a Bearer token from before the sign-out cutoff is refused', async () => {
    const stale = sessionToken(user, 5);
    await withBearer(stale).expect(200);
    users.invalidateSessions(user.id);
    const res = await withBearer(stale).expect(401);
    expect(res.body.error).toMatch(/signed out/i);
  });

  test('a Bearer token from before a password reset is refused', async () => {
    const stale = sessionToken(user, 5);
    await users.setPassword(user.id, 'newpassword1');
    await withBearer(stale).expect(401);
  });

  test("a disabled account's Bearer token is refused", async () => {
    const token = sessionToken(user);
    users.setDisabled(user.id, true);
    const res = await withBearer(token).expect(401);
    expect(res.body.error).toMatch(/disabled/i);
  });

  test("a deleted account's Bearer token is refused", async () => {
    const token = sessionToken(user);
    users.deleteUser(user.id);
    await withBearer(token).expect(401);
  });

  test('a five-minute link minted before the account was disabled stops working', async () => {
    const link = linkToken(user);
    await withLink(link).expect(200);
    users.setDisabled(user.id, true);
    await withLink(link).expect(401);
  });
});
