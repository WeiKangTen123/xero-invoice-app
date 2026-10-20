// GET /api/admin/users/:id/detail end to end: a real account with real
// sessions (utils/sessions.js), sign-in records, records and their history,
// queued mail and files on disk, read back through the route. Only maxmind is
// replaced (the real IP databases are 130 MB and fetched monthly): each
// "database" is a small file and a reader answering from a table, so the
// route's own opening and lookups run as they do on the server.
jest.mock('maxmind', () => ({ open: jest.fn() }));

const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const fs      = require('fs');
const path    = require('path');

const DAY = 24 * 60 * 60 * 1000;
const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  safariIphone:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  firefoxMac:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
};
const CITY = {
  '8.8.8.8': { city: { names: { en: 'Mountain View' } }, country: { iso_code: 'US', names: { en: 'United States' } } },
  '1.1.1.1': { city: { names: { en: 'Sydney' } }, country: { iso_code: 'AU', names: { en: 'Australia' } } },
  '9.9.9.9': { city: { names: { en: 'Zurich' } }, country: { iso_code: 'CH', names: { en: 'Switzerland' } } },
};
const ASN = {
  '8.8.8.8': { autonomous_system_organization: 'Google LLC' },
  '1.1.1.1': { autonomous_system_organization: 'Cloudflare, Inc.' },
  '9.9.9.9': { autonomous_system_organization: 'Quad9' },
};

// What the target account keeps secret. None of it may appear in the answer.
const SECRETS = {
  IMAP_PASS:                'imap-secret-pass-9',
  XERO_CLIENT_SECRET:       'custom-client-secret-def',
  XERO_OAUTH_CLIENT_SECRET: 'oauth-client-secret-xyz',
  XERO_OAUTH_REFRESH_TOKEN: 'refresh-token-secret-abc',
  Gemini_API_KEY:           'AIza-legacy-key-secret-0002',
};
const LIST_KEYS = ['AIza-list-key-secret-0001', 'AIza-list-key-secret-0003'];

describe('GET /api/admin/users/:id/detail', () => {
  let app, db, users, sessions, invoiceStore, settingsStore, tokenCache, geoip, paths, maxmind, signSession;
  let admin, adminSid, adminToken, target, now;

  // A sign-in record (or any admin event) on `user`, `daysAgo` days ago, as
  // routes/auth.js and routes/admin.js write them. Written in time order, as
  // they happen, so ids and times agree.
  const event = (user, action, daysAgo, details = null, actor = null) => db.prepare(`
    INSERT INTO admin_events (at, actor_id, actor_email, target_user_id, target_email, action, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(new Date(now - daysAgo * DAY).toISOString(), actor ? String(actor.id) : null, actor ? actor.email : null,
    String(user.id), user.email, action, details ? JSON.stringify(details) : null);

  const get = (id, token = adminToken) => request(serverFor(app)).get(`/api/admin/users/${id}/detail`)
    .set('Authorization', `Bearer ${token}`);

  const writeFile = (rel, bytes) => {
    const file = path.join(paths.userDir(target.id), rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return fs.statSync(file).size;
  };

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db            = require('../db');
    users         = require('../utils/users');
    sessions      = require('../utils/sessions');
    invoiceStore  = require('../utils/invoice-store');
    settingsStore = require('../utils/settings-store');
    tokenCache    = require('../utils/token-cache');
    geoip         = require('../utils/geoip');
    paths         = require('../utils/paths');
    maxmind       = require('maxmind');
    ({ signSession } = require('../middleware/auth-middleware'));
    now = Date.now();

    // The location databases, as the monthly fetch leaves them.
    fs.rmSync(geoip.GEOIP_DIR, { recursive: true, force: true });
    fs.mkdirSync(geoip.GEOIP_DIR, { recursive: true });
    fs.writeFileSync(geoip.fileFor('city'), 'city');
    fs.writeFileSync(geoip.fileFor('asn'), 'asn');
    maxmind.open.mockReset();
    maxmind.open.mockImplementation(async file => {
      const table = file === geoip.fileFor('city') ? CITY : ASN;
      return { get: ip => table[ip] || null, metadata: {} };
    });

    admin    = await users.createUser(`admin-${now}@test.com`, 'password123', 'admin');
    adminSid = sessions.startSession(admin.id, { ip: '203.0.113.7', userAgent: UA.chromeWindows });
    adminToken = signSession(admin, { sid: adminSid });
    target   = await users.createUser(`target-${now}@test.com`, 'password123', 'user', { temporary: true });
    fs.rmSync(paths.userDir(target.id), { recursive: true, force: true });

    app = express();
    app.use(express.json());
    app.use('/api/admin', require('./admin-user-detail'));
  });

  afterEach(() => {
    geoip._reset();
    jest.restoreAllMocks();
  });

  // The account as it might be after a few months of use.
  async function busyAccount() {
    users.saveUserConfig(target.id, {
      ...SECRETS, IMAP_HOST: 'imap.test.com', IMAP_USER: 'inbox@test.com',
      XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'client-id', XERO_CLIENT_ID: 'custom-id',
    });
    for (const key of LIST_KEYS) users.addGeminiKey(target.id, key, 'key');
    db.prepare('UPDATE users SET failed_logins = 2, lock_count = 1, last_locked_at = ? WHERE id = ?')
      .run(new Date(now - 4 * DAY).toISOString(), target.id);
    tokenCache.markRefreshed(target.id, { method: 'oauth', at: new Date(now - 3 * DAY) });
    db.prepare('INSERT INTO xero_tenants (user_id, tenant_id, tenant_name, connected_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
      .run(target.id, 't1', 'Acme Pte Ltd', '2026-01-01T00:00:00Z', target.id, 't2', 'Acme Holdings', '2026-02-01T00:00:00Z');
    settingsStore.forUser(target.id).set({ autoProcess: true });
    settingsStore.forUser(target.id).setWatcherEnabled(true);

    // Sign-ins, oldest first.
    event(target, 'login.success', 60, { ip: '8.8.8.8', ua: UA.chromeWindows }, target);
    event(target, 'login.failed', 40, { ip: '5.5.5.5', email: target.email });   // older than a month: not listed
    event(target, 'user.password_reset', 12, null, admin);
    event(target, 'login.success', 10, { ip: '::ffff:8.8.8.8', ua: UA.chromeWindows }, target);
    event(target, 'user.auto_process_off', 6, null, admin);
    event(target, 'login.failed', 5, { ip: '1.1.1.1', ua: UA.chromeWindows, email: target.email });
    event(target, 'login.locked', 4, { ip: '1.1.1.1', ua: UA.chromeWindows, lockMinutes: 15, failures: 5 });
    event(target, 'login.unlocked', 3, null, admin);
    event(target, 'login.success', 2, { ip: '8.8.8.8', ua: UA.safariIphone }, target);
    event(target, 'login.refused', 1, { ip: '192.168.1.10', ua: UA.chromeWindows, reason: 'disabled' });
    event(target, 'logout', 0.5, { ip: '8.8.8.8', ua: UA.chromeWindows }, target);
    event(target, 'session.revoke', 0.25, { sid: 'an-ended-session' }, admin);
    event(admin, 'user.role', 0.2, { from: 'user', to: 'admin' }, admin);              // another account's
    // A sign-in made just now, and its session a moment after it, as
    // routes/auth.js makes them; and one from a known place and browser.
    event(target, 'login.success', 2 / 86400, { ip: '9.9.9.9', ua: UA.firefoxMac }, target);
    const known = sessions.startSession(target.id, { ip: '::ffff:8.8.8.8', userAgent: UA.chromeWindows });
    const fresh = sessions.startSession(target.id, { ip: '9.9.9.9', userAgent: UA.firefoxMac });
    const ended = sessions.startSession(target.id, { ip: '8.8.8.8', userAgent: UA.chromeWindows });
    sessions.endSession(ended, 'logout');

    // Records, written by the store as intake writes them.
    const store = invoiceStore.forUser(target.id);
    const bill = (id, status, daysAgo) => store.add({
      id, status, invoiceType: 'ACCPAY', source: 'pdf', sourceEmail: 'billing@acme.test', vendorName: 'Acme Ltd',
      invoiceNumber: `INV-${id}`, invoiceDate: '2026-09-01', totalAmount: 120, subTotal: 110, taxAmount: 10, currency: 'SGD',
      accountCode: '400', lineItems: [{ description: 'Widgets', unitAmount: 110 }],
      processedAt: new Date(now - daysAgo * DAY).toISOString(),
    });
    bill('a', 'pending', 3);
    bill('b', 'posted', 2);
    bill('c', 'review-needed', 1);
    bill('d', 'duplicate', 4);

    // Mail waiting, and one that failed for good with the password in its error.
    const job = (id, status, extra = {}) => writeFile(`email-queue/${id}.que`, JSON.stringify({
      id, status, attempts: status === 'dead' ? 3 : 0, createdAt: new Date(now - DAY).toISOString(),
      email: { subject: 'Bill', from: 'billing@acme.test', attachments: [] }, ...extra,
    }));
    const queueBytes = job('job-old', 'dead', { lastError: 'older failure', createdAt: new Date(now - 5 * DAY).toISOString() })
      + job('job-dead', 'dead', { lastError: `IMAP refused ${SECRETS.IMAP_PASS} for inbox@test.com` })
      + job('job-pending', 'pending')
      + writeFile('claim-queue/c1.que', 'x'.repeat(50));
    const receiptBytes = writeFile('receipts/r1.jpg', Buffer.alloc(1000)) + writeFile('receipts/sub/r2.png', Buffer.alloc(24));
    const pdfBytes = writeFile('pdfs/a.pdf', Buffer.alloc(2048));
    writeFile('config-left-over.json', 'not counted');

    return { known, fresh, ended, storage: { receipts: receiptBytes, pdfs: pdfBytes, queue: queueBytes } };
  }

  test('the whole page for a busy account', async () => {
    const { known, fresh, storage } = await busyAccount();
    const res = await get(target.id).expect(200);
    const body = res.body;

    expect(Object.keys(body).sort()).toEqual(['activity', 'attribution', 'sessions', 'signIns', 'user', 'work']);
    expect(body.attribution).toEqual({ text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' });

    // The account, with its password and lock state.
    expect(body.user).toEqual({
      id: target.id, email: target.email, role: 'user', demo: false,
      createdAt: expect.any(String), lastLoginAt: null, lastSeenAt: null, online: false, disabledAt: null,
      mustChangePassword: true, failedLogins: 2, lockedUntil: null, lockCount: 1,
      lastLockedAt: new Date(now - 4 * DAY).toISOString(),
      passwordChangedAt: expect.any(String), tempPasswordExpiresAt: expect.any(String),
    });

    // Sessions in use: the ended one is not; the one from a new place is new,
    // though the sign-in that made it was a moment before it.
    const bySid = Object.fromEntries(body.sessions.map(s => [s.sid, s]));
    expect(Object.keys(bySid).sort()).toEqual([known, fresh].sort());
    expect(bySid[known]).toEqual({
      sid: known, createdAt: expect.any(String), lastSeenAt: expect.any(String),
      ip: '8.8.8.8', location: 'Mountain View, United States · Google', device: 'Chrome · Windows', isNew: false, current: false,
    });
    expect(bySid[fresh]).toMatchObject({ ip: '9.9.9.9', location: 'Zurich, Switzerland · Quad9', device: 'Firefox · macOS', isNew: true, current: false });

    // Sign-ins of the last month, newest first, with what each came to.
    expect(body.signIns.map(s => [s.action, s.result, s.ip, s.location, s.device, s.isNew])).toEqual([
      ['login.success',  'success',  '9.9.9.9',      'Zurich, Switzerland · Quad9',           'Firefox · macOS',  true],
      ['session.revoke', 'revoked',  null,           '',                                      'Unknown device',   false],
      ['logout',         'logout',   '8.8.8.8',      'Mountain View, United States · Google', 'Chrome · Windows', false],
      ['login.refused',  'refused',  '192.168.1.10', 'Private network',                       'Chrome · Windows', true],
      ['login.success',  'success',  '8.8.8.8',      'Mountain View, United States · Google', 'Safari · iPhone',  true],
      ['login.unlocked', 'unlocked', null,           '',                                      'Unknown device',   false],
      ['login.locked',   'locked',   '1.1.1.1',      'Sydney, Australia · Cloudflare',        'Chrome · Windows', true],
      ['login.failed',   'failure',  '1.1.1.1',      'Sydney, Australia · Cloudflare',        'Chrome · Windows', true],
      ['login.success',  'success',  '8.8.8.8',      'Mountain View, United States · Google', 'Chrome · Windows', false],
    ]);
    expect(body.signIns[3].reason).toBe('disabled');
    expect(body.signIns[6]).toMatchObject({ reason: null, lockMinutes: 15 });
    for (const s of body.signIns) expect(Object.keys(s)).toEqual(expect.arrayContaining(['at', 'action', 'result', 'reason', 'ip', 'location', 'device', 'isNew']));

    // What its automation is doing.
    expect(body.work).toEqual({
      watcher: { running: false, state: 'stopped', reason: null, enabled: true },
      autoSubmit: true,
      mailbox: { configured: true, address: 'inbox@test.com' },
      xero: {
        connected: true, method: 'oauth', needsReconnect: false, reason: null,
        lastRefreshedAt: new Date(now - 3 * DAY).toISOString(), organisations: ['Acme Pte Ltd', 'Acme Holdings'],
      },
      documents: {
        pending: 1, reviewNeeded: 1, reviewed: 0, submitting: 0, posted: 1, error: 0, duplicate: 1, reported: 0, total: 4,
        lastProcessedAt: new Date(now - 1 * DAY).toISOString(),
      },
      queue: { pending: 1, processing: 0, dead: 2, lastError: 'IMAP refused [redacted] for inbox@test.com' },
      storage: { ...storage, bytes: storage.receipts + storage.pdfs + storage.queue },
      geminiKeys: 2,
    });

    // What happened lately: records' history and what admins did to the
    // account, newest first; no sign-ins (they have their own list) and
    // nothing done to anyone else.
    expect(body.activity.map(a => [a.kind, a.summary, a.by])).toEqual([
      ['document', 'Created from an emailed PDF (from billing@acme.test): Acme Ltd INV-d, SGD 120.00. Marked as a duplicate of another record', 'System'],
      ['document', 'Created from an emailed PDF (from billing@acme.test): Acme Ltd INV-c, SGD 120.00', 'System'],
      ['document', 'Created from an emailed PDF (from billing@acme.test): Acme Ltd INV-b, SGD 120.00', 'System'],
      ['document', 'Created from an emailed PDF (from billing@acme.test): Acme Ltd INV-a, SGD 120.00', 'System'],
      ['account', `Turned auto-submit off for ${target.email}`, admin.email],
      ['account', `Reset the password of ${target.email}`, admin.email],
    ]);
    expect(body.activity[0]).toEqual({ at: expect.any(String), kind: 'document', summary: expect.any(String), by: 'System', recordId: 'd' });
  });

  test('never a secret: no password, hash, token, key or mailbox password anywhere in it', async () => {
    await busyAccount();
    const res = await get(target.id).expect(200);
    const text = JSON.stringify(res.body);
    const stored = users.findById(target.id);
    const secrets = [
      ...Object.values(SECRETS), ...LIST_KEYS, 'password123', stored.password, adminToken,
      ...users.getGeminiKeys(target.id).map(k => k.apiKey),
    ];
    // Read back from the store, so the scan covers what is really kept.
    const config = users.getUserConfig(target.id);
    for (const key of ['IMAP_PASS', 'XERO_CLIENT_SECRET', 'XERO_OAUTH_CLIENT_SECRET', 'XERO_OAUTH_REFRESH_TOKEN', 'Gemini_API_KEY']) {
      expect(config[key]).toBeTruthy();
      secrets.push(config[key]);
    }
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"(password|passwordHash|token|apiKey|refreshToken|IMAP_PASS)"/i);
  });

  test("an admin's own page marks the session they are using", async () => {
    const res = await get(admin.id).expect(200);
    expect(res.body.sessions).toEqual([expect.objectContaining({ sid: adminSid, current: true, ip: '203.0.113.7', device: 'Chrome · Windows' })]);
    expect(res.body.user).toMatchObject({ email: admin.email, role: 'admin' });
  });

  test('a new account: nothing yet, and nothing breaks', async () => {
    const res = await get(target.id).expect(200);
    expect(res.body).toMatchObject({
      sessions: [], signIns: [], activity: [],
      work: {
        watcher: { running: false, state: 'stopped', reason: null, enabled: false },
        autoSubmit: false,
        mailbox: { configured: false, address: expect.any(String) },
        xero: { connected: false, method: null, needsReconnect: false, organisations: [] },
        documents: { total: 0, lastProcessedAt: null },
        queue: { pending: 0, processing: 0, dead: 0, lastError: null },
        storage: { bytes: 0, receipts: 0, pdfs: 0, queue: 0 },
        geminiKeys: 0,
      },
    });
  });

  test('a demo account shows its Demo Company', async () => {
    const demo = await users.createUser(`demo-${now}@test.com`, 'demo12', 'user', { demo: true });
    const res = await get(demo.id).expect(200);
    expect(res.body.user.demo).toBe(true);
    expect(res.body.work.xero).toMatchObject({ connected: true, method: 'demo', needsReconnect: false, organisations: ['Demo Company Pte Ltd'] });
  });

  test('without the location databases, locations are empty and everything else is there', async () => {
    fs.rmSync(geoip.GEOIP_DIR, { recursive: true, force: true });
    await busyAccount();
    const res = await get(target.id).expect(200);
    expect(res.body.signIns.map(s => s.location)).toEqual(['', '', '', 'Private network', '', '', '', '', '']);
    expect(res.body.signIns[0].device).toBe('Firefox · macOS');
    expect(maxmind.open).not.toHaveBeenCalled();
  });

  test('at most 50 sign-ins, from the last 30 days', async () => {
    for (let i = 59; i >= 0; i--) event(target, 'login.failed', i * 0.4, { ip: '1.1.1.1' });
    const res = await get(target.id).expect(200);
    expect(res.body.signIns).toHaveLength(50);
    expect(Date.parse(res.body.signIns[49].at)).toBeGreaterThan(now - 30 * DAY);
  });

  test('storage is measured at most once every ten minutes', async () => {
    writeFile('pdfs/a.pdf', Buffer.alloc(100));
    expect((await get(target.id).expect(200)).body.work.storage.pdfs).toBe(100);
    writeFile('pdfs/b.pdf', Buffer.alloc(100));
    expect((await get(target.id).expect(200)).body.work.storage.pdfs).toBe(100);
    require('./admin-user-detail')._storageCache.clear();
    expect((await get(target.id).expect(200)).body.work.storage.pdfs).toBe(200);
  });

  test('an unknown account is a 404', async () => {
    const res = await get('no-such-user').expect(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  test('only for admins: 403 for anyone else, 401 without a session', async () => {
    const plain = await users.createUser(`plain-${now}@test.com`, 'password123', 'user');
    const sid = sessions.startSession(plain.id, { ip: '8.8.8.8' });
    await get(target.id, signSession(plain, { sid })).expect(403);
    await request(serverFor(app)).get(`/api/admin/users/${target.id}/detail`).expect(401);
  });
});
