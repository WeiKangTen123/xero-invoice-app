const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

// The real watcher registry runs against this stand-in for node-imap, so a test
// can drop a watcher's connection and see whether its reconnect comes back.
// Nothing else in this file starts a watcher.
jest.mock('imap', () => {
  const EventEmitter = require('events');
  class FakeImap extends EventEmitter {
    connect() {}
    end() { this.emit('end'); }
  }
  return jest.fn(() => new FakeImap());
});

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
    await request(serverFor(app)).get('/api/admin/users').expect(401);
  });

  test('GET /users returns all users for an admin', async () => {
    const res = await request(serverFor(app))
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].email).toBe('admin@test.com');
  });

  test('POST /users creates a new user, whose password is temporary', async () => {
    const res = await request(serverFor(app))
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .send({ email: 'new@test.com', password: 'Temp-pass-2026-x', role: 'user' })
      .expect(201);
    expect(res.body.user.email).toBe('new@test.com');
    expect(res.body.user.role).toBe('user');
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(users.findById(res.body.user.id)).toMatchObject({ must_change_password: 1, temp_password_expires_at: expect.any(String) });
  });

  test('POST /users applies the password rules, with the new account\'s own email', async () => {
    const create = password => request(serverFor(app)).post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`).send({ email: 'rules@test.com', password, role: 'user' });
    expect((await create('elevenchars').expect(400)).body.error).toBe('Password must be at least 12 characters');
    expect((await create('RULES@test.com').expect(400)).body.error).toBe('Password must not be your email address');
    expect((await create('qwerty123456').expect(400)).body.error).toBe('That password is too common; choose another');
    expect(users.findByEmail('rules@test.com')).toBeNull();
  });

  test("DELETE /users/:id removes the user's files as well as the rows", async () => {
    // users.js said the route removed the data directory; it never did, so a
    // deleted user's receipts and PDFs stayed on disk indefinitely.
    const fs = require('fs'), path = require('path');
    const target = await users.createUser('bye@test.com', 'password123', 'user');
    const dir = require('../utils/paths').userDir(target.id);
    fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'receipts', 'r.jpg'), 'x');
    await request(serverFor(app)).delete(`/api/admin/users/${target.id}`).set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(200);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('DELETE /users/:id blocks deleting your own account', async () => {
    await request(serverFor(app))
      .delete(`/api/admin/users/${adminUser.id}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(400);
  });

  test('GET /monitoring returns system + per-user stats', async () => {
    const res = await request(serverFor(app))
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

  test("a demoted admin's old token no longer opens admin routes", async () => {
    const second = await users.createUser('two@test.com', 'password123', 'admin');
    const token = tokenFor(second);            // minted while still admin
    users.updateUserRole(second.id, 'user');
    await request(serverFor(app)).get('/api/admin/users').set('Authorization', `Bearer ${token}`).expect(403);
  });

  test('PATCH /reports/:userId/:invoiceId/resolve marks the invoice reviewed and records who did it', async () => {
    const invoiceStore = require('../utils/invoice-store');
    const owner = await users.createUser('owner@test.com', 'password123', 'user');
    invoiceStore.forUser(owner.id).add({ id: 'r1', status: 'reported', vendorName: 'A', invoiceNumber: '1', invoiceDate: '2026-09-01', totalAmount: 5, processedAt: new Date().toISOString() });
    await request(serverFor(app))
      .patch(`/api/admin/reports/${owner.id}/r1/resolve`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(200);
    const row = invoiceStore.forUser(owner.id).getById('r1');
    expect(row.status).toBe('reviewed');
    expect(row.resolvedBy).toBe('admin@test.com');
  });

  // Resolving set 'reviewed' on a posted row too, and the duplicate checks
  // looked only for 'posted' — so a re-scanned email posted the bill again.
  test('a reported posted row is listed, and resolving it keeps it posted and still found as a duplicate', async () => {
    const invoiceStore = require('../utils/invoice-store');
    const owner = await users.createUser('owner2@test.com', 'password123', 'user');
    const store = invoiceStore.forUser(owner.id);
    store.add({ id: 'p1', status: 'posted', xeroInvoiceId: 'xero-p1', vendorName: 'Acme', invoiceNumber: 'P-1', invoiceDate: '2026-09-01', totalAmount: 5, processedAt: new Date().toISOString() });
    store.addReport('p1', { userEmail: 'owner2@test.com', note: 'wrong account code' });

    const before = await request(serverFor(app)).get('/api/admin/reports').set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(200);
    expect(before.body.reports.map(r => [r.id, r.status])).toEqual([['p1', 'posted']]);

    await new Promise(r => setTimeout(r, 5));
    await request(serverFor(app))
      .patch(`/api/admin/reports/${owner.id}/p1/resolve`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(200);
    const row = store.getById('p1');
    expect(row).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-p1', resolvedBy: 'admin@test.com' });
    expect(store.findPosted('Acme', 'P-1', '2026-09-01', 5)?.id).toBe('p1');
    expect(store.findStored('Acme', 'P-1', '2026-09-01', 5)?.id).toBe('p1');

    const after = await request(serverFor(app)).get('/api/admin/reports').set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(200);
    expect(after.body.reports).toEqual([]);
  });

  test("resolving a row reported under the old rule ('reported' with a Xero ID) puts it back to posted", async () => {
    const invoiceStore = require('../utils/invoice-store');
    const owner = await users.createUser('owner3@test.com', 'password123', 'user');
    invoiceStore.forUser(owner.id).add({ id: 'old', status: 'reported', xeroInvoiceId: 'xero-old', vendorName: 'A', invoiceNumber: '1', invoiceDate: '2026-09-01', totalAmount: 5, processedAt: new Date().toISOString() });
    await request(serverFor(app)).patch(`/api/admin/reports/${owner.id}/old/resolve`).set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(200);
    expect(invoiceStore.forUser(owner.id).getById('old').status).toBe('posted');
  });

  test('resolving an invoice that does not exist is a 404', async () => {
    const owner = await users.createUser('owner4@test.com', 'password123', 'user');
    await request(serverFor(app)).patch(`/api/admin/reports/${owner.id}/nope/resolve`).set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(404);
  });

  test('GET /monitoring reports the requesting admin as online (their own request just touched last_seen_at)', async () => {
    const res = await request(serverFor(app))
      .get('/api/admin/monitoring')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(200);
    const self = res.body.users.find(u => u.id === adminUser.id);
    expect(self.online).toBe(true);
    expect(self.lastSeenAt).toBeTruthy();
  });

  test('GET /monitoring reports a user who has never made a request as offline', async () => {
    const other = await users.createUser('never-seen@test.com', 'password123', 'user');
    const res = await request(serverFor(app))
      .get('/api/admin/monitoring')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
      .expect(200);
    const found = res.body.users.find(u => u.id === other.id);
    expect(found.online).toBe(false);
    expect(found.lastSeenAt).toBeNull();
  });

  // Last Activity was process-state's in-memory value, so every restart
  // blanked it, and the volume chart's days were UTC days: in Singapore a
  // record processed at 4am showed on the day before.
  test('per-user Last Activity is the newest record, and the daily chart counts days in the viewer\'s timezone', async () => {
    const owner = await users.createUser('busy@test.com', 'password123', 'user');
    const insert = require('../db').prepare('INSERT INTO invoices (id, user_id, status, processed_at) VALUES (?, ?, ?, ?)');
    // 20:00 UTC yesterday: still yesterday in UTC, already 04:00 today in Singapore.
    const now = new Date();
    const late = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 20)).toISOString();
    insert.run('busy-1', owner.id, 'review-needed', '2026-01-05T08:00:00.000Z');
    insert.run('busy-2', owner.id, 'posted', late);

    const mon = await request(serverFor(app)).get('/api/admin/monitoring').set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(200);
    const row = mon.body.users.find(u => u.id === owner.id);
    expect(row.lastActivity).toBe(late);
    expect(row.invoices).toMatchObject({ reviewNeeded: 1, posted: 1 });
    expect(mon.body.users.find(u => u.id === adminUser.id).lastActivity).toBeNull();

    const dayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(late));
    expect(dayIn('Asia/Singapore')).not.toBe(dayIn('UTC'));
    const daily = async q => (await request(serverFor(app)).get(`/api/admin/stats/daily?days=3&userId=${owner.id}${q}`)
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(200)).body;
    const postedOn = body => body.days.filter(x => x.posted).map(x => x.day);

    const sg = await daily('&tz=Asia/Singapore');
    expect(sg.timeZone).toBe('Asia/Singapore');
    expect(postedOn(sg)).toEqual([dayIn('Asia/Singapore')]);
    const utc = await daily('&tz=UTC');
    expect(utc.timeZone).toBe('UTC');
    expect(postedOn(utc)).toEqual([dayIn('UTC')]);
    // Without one, the admin's own account timezone (Asia/Singapore by default).
    expect((await daily('')).timeZone).toBe('Asia/Singapore');
    await request(serverFor(app)).get('/api/admin/stats/daily?tz=Not/AZone').set('Authorization', `Bearer ${tokenFor(adminUser)}`).expect(400);
  });

  describe('GET /stats/daily', () => {
    test('requires authentication', async () => {
      await request(serverFor(app)).get('/api/admin/stats/daily').expect(401);
    });

    test('zero-fills every day in range, even with no invoices at all', async () => {
      const res = await request(serverFor(app))
        .get('/api/admin/stats/daily?days=7')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.days).toHaveLength(7);
      for (const d of res.body.days) {
        expect(d).toMatchObject({ posted: 0, error: 0, pending: 0, other: 0 });
        expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    test('buckets invoices by day and status', async () => {
      const invoiceStore = require('../utils/invoice-store');
      const store = invoiceStore.forUser(adminUser.id);
      const today = new Date().toISOString();
      store.add({ id: 'inv-posted', status: 'posted', totalAmount: 100, processedAt: today });
      store.add({ id: 'inv-error',  status: 'error',  totalAmount: 50,  processedAt: today });
      store.add({ id: 'inv-pending', status: 'pending', totalAmount: 25, processedAt: today });

      const res = await request(serverFor(app))
        .get('/api/admin/stats/daily?days=1')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.days).toHaveLength(1);
      expect(res.body.days[0]).toMatchObject({ posted: 1, error: 1, pending: 1 });
    });

    test('?userId scopes the aggregation to one user', async () => {
      const other = await users.createUser('other-stats@test.com', 'password123', 'user');
      const invoiceStore = require('../utils/invoice-store');
      const today = new Date().toISOString();
      invoiceStore.forUser(adminUser.id).add({ id: 'mine', status: 'posted', totalAmount: 10, processedAt: today });
      invoiceStore.forUser(other.id).add({ id: 'theirs', status: 'posted', totalAmount: 10, processedAt: today });

      const res = await request(serverFor(app))
        .get(`/api/admin/stats/daily?days=1&userId=${other.id}`)
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.days[0].posted).toBe(1); // only "theirs", not "mine"
    });
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
      await request(serverFor(app)).get('/api/admin/logs').expect(401);
    });

    test('requires admin role', async () => {
      await request(serverFor(app))
        .get('/api/admin/logs')
        .set('Authorization', `Bearer ${tokenFor(regularUser)}`)
        .expect(403);
    });

    test('defaults to combined.log and returns all entries', async () => {
      const res = await request(serverFor(app))
        .get('/api/admin/logs')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.file).toBe('combined');
      expect(res.body.entries).toHaveLength(3);
    });

    test('an unknown ?file falls back to combined instead of reading an arbitrary path', async () => {
      const res = await request(serverFor(app))
        .get('/api/admin/logs?file=../../etc/passwd')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.file).toBe('combined');
    });

    test('?file=error switches to the error log', async () => {
      const res = await request(serverFor(app))
        .get('/api/admin/logs?file=error')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.file).toBe('error');
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].message).toBe('Failed to submit invoice to Xero');
    });

    test('?userId filters to entries mentioning that id', async () => {
      const res = await request(serverFor(app))
        .get('/api/admin/logs?userId=user-456')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].message).toBe('IMAP search error');
    });

    test('?q filters by free-text match on the message, case-insensitively', async () => {
      const res = await request(serverFor(app))
        .get('/api/admin/logs?q=POSTED')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].message).toBe('Invoice marked as posted');
    });

    test('?lines caps the number of entries returned, keeping the most recent', async () => {
      const res = await request(serverFor(app))
        .get('/api/admin/logs?lines=1')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].message).toBe('Invoice marked as posted');
    });

    test('missing log file returns an empty list instead of erroring', async () => {
      fs.rmSync(path.join(logsDir, 'combined.log'));
      const res = await request(serverFor(app))
        .get('/api/admin/logs')
        .set('Authorization', `Bearer ${tokenFor(adminUser)}`)
        .expect(200);
      expect(res.body.entries).toEqual([]);
    });
  });
});

// ── Account controls ────────────────────────────────────────────────────────
// Role, password reset, sign-out everywhere, disable/enable, the auto-submit
// kill switch and stopping a watcher. Auth routes are mounted too, because the
// proof for most of these is what the account can and cannot do afterwards.
describe('admin account controls', () => {
  let app, users, jwtSecret, admin, target;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/admin', require('./admin'));
    app.use('/api/auth',  require('./auth'));
    admin  = await users.createUser('admin@test.com', 'password123', 'auto'); // first user -> admin
    target = await users.createUser('user@test.com',  'password123', 'user');
  });

  // iat is whole seconds and a token minted in the cutoff's own second is meant
  // to survive it, so a token that must be refused is minted a little in the past.
  function tokenFor(user, secondsAgo = 0) {
    const iat = Math.floor(Date.now() / 1000) - secondsAgo;
    return jwt.sign({ id: user.id, email: user.email, role: user.role, iat }, jwtSecret());
  }
  const asAdmin = req => req.set('Authorization', `Bearer ${tokenFor(admin)}`);
  const login   = (email, password) => request(serverFor(app)).post('/api/auth/login').send({ email, password });
  const me      = token => request(serverFor(app)).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

  describe('PATCH /users/:id/role', () => {
    test('promotes a user to admin and demotes them back', async () => {
      let res = await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/role`)).send({ role: 'admin' }).expect(200);
      expect(res.body.user.role).toBe('admin');
      expect(users.findById(target.id).role).toBe('admin');
      res = await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/role`)).send({ role: 'user' }).expect(200);
      expect(res.body.user.role).toBe('user');
    });

    test('refuses an unknown role, your own account and a missing user', async () => {
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/role`)).send({ role: 'owner' }).expect(400);
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${admin.id}/role`)).send({ role: 'user' }).expect(400);
      await asAdmin(request(serverFor(app)).patch('/api/admin/users/nope/role')).send({ role: 'admin' }).expect(404);
      expect(users.findById(admin.id).role).toBe('admin');
    });

    test('a plain user cannot change roles', async () => {
      await request(serverFor(app)).patch(`/api/admin/users/${admin.id}/role`)
        .set('Authorization', `Bearer ${tokenFor(target)}`).send({ role: 'user' }).expect(403);
    });
  });

  describe('PATCH /users/:id/password', () => {
    test('sets a new password and signs out the sessions that existed before', async () => {
      const stale = tokenFor(target, 5);
      await me(stale).expect(200);
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/password`)).send({ password: 'newpassword1' }).expect(200);
      await login('user@test.com', 'password123').expect(401);
      const fresh = await login('user@test.com', 'newpassword1').expect(200);
      await me(stale).expect(401);
      await me(fresh.body.token).expect(200);
    });

    test('refuses a short, common or own-email password, your own account and a missing user, changing nothing', async () => {
      const reset = password => asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/password`)).send({ password });
      const res = await reset('elevenchars').expect(400);
      expect(res.body.error).toMatch(/12 characters/);
      expect((await reset('qwerty123456').expect(400)).body.error).toBe('That password is too common; choose another');
      expect((await reset('User@Test.com').expect(400)).body.error).toBe('Password must not be your email address');
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${admin.id}/password`)).send({ password: 'newpassword1' }).expect(400);
      await asAdmin(request(serverFor(app)).patch('/api/admin/users/nope/password')).send({ password: 'newpassword1' }).expect(404);
      // Nothing temporary was set. (Read before signing in: this fixture's own
      // password is under twelve characters, so the sign-in asks for a new one,
      // with no expiry, as for any password the rules now refuse.)
      expect(users.findById(target.id).must_change_password).toBe(0);
      await login('user@test.com', 'password123').expect(200);
      expect(users.findById(target.id).temp_password_expires_at).toBeNull();
    });

    test('the password set is temporary: the account signs in with mustChangePassword and is held to the change', async () => {
      const before = Date.now();
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/password`)).send({ password: 'newpassword1' }).expect(200);
      const row = users.findById(target.id);
      expect(row.must_change_password).toBe(1);
      expect(Date.parse(row.temp_password_expires_at) - before).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
      const fresh = await login('user@test.com', 'newpassword1').expect(200);
      expect(fresh.body.user.mustChangePassword).toBe(true);
      const gated = await request(serverFor(app)).get('/api/admin/users').set('Authorization', `Bearer ${fresh.body.token}`).expect(403);
      expect(gated.body.code).toBe('password_change_required');
      await me(fresh.body.token).expect(200);
    });

    test('a reset unlocks a locked-out account', async () => {
      for (let i = 0; i < 5; i++) await login('user@test.com', 'wrong');
      await login('user@test.com', 'password123').expect(423);
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/password`)).send({ password: 'newpassword1' }).expect(200);
      expect(users.findById(target.id)).toMatchObject({ failed_logins: 0, lock_count: 0, locked_until: null, last_locked_at: null });
      await login('user@test.com', 'newpassword1').expect(200);
    });
  });

  describe('POST /users/:id/unlock', () => {
    const unlock = id => asAdmin(request(serverFor(app)).post(`/api/admin/users/${id}/unlock`));

    test('ends the lock and clears the count, is recorded, and the account can sign in again', async () => {
      for (let i = 0; i < 5; i++) await login('user@test.com', 'wrong');
      await login('user@test.com', 'password123').expect(423);
      const res = await unlock(target.id).expect(200);
      expect(res.body.user).toMatchObject({ id: target.id, failedLogins: 0, lockedUntil: null });
      expect(users.findById(target.id)).toMatchObject({ failed_logins: 0, lock_count: 0, locked_until: null, last_locked_at: null });
      await login('user@test.com', 'password123').expect(200);
      const event = require('../db').prepare("SELECT * FROM admin_events WHERE action = 'login.unlocked'").get();
      expect(event).toMatchObject({ actor_id: admin.id, actor_email: admin.email, target_user_id: target.id, target_email: target.email });
    });

    test('works on your own account, and a missing user is a 404', async () => {
      for (let i = 0; i < 2; i++) await login('admin@test.com', 'wrong');
      expect(users.findById(admin.id).failed_logins).toBe(2);
      await unlock(admin.id).expect(200);
      expect(users.findById(admin.id).failed_logins).toBe(0);
      await unlock('nope').expect(404);
      await request(serverFor(app)).post(`/api/admin/users/${target.id}/unlock`).set('Authorization', `Bearer ${tokenFor(target)}`).expect(403);
    });
  });

  describe('GET /users', () => {
    test('reports failedLogins, lockedUntil, mustChangePassword and lastLoginAt for each account', async () => {
      const list = async () => (await asAdmin(request(serverFor(app)).get('/api/admin/users')).expect(200)).body.users;
      const mine = rows => rows.find(u => u.id === target.id);
      expect(mine(await list())).toMatchObject({ failedLogins: 0, lockedUntil: null, mustChangePassword: false, lastLoginAt: null });
      await login('user@test.com', 'wrong'); await login('user@test.com', 'wrong');
      expect(mine(await list())).toMatchObject({ failedLogins: 2, lockedUntil: null });
      await login('user@test.com', 'password123').expect(200);
      expect(mine(await list())).toMatchObject({ failedLogins: 0, lastLoginAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
      for (let i = 0; i < 5; i++) await login('user@test.com', 'wrong');
      expect(mine(await list())).toMatchObject({ failedLogins: 0, lockedUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/password`)).send({ password: 'newpassword1' }).expect(200);
      expect(mine(await list())).toMatchObject({ lockedUntil: null, mustChangePassword: true });
    });
  });

  describe('POST /users/:id/sign-out', () => {
    test('refuses existing tokens but lets the user sign in again', async () => {
      const stale = tokenFor(target, 5);
      await me(stale).expect(200);
      await asAdmin(request(serverFor(app)).post(`/api/admin/users/${target.id}/sign-out`)).expect(200);
      await me(stale).expect(401);
      const fresh = await login('user@test.com', 'password123').expect(200);
      await me(fresh.body.token).expect(200);
    });

    test('cannot be used on yourself', async () => {
      await asAdmin(request(serverFor(app)).post(`/api/admin/users/${admin.id}/sign-out`)).expect(400);
    });
  });

  describe('PATCH /users/:id/disabled', () => {
    test('a disabled account cannot sign in or use an existing token; enabling restores both', async () => {
      const stale = tokenFor(target, 5);
      let res = await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/disabled`)).send({ disabled: true }).expect(200);
      expect(res.body.user.disabledAt).toBeTruthy();
      const denied = await login('user@test.com', 'password123').expect(403);
      expect(denied.body.error).toMatch(/disabled/);
      await me(stale).expect(401);
      expect(users.getAllUsers().find(u => u.id === target.id).disabledAt).toBeTruthy();

      res = await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/disabled`)).send({ disabled: false }).expect(200);
      expect(res.body.user.disabledAt).toBeNull();
      const fresh = await login('user@test.com', 'password123').expect(200);
      await me(fresh.body.token).expect(200);
    });

    test('keeps the rows: disabling is not deleting', async () => {
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/disabled`)).send({ disabled: true }).expect(200);
      expect(users.findById(target.id)).not.toBeNull();
    });

    test('refuses a non-boolean and your own account', async () => {
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/disabled`)).send({ disabled: 'yes' }).expect(400);
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${admin.id}/disabled`)).send({ disabled: true }).expect(400);
      expect(users.findById(admin.id).disabled_at).toBeNull();
    });

    test('a disabled admin can still be deleted while another admin remains', async () => {
      const other = await users.createUser('other@test.com', 'password123', 'admin');
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${other.id}/disabled`)).send({ disabled: true }).expect(200);
      await asAdmin(request(serverFor(app)).delete(`/api/admin/users/${other.id}`)).expect(200);
    });

    test('GET /monitoring reports a disabled account', async () => {
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/disabled`)).send({ disabled: true }).expect(200);
      const res = await asAdmin(request(serverFor(app)).get('/api/admin/monitoring')).expect(200);
      expect(res.body.users.find(u => u.id === target.id).disabled).toBe(true);
      expect(res.body.users.find(u => u.id === admin.id).disabled).toBe(false);
    });
  });

  describe('auto-submit kill switch and watcher', () => {
    test('PATCH /users/:id/auto-process turns auto-submit off and refuses to turn it on', async () => {
      const settings = require('../utils/settings-store');
      settings.forUser(target.id).set({ autoProcess: true });
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/auto-process`)).send({ autoProcess: true }).expect(400);
      expect(settings.forUser(target.id).get('autoProcess')).toBe(true);
      await asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/auto-process`)).send({ autoProcess: false }).expect(200);
      expect(settings.forUser(target.id).get('autoProcess')).toBe(false);
      await asAdmin(request(serverFor(app)).patch('/api/admin/users/nope/auto-process')).send({ autoProcess: false }).expect(404);
    });

    test('POST /users/:id/watcher/stop reports whether anything was running', async () => {
      const res = await asAdmin(request(serverFor(app)).post(`/api/admin/users/${target.id}/watcher/stop`)).expect(200);
      expect(res.body.wasRunning).toBe(false);
      await asAdmin(request(serverFor(app)).post('/api/admin/users/nope/watcher/stop')).expect(404);
    });
  });
});

// ── Stopping an account's automation ───────────────────────────────────────
// Disabling or deleting an account has to stop everything that acts for it in
// the background, not only refuse its sign-in: the mailbox watcher (including
// one waiting to reconnect), the mail worker that posts to Xero and the job
// worker.
describe("admin: disabling or deleting stops the account's automation", () => {
  let app, users, jwtSecret, admin, target, registry, emailWorker, claimWorker, Imap;

  const CREDS = { IMAP_USER: 'user@test.com', IMAP_PASS: 'pw', IMAP_HOST: 'imap.test.com', IMAP_PORT: 993 };
  // Only setTimeout is faked: the reconnect backoff is one, and the HTTP
  // requests these tests make need the real ticks and immediates.
  const FAKE_TIMEOUTS_ONLY = { doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'queueMicrotask', 'Date', 'hrtime', 'performance'] };
  const PAST_ANY_BACKOFF = 60 * 60 * 1000;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/admin', require('./admin'));
    registry    = require('../email/watcher-registry');
    emailWorker = require('../queue/email-worker');
    claimWorker = require('../claims/claim-worker');
    Imap        = require('imap');
    admin  = await users.createUser('admin@test.com', 'password123', 'auto');
    target = await users.createUser('user@test.com',  'password123', 'user');
  });
  afterEach(() => {
    registry.stopAll();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const asAdmin = req => req.set('Authorization', `Bearer ${jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, jwtSecret())}`);
  const disable = () => asAdmin(request(serverFor(app)).patch(`/api/admin/users/${target.id}/disabled`)).send({ disabled: true });

  // A watcher whose connection has dropped: no connection, so isRunning() is
  // false, and a reconnect timer pending.
  function watcherInBackoff(userId) {
    registry.start(userId, CREDS, jest.fn());
    Imap.mock.results[Imap.mock.results.length - 1].value.emit('end');
    expect(registry.isRunning(userId)).toBe(false);
    return Imap.mock.calls.length;
  }

  test('disabling during a reconnect backoff leaves no reconnect pending', async () => {
    jest.useFakeTimers(FAKE_TIMEOUTS_ONLY);
    watcherInBackoff(target.id);
    // The control: an account left alone does reconnect after its backoff.
    const other = await users.createUser('other@test.com', 'password123', 'user');
    const otherConnections = watcherInBackoff(other.id);

    const res = await disable().expect(200);
    expect(res.body.user.disabledAt).toBeTruthy();

    jest.advanceTimersByTime(PAST_ANY_BACKOFF);
    expect(Imap.mock.calls.length).toBe(otherConnections + 1);   // one reconnect: the other account's
    expect(registry.isRunning(target.id)).toBe(false);
    expect(registry.isRunning(other.id)).toBe(true);
  });

  test('disabling stops the mail and job workers and leaves auto-submit as the user set it', async () => {
    const settings = require('../utils/settings-store');
    settings.forUser(target.id).set({ autoProcess: true });
    const stopMail = jest.spyOn(emailWorker, 'stopWorker');
    const stopJobs = jest.spyOn(claimWorker, 'stopWorker');
    await disable().expect(200);
    expect(stopMail).toHaveBeenCalledWith(target.id);
    expect(stopJobs).toHaveBeenCalledWith(target.id);
    expect(settings.forUser(target.id).get('autoProcess')).toBe(true);
  });

  test('POST /users/:id/watcher/stop cancels a reconnect even though nothing reports running', async () => {
    jest.useFakeTimers(FAKE_TIMEOUTS_ONLY);
    const connections = watcherInBackoff(target.id);
    const res = await asAdmin(request(serverFor(app)).post(`/api/admin/users/${target.id}/watcher/stop`)).expect(200);
    expect(res.body.wasRunning).toBe(false);
    jest.advanceTimersByTime(PAST_ANY_BACKOFF);
    expect(Imap.mock.calls.length).toBe(connections);
  });

  test('DELETE /users/:id stops the watcher and both workers before the account and its files go', async () => {
    const dir = require('../utils/paths').userDir(target.id);
    fs.mkdirSync(dir, { recursive: true });
    const seen = [];
    const recordThenRun = (name, mod, fn) => {
      const real = mod[fn];
      jest.spyOn(mod, fn).mockImplementation(id => {
        seen.push({ name, id, accountThere: !!users.findById(id), filesThere: fs.existsSync(dir) });
        return real(id);
      });
    };
    recordThenRun('watcher', registry, 'stop');
    recordThenRun('mail', emailWorker, 'stopWorker');
    recordThenRun('jobs', claimWorker, 'stopWorker');

    await asAdmin(request(serverFor(app)).delete(`/api/admin/users/${target.id}`)).expect(200);

    expect(seen.map(s => s.name).sort()).toEqual(['jobs', 'mail', 'watcher']);
    for (const s of seen) expect(s).toMatchObject({ id: target.id, accountThere: true, filesThere: true });
    expect(users.findById(target.id)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('DELETE /users/:id during a reconnect backoff: the watcher does not come back for the deleted account', async () => {
    jest.useFakeTimers(FAKE_TIMEOUTS_ONLY);
    const connections = watcherInBackoff(target.id);
    await asAdmin(request(serverFor(app)).delete(`/api/admin/users/${target.id}`)).expect(200);
    jest.advanceTimersByTime(PAST_ANY_BACKOFF);
    expect(Imap.mock.calls.length).toBe(connections);
    expect(registry.isRunning(target.id)).toBe(false);
  });
});
