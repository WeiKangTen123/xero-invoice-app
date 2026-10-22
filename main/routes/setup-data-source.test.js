// PUT /api/setup/data-source: an admin switches their own account between
// their Xero and the generated Demo Company, and back. Only the flag moves:
// the Xero credentials and the real connection's health are left as they
// were. Refused to anyone but an admin, and while anything could be posted
// across the switch (a watcher on or wanted, documents still queued). Real
// routes, users, token cache, report cache and database; the watcher's
// connection and the queues' contents are stood in for where a test needs
// them busy.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

const XERO = {
  XERO_CONNECTION_TYPE: 'oauth', XERO_OAUTH_CLIENT_ID: 'oauth-id', XERO_OAUTH_CLIENT_SECRET: 'oauth-secret',
  XERO_OAUTH_REFRESH_TOKEN: 'rt-live', XERO_OAUTH_CONNECTED_AT: '2026-09-01T00:00:00.000Z',
  XERO_CLIENT_ID: 'cc-id', XERO_CLIENT_SECRET: 'cc-secret',
};

describe('PUT /api/setup/data-source', () => {
  let app, users, auditLog, tokenCache, settingsStore, registry, emailQueue, claimQueue, reportCache, jwtSecret, admin, member;

  beforeEach(async () => {
    jest.resetModules();
    jest.restoreAllMocks();
    require('../db/migrate').run();
    users         = require('../utils/users');
    auditLog      = require('../utils/audit-log');
    tokenCache    = require('../utils/token-cache');
    settingsStore = require('../utils/settings-store');
    registry      = require('../email/watcher-registry');
    emailQueue    = require('../queue/email-queue');
    claimQueue    = require('../claims/claim-queue');
    reportCache   = require('../xero/report-cache');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/setup', require('./setup'));
    admin  = await users.createUser('ada@test.com', 'password1234', 'admin');
    member = await users.createUser('bob@test.com', 'password1234', 'user');
    users.saveUserConfig(admin.id, XERO);
    // Nothing busy unless a test says so.
    jest.spyOn(registry, 'isRunning').mockReturnValue(false);
    jest.spyOn(emailQueue, 'getPending').mockReturnValue([]);
    jest.spyOn(claimQueue, 'getPending').mockReturnValue([]);
  });

  afterEach(() => jest.restoreAllMocks());

  const auth   = u => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const put    = (u, body) => request(serverFor(app)).put('/api/setup/data-source').set('Authorization', auth(u)).send(body);
  const isDemo = u => users.findById(u.id).is_demo;
  const events = () => auditLog.listAdminEvents({ action: 'account.data_source' }).events;

  test('needs a session', async () => {
    await request(serverFor(app)).put('/api/setup/data-source').send({ source: 'demo' }).expect(401);
  });

  test('anyone but an admin is refused, a demo account included, and nothing changes', async () => {
    const refused = 'Only an admin can choose sample data for their own account.';
    expect((await put(member, { source: 'demo' }).expect(403)).body).toEqual({ error: refused });
    expect(isDemo(member)).toBe(0);
    const demo = await users.createUser('demo@test.com', 'demo-fixture-2026', 'user', { demo: true });
    expect((await put(demo, { source: 'xero' }).expect(403)).body).toEqual({ error: refused });
    expect(isDemo(demo)).toBe(1);
    expect(events()).toEqual([]);
  });

  test('a source that is not xero or demo is refused', async () => {
    for (const body of [{}, { source: 'sample' }, { source: 'DEMO' }, { source: ['demo'] }, { source: true }]) {
      const res = await put(admin, body).expect(400);
      expect(res.body.error).toBe("source must be 'xero' or 'demo'");
    }
    expect(isDemo(admin)).toBe(0);
  });

  test('xero to demo and back: the flag follows, and each answer says where the account now is', async () => {
    expect((await put(admin, { source: 'demo' }).expect(200)).body).toEqual({ source: 'demo', demo: true });
    expect(isDemo(admin)).toBe(1);
    expect(users.isDemoUser(admin.id)).toBe(true);
    expect((await put(admin, { source: 'xero' }).expect(200)).body).toEqual({ source: 'xero', demo: false });
    expect(isDemo(admin)).toBe(0);
    expect(users.isDemoUser(admin.id)).toBe(false);
  });

  test('each switch is in the audit trail, with where it came from and went to', async () => {
    await put(admin, { source: 'demo' }).expect(200);
    await put(admin, { source: 'xero' }).expect(200);
    // Newest first.
    expect(events()).toMatchObject([
      { actorId: admin.id, actorEmail: 'ada@test.com', targetUserId: admin.id, targetEmail: 'ada@test.com', details: { from: 'demo', to: 'xero' } },
      { actorId: admin.id, actorEmail: 'ada@test.com', targetUserId: admin.id, targetEmail: 'ada@test.com', details: { from: 'xero', to: 'demo' } },
    ]);
  });

  test('asking for the mode the account is already in changes and records nothing, even with the watcher on', async () => {
    registry.isRunning.mockReturnValue(true);
    expect((await put(admin, { source: 'xero' }).expect(200)).body).toEqual({ source: 'xero', demo: false });
    expect(isDemo(admin)).toBe(0);
    users.setDemo(admin.id, true);
    expect((await put(admin, { source: 'demo' }).expect(200)).body).toEqual({ source: 'demo', demo: true });
    expect(isDemo(admin)).toBe(1);
    expect(events()).toEqual([]);
  });

  test('the account\'s cached report figures are dropped on a switch; another account\'s stay', async () => {
    const mine   = `pl:${admin.id}:t-real:2026-01-01:2026-09-30`;
    const theirs = `pl:${member.id}:t-real:2026-01-01:2026-09-30`;
    for (const key of [mine, theirs]) reportCache._cache.set(key, { data: { rows: [] }, fetchedAt: Date.now() });
    await put(admin, { source: 'demo' }).expect(200);
    expect(reportCache._cache.has(mine)).toBe(false);
    expect(reportCache._cache.has(theirs)).toBe(true);

    // And the other way: figures from the Demo Company do not outlive it.
    const demoKey = `pl:${admin.id}:demo-company`;
    reportCache._cache.set(demoKey, { data: { rows: [] }, fetchedAt: Date.now() });
    await put(admin, { source: 'xero' }).expect(200);
    expect(reportCache._cache.has(demoKey)).toBe(false);
  });

  test('the Xero credentials and the real connection\'s health are untouched across a round trip, so no reconnect is needed', async () => {
    tokenCache.markRefreshed(admin.id, { method: 'oauth', grantedScopes: ['offline_access', 'accounting.invoices'], at: new Date('2026-10-18T00:00:00Z') });
    tokenCache.markScopesRefused(admin.id, ['accounting.reports.balancesheet.read']);
    const config = users.getUserConfig(admin.id);
    const health = tokenCache.getHealth(admin.id);
    expect(config).toMatchObject(XERO);

    await put(admin, { source: 'demo' }).expect(200);
    expect(users.getUserConfig(admin.id)).toEqual(config);
    // On sample data the account reads as the Demo Company; the real record
    // waits underneath.
    expect(tokenCache.getHealth(admin.id)).toMatchObject({ method: 'demo', needsReconnect: false });
    expect(tokenCache.getHealth(admin.id, { stored: true })).toEqual(health);

    await put(admin, { source: 'xero' }).expect(200);
    expect(users.getUserConfig(admin.id)).toEqual(config);
    expect(tokenCache.getHealth(admin.id)).toEqual(health);
  });

  describe('busy: refused with nothing changed while anything could post across the switch', () => {
    async function refusedWith(error, source = 'demo') {
      const before = isDemo(admin);
      const res = await put(admin, { source }).expect(409);
      expect(res.body).toEqual({ error, code: 'BUSY' });
      expect(isDemo(admin)).toBe(before);
      expect(events()).toEqual([]);
    }
    const STOP_WATCHER = 'Stop the email watcher on Automation first, then switch.';

    test('the email watcher is connected', async () => {
      registry.isRunning.mockReturnValue(true);
      await refusedWith(STOP_WATCHER);
      expect(registry.isRunning).toHaveBeenCalledWith(admin.id);
    });

    // A watcher waiting out a reconnect has no connection, so isRunning is
    // false, but it comes back on its own: wanted is as good as running.
    test('the email watcher is switched on, though not connected', async () => {
      settingsStore.forUser(admin.id).setWatcherEnabled(true);
      await refusedWith(STOP_WATCHER);
      // Another account's watcher is not this account's business.
      settingsStore.forUser(admin.id).setWatcherEnabled(false);
      settingsStore.forUser(member.id).setWatcherEnabled(true);
      await put(admin, { source: 'demo' }).expect(200);
    });

    test('the watcher check holds in the other direction too', async () => {
      users.setDemo(admin.id, true);
      settingsStore.forUser(admin.id).setWatcherEnabled(true);
      await refusedWith(STOP_WATCHER, 'xero');
    });

    test('one email still queued, said in the singular', async () => {
      emailQueue.getPending.mockReturnValue([{ id: 'job-1', status: 'pending' }]);
      await refusedWith('1 document is still being processed. Switch once they finish.');
      expect(emailQueue.getPending).toHaveBeenCalledWith(admin.id);
    });

    test('email and claim jobs are counted together', async () => {
      emailQueue.getPending.mockReturnValue([{ id: 'job-1' }, { id: 'job-2' }]);
      claimQueue.getPending.mockReturnValue([{ id: 'claim-1' }]);
      await refusedWith('3 documents are still being processed. Switch once they finish.');
    });

    test('a claim still in flight on its own', async () => {
      claimQueue.getPending.mockReturnValue([{ id: 'claim-1' }, { id: 'claim-2' }]);
      await refusedWith('2 documents are still being processed. Switch once they finish.');
      expect(claimQueue.getPending).toHaveBeenCalledWith(admin.id);
    });

    test('a busy refusal leaves the cached report figures alone', async () => {
      const key = `pl:${admin.id}:t-real`;
      reportCache._cache.set(key, { data: {}, fetchedAt: Date.now() });
      registry.isRunning.mockReturnValue(true);
      await refusedWith(STOP_WATCHER);
      expect(reportCache._cache.has(key)).toBe(true);
    });
  });

  test('a failure to record the audit event does not fail the switch', async () => {
    jest.spyOn(auditLog, 'recordAdminEvent').mockImplementation(() => { throw new Error('disk full'); });
    expect((await put(admin, { source: 'demo' }).expect(200)).body).toEqual({ source: 'demo', demo: true });
    expect(isDemo(admin)).toBe(1);
  });
});
