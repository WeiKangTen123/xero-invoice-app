const request      = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express      = require('express');
const jwt          = require('jsonwebtoken');
const EventEmitter = require('events');

// No mailbox is ever contacted: node-imap is a stand-in the test drives, and
// the worker that turns queued mail into invoices is not started for real.
class FakeImap extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; }
  connect() {}
  openBox(name, readOnly, cb) { this._openBoxCb = cb; }
  search(criteria, cb) { cb(null, []); }
  end() { this.ended = true; }
}
jest.mock('imap', () => jest.fn());
jest.mock('../queue/email-worker', () => ({
  startWorker: jest.fn(), stopWorker: jest.fn(), kickWorker: jest.fn(), recoverPendingJobs: jest.fn(),
}));

const HOUR = 3600 * 1000;

describe('routes/process — the watcher survives a restart, and says why it stopped', () => {
  let app, db, users, settingsStore, registry, processRoutes, Imap, jwtSecret;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    db            = require('../db');
    users         = require('../utils/users');
    settingsStore = require('../utils/settings-store');
    registry      = require('../email/watcher-registry');
    processRoutes = require('./process');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    Imap = require('imap');
    Imap.mockImplementation(o => new FakeImap(o));

    app = express();
    app.use(express.json());
    app.use('/api/process', processRoutes);
  });
  afterEach(() => registry.stopAll());

  let seq = 0;
  async function makeUser({ configured = true, enabled = false, disabled = false, lastSeen } = {}) {
    const u = await users.createUser(`pw${Date.now()}-${seq++}@gmail.com`, 'password123', 'user');
    if (configured) users.saveUserConfig(u.id, { IMAP_PASS: 'app-pw', XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'csecret' });
    if (enabled) settingsStore.forUser(u.id).setWatcherEnabled(true);
    if (disabled) users.setDisabled(u.id, true);
    if (lastSeen !== undefined) db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(lastSeen, u.id);
    return u;
  }
  const auth  = u => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const post  = (u, p) => request(serverFor(app)).post(`/api/process/${p}`).set('Authorization', auth(u));
  const status = u => request(serverFor(app)).get('/api/process/status').set('Authorization', auth(u));
  const enabledInDb = id => db.prepare('SELECT watcher_enabled FROM user_settings WHERE user_id = ?').get(id)?.watcher_enabled;

  describe('the owner\'s intent is saved', () => {
    test('Start saves it, Stop clears it', async () => {
      const u = await makeUser();
      await post(u, 'start').expect(200);
      expect(enabledInDb(u.id)).toBe(1);
      expect(settingsStore.watcherEnabledUserIds()).toContain(u.id);

      await post(u, 'stop').expect(200);
      expect(enabledInDb(u.id)).toBe(0);
      expect(settingsStore.watcherEnabledUserIds()).not.toContain(u.id);
    });

    test('a Start refused for incomplete setup saves nothing', async () => {
      const u = await makeUser({ configured: false });
      await post(u, 'start').expect(400);
      expect(enabledInDb(u.id) || 0).toBe(0);
    });

    test('logout and admin stops (a plain stop()) clear it, even with no watcher in memory', async () => {
      const u = await makeUser({ enabled: true });
      registry.stop(u.id);                      // what routes/auth.js logout and routes/admin.js call
      expect(enabledInDb(u.id)).toBe(0);
    });

    test('automatic stops keep it: idle sweep, refused password, shutdown', async () => {
      const u = await makeUser();
      await post(u, 'start').expect(200);
      registry.stop(u.id, { reason: registry.STOP_REASONS.IDLE });
      expect(enabledInDb(u.id)).toBe(1);

      await post(u, 'start').expect(200);
      Imap.mock.results.at(-1).value.emit('error', Object.assign(new Error('Invalid credentials'), { source: 'authentication' }));
      expect(registry.isRunning(u.id)).toBe(false);
      expect(enabledInDb(u.id)).toBe(1);

      await post(u, 'start').expect(200);
      registry.stopAll();
      expect(enabledInDb(u.id)).toBe(1);
    });

    test('the idle sweeper stops an abandoned watcher as idle and leaves it switched on', async () => {
      const u = await makeUser({ lastSeen: new Date(Date.now() - 9 * HOUR).toISOString() });
      await post(u, 'start').expect(200);
      // Starting through the API is itself a sighting; put the owner back 9 hours ago.
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date(Date.now() - 9 * HOUR).toISOString(), u.id);
      const { stopped } = require('../email/idle-sweeper').sweepOnce();
      expect(stopped).toEqual([u.id]);
      expect(registry.getStatus(u.id)).toMatchObject({ state: 'stopped', reason: 'idle' });
      expect(enabledInDb(u.id)).toBe(1);
    });
  });

  describe('resumeWatchers()', () => {
    test('starts only active, switched-on, configured accounts whose owner is not idle', async () => {
      const ok       = await makeUser({ enabled: true });
      const recent   = await makeUser({ enabled: true, lastSeen: new Date(Date.now() - 2 * HOUR).toISOString() });
      const disabled = await makeUser({ enabled: true, disabled: true });
      const off      = await makeUser({ enabled: false });
      const noSetup  = await makeUser({ enabled: true, configured: false });
      const idle     = await makeUser({ enabled: true, lastSeen: new Date(Date.now() - 9 * HOUR).toISOString() });

      const started = await processRoutes.resumeWatchers({ staggerMs: 0 });

      expect(started.sort()).toEqual([ok.id, recent.id].sort());
      for (const u of [ok, recent]) expect(registry.isRunning(u.id)).toBe(true);
      for (const u of [disabled, off, noSetup, idle]) expect(registry.isRunning(u.id)).toBe(false);
      // Built like a clicked Start: same mailbox, same worker.
      const emailWorker = require('../queue/email-worker');
      expect(emailWorker.startWorker.mock.calls.map(([id]) => id).sort()).toEqual([ok.id, recent.id].sort());
      expect(Imap.mock.results.at(-1).value.opts).toMatchObject({ host: 'imap.gmail.com', password: 'app-pw' });
      // Skipped accounts keep their setting for later.
      expect(enabledInDb(idle.id)).toBe(1);
      expect(enabledInDb(noSetup.id)).toBe(1);
    });

    test('is reachable from the watcher registry, where main/index.js calls it at boot', async () => {
      const u = await makeUser({ enabled: true });
      expect(await registry.resumeWatchers({ staggerMs: 0 })).toEqual([u.id]);
      expect(registry.isRunning(u.id)).toBe(true);
    });

    test('does not start one that is already running', async () => {
      const u = await makeUser({ enabled: true });
      await post(u, 'start').expect(200);
      const before = Imap.mock.calls.length;
      expect(await processRoutes.resumeWatchers({ staggerMs: 0 })).toEqual([]);
      expect(Imap.mock.calls.length).toBe(before);
    });

    test('staggers the connections, and respects a Stop that lands during the wait', async () => {
      const a = await makeUser({ enabled: true });
      const b = await makeUser({ enabled: true });
      const c = await makeUser({ enabled: true });
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        const done = processRoutes.resumeWatchers({ staggerMs: 2000 });
        expect(Imap).toHaveBeenCalledTimes(1);                  // the first at once
        await jest.advanceTimersByTimeAsync(1999);
        expect(Imap).toHaveBeenCalledTimes(1);                  // the second waits its turn
        await jest.advanceTimersByTimeAsync(1);
        expect(Imap).toHaveBeenCalledTimes(2);
        registry.stop(c.id);                                     // c's owner presses Stop meanwhile
        await jest.advanceTimersByTimeAsync(2000);
        expect(await done).toEqual([a.id, b.id]);
        expect(Imap).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    test('the default stagger is a couple of seconds', () => {
      expect(processRoutes.RESUME_STAGGER_MS).toBe(2000);
    });

    // A deployed database gains the column through migrate.js. Until it has,
    // Start, Stop, the status poll and the boot resume must all still work.
    test('a database without the watcher_enabled column breaks nothing', async () => {
      const u = await makeUser();
      db.exec('ALTER TABLE user_settings DROP COLUMN watcher_enabled');
      await post(u, 'start').expect(200);
      expect(registry.isRunning(u.id)).toBe(true);
      await status(u).expect(200);
      await post(u, 'stop').expect(200);
      expect(registry.isRunning(u.id)).toBe(false);
      expect(await processRoutes.resumeWatchers({ staggerMs: 0 })).toEqual([]);
    });
  });

  describe('GET /status', () => {
    function seedInvoices(userId, statuses) {
      const insert = db.prepare('INSERT INTO invoices (id, user_id, status, processed_at) VALUES (?, ?, ?, ?)');
      statuses.forEach((s, i) => insert.run(`${userId}-inv-${i}`, userId, s, new Date().toISOString()));
    }

    test('counts invoice statuses with one query, not by loading every invoice; the response keeps its shape', async () => {
      const u = await makeUser();
      const other = await makeUser();
      seedInvoices(u.id, ['pending', 'pending', 'posted', 'posted', 'posted', 'error', 'submitting', 'duplicate', 'review-needed']);
      seedInvoices(other.id, ['pending', 'posted']);

      const invoiceStore = require('../utils/invoice-store');
      const realForUser  = invoiceStore.forUser;
      const spy = jest.spyOn(invoiceStore, 'forUser').mockImplementation(id => ({
        ...realForUser(id),
        getAll: () => { throw new Error('the status poll must not load every invoice'); },
      }));
      try {
        const res = await status(u).expect(200);
        expect(Object.keys(res.body).sort()).toEqual([
          'invoiceCount', 'lastActivity', 'lastScan', 'missingConfig', 'queue', 'running',
          'setupRequired', 'startedAt', 'watcher', 'xero',
        ]);
        expect(res.body.xero).toEqual({ pending: 2, submitting: 1, posted: 3, error: 1 });
        expect(res.body).toMatchObject({ running: false, setupRequired: false, invoiceCount: 9 });
        expect(res.body.queue).toEqual({ pending: 0, processing: 0, dead: 0, jobs: [] });
      } finally { spy.mockRestore(); }
    });

    test('an account with no invoices reports zeros', async () => {
      const u = await makeUser();
      expect((await status(u).expect(200)).body.xero).toEqual({ pending: 0, submitting: 0, posted: 0, error: 0 });
    });

    test('says what the watcher is doing and why it stopped', async () => {
      const u = await makeUser();
      expect((await status(u)).body.watcher).toMatchObject({ state: 'stopped', reason: null });

      await post(u, 'start').expect(200);
      expect((await status(u)).body.watcher).toMatchObject({ state: 'connecting' });
      const fake = Imap.mock.results.at(-1).value;
      fake.emit('ready'); fake._openBoxCb(null);
      expect((await status(u)).body).toMatchObject({ running: true, watcher: { state: 'watching', reason: null } });

      fake.emit('error', Object.assign(new Error('Invalid credentials (Failure)'), { source: 'authentication' }));
      expect((await status(u)).body).toMatchObject({
        running: false,
        watcher: { state: 'stopped', reason: 'auth-failed', error: 'Invalid credentials (Failure)' },
      });

      await post(u, 'start').expect(200);
      await post(u, 'stop').expect(200);
      const st = (await status(u)).body.watcher;
      expect(st).toMatchObject({ state: 'stopped', reason: 'manual', error: null, nextRetryAt: null });
      expect(Date.parse(st.stoppedAt)).toBeGreaterThan(Date.now() - 60 * 1000);
    });

    test('during a backoff: reconnecting, with the time of the next attempt', async () => {
      const u = await makeUser();
      await post(u, 'start').expect(200);
      const fake = Imap.mock.results.at(-1).value;
      fake.emit('ready'); fake._openBoxCb(null);
      fake.emit('error', new Error('read ECONNRESET'));
      const st = (await status(u)).body.watcher;
      expect(st).toMatchObject({ state: 'reconnecting', reason: null, error: 'read ECONNRESET', attempt: 1 });
      expect(Date.parse(st.nextRetryAt)).toBeGreaterThan(Date.now());
    });
  });
});
