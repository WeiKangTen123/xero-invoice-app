const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

describe('admin routes', () => {
  let app, users, jwtSecret, adminUser;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    const adminRoutes = require('./admin');

    adminUser = await users.createUser('admin@test.com', 'password123', 'auto'); // first user -> admin

    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
  });

  function tokenFor(user) {
    return jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
  }

  test('GET /users requires authentication', async () => {
    await request(app).get('/api/admin/users').expect(401);
  });

  test('GET /users returns all users for an admin', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].email).toBe('admin@test.com');
  });

  test('POST /users creates a new user', async () => {
    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ email: 'new@test.com', password: 'password123', role: 'user' })
      .expect(201);
    expect(res.body.user.email).toBe('new@test.com');
    expect(res.body.user.role).toBe('user');
  });

  test('DELETE /users/:id blocks deleting your own account', async () => {
    await request(app)
      .delete(`/api/admin/users/${adminUser.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(400);
  });

  test('GET /monitoring returns system + per-user stats', async () => {
    const res = await request(app)
      .get('/api/admin/monitoring')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(200);

    expect(res.body.system.totalUsers).toBe(1);
    expect(typeof res.body.system.uptimeSeconds).toBe('number');
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({
      email:          'admin@test.com',
      watcherRunning: false,
      xeroConnected:  false,
      imapConfigured: false,
    });
    expect(res.body.users[0].queue).toEqual({ pending: 0, processing: 0, dead: 0, jobs: [] });
    expect(res.body.users[0].invoices).toEqual({ pending: 0, submitting: 0, posted: 0, error: 0, reviewNeeded: 0 });
  });

  describe('GET /logs', () => {
    let logsDir, regularUser;

    beforeEach(async () => {
      // Point admin.js at a throwaway directory instead of the real logs/ folder
      // (which a running dev server may be actively appending to) — requires
      // resetModules + re-requiring admin.js so LOGS_DIR is re-evaluated.
      logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-logs-test-'));
      process.env.LOGS_DIR = logsDir;
      jest.resetModules();
      require('../db/migrate').run();
      users = require('../utils/users');
      ({ jwtSecret } = require('../middleware/auth-middleware'));
      const adminRoutes = require('./admin');

      adminUser   = await users.createUser('admin2@test.com', 'password123', 'auto');
      regularUser = await users.createUser('regular@test.com', 'password123', 'user');

      app = express();
      app.use(express.json());
      app.use('/api/admin', adminRoutes);

      const combinedLines = [
        { level: 'info',  message: 'Email watcher started', userId: 'user-123', timestamp: '2026-01-01T00:00:00.000Z' },
        { level: 'error', message: 'IMAP search error',      userId: 'user-456', timestamp: '2026-01-01T00:01:00.000Z' },
        { level: 'info',  message: 'Invoice marked as posted', userId: 'user-123', timestamp: '2026-01-01T00:02:00.000Z' },
      ].map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(path.join(logsDir, 'combined.log'), combinedLines);
      fs.writeFileSync(path.join(logsDir, 'error.log'), JSON.stringify({
        level: 'error', message: 'Failed to submit invoice to Xero', userId: 'user-456', timestamp: '2026-01-01T00:03:00.000Z',
      }) + '\n');
    });

    afterEach(() => {
      delete process.env.LOGS_DIR;
      fs.rmSync(logsDir, { recursive: true, force: true });
    });

    test('requires authentication', async () => {
      await request(app).get('/api/admin/logs').expect(401);
    });

    test('requires admin role', async () => {
      await request(app)
        .get('/api/admin/logs')
        .set('Authorization', `Bearer ${tokenFor(regularUser)}`)
        .expect(403);
    });

    test('defaults to combined.log and returns all entries', async () => {
      const res = await request(app)
        .get('/api/admin/logs')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.file).toBe('combined');
      expect(res.body.entries).toHaveLength(3);
    });

    test('an unknown ?file falls back to combined instead of reading an arbitrary path', async () => {
      const res = await request(app)
        .get('/api/admin/logs?file=../../etc/passwd')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.file).toBe('combined');
    });

    test('?file=error switches to the error log', async () => {
      const res = await request(app)
        .get('/api/admin/logs?file=error')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.file).toBe('error');
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].message).toBe('Failed to submit invoice to Xero');
    });

    test('?userId filters to entries mentioning that id', async () => {
      const res = await request(app)
        .get('/api/admin/logs?userId=user-456')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].message).toBe('IMAP search error');
    });

    test('?q filters by free-text match on the message, case-insensitively', async () => {
      const res = await request(app)
        .get('/api/admin/logs?q=POSTED')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].message).toBe('Invoice marked as posted');
    });

    test('?lines caps the number of entries returned, keeping the most recent', async () => {
      const res = await request(app)
        .get('/api/admin/logs?lines=1')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].message).toBe('Invoice marked as posted');
    });

    test('missing log file returns an empty list instead of erroring', async () => {
      fs.rmSync(path.join(logsDir, 'combined.log'));
      const res = await request(app)
        .get('/api/admin/logs')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.entries).toEqual([]);
    });
  });
});
