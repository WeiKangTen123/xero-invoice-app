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
    await users.setPassword(user.id, 'new-password-2026');
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

  // The session rules reach this route too, since it asks sessionUser: a
  // session twelve hours old is over, and a token naming no session is
  // refused on a server.
  test('a Bearer token whose session began more than twelve hours ago is refused; a token with no session too', async () => {
    const sessions = require('../utils/sessions');
    const db  = require('../db');
    const sid = sessions.startSession(user.id);
    const of  = s => jwt.sign({ id: user.id, email: user.email, role: user.role, sid: s }, jwtSecret(), { expiresIn: '2h' });
    await withBearer(of(sid)).expect(200);
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 12 * 60 * 60 * 1000 - 60000).toISOString(), sid);
    const old = await withBearer(of(sid)).expect(401);
    expect(old.body.error).toBe('Your session ended 12 hours after you signed in. Sign in again.');

    // As a server runs: production, with a secret of its own.
    const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };
    process.env.NODE_ENV   = 'production';
    process.env.JWT_SECRET = 'a-real-secret-for-this-test-0123456789abcdef';
    try {
      const none = await withBearer(sessionToken(user)).expect(401);
      expect(none.body.error).toBe('Your session has ended. Sign in again.');
      await withBearer(of(sessions.startSession(user.id))).expect(200);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  // requireAuth's other check: an account that must choose a new password
  // (a temporary one from an admin) gets nothing else, and that includes PDFs.
  test('an account that must choose a new password first is refused, with the code that opens the form', async () => {
    const token = sessionToken(user);
    users.requirePasswordChange(user.id);
    const res = await withBearer(token).expect(403);
    expect(res.body.code).toBe('password_change_required');
  });

  // And the 2-step gate: an admin who has not turned 2-step sign-in on gets
  // nothing else either (auth-middleware.js accessGate).
  test('an admin who must set up 2-step sign-in first is refused, with the code that opens the set-up', async () => {
    const before = process.env.MFA_REQUIRED_FOR_ADMINS;
    process.env.MFA_REQUIRED_FOR_ADMINS = 'true';
    try {
      const admin = await users.createUser(`pdfadmin${Date.now()}@test.com`, 'password123', 'admin');
      require('../utils/pdf-store').forUser(admin.id).save('inv1', PDF);
      const res = await withBearer(sessionToken(admin)).expect(403);
      expect(res.body.code).toBe('mfa_setup_required');
      // The same admin with the gate off gets the PDF, so it was the gate.
      process.env.MFA_REQUIRED_FOR_ADMINS = 'false';
      await withBearer(sessionToken(admin)).expect(200);
    } finally {
      if (before === undefined) delete process.env.MFA_REQUIRED_FOR_ADMINS;
      else process.env.MFA_REQUIRED_FOR_ADMINS = before;
    }
  });
});
