// The minute tick behind live updates: active accounts only, every company
// on file, only the ones that are due, one at a time, and nothing it meets
// can escape to the timer. Real users, token cache and database; the look
// itself (xero/change-detector.js, tested on its own) is replaced, so
// nothing here reaches Xero.
jest.mock('xero-node', () => ({ AccountingApi: jest.fn() }));
jest.mock('../xero/change-detector', () => ({ due: jest.fn(), pollTenant: jest.fn() }));

const HOUR = 60 * 60 * 1000;

describe('jobs/xero-change-detector', () => {
  let job, users, tokenCache, detector, logger;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users      = require('../utils/users');
    tokenCache = require('../utils/token-cache');
    detector   = require('../xero/change-detector');
    logger     = require('../utils/logger');
    job        = require('./xero-change-detector');
    detector.due.mockReturnValue(true);
    detector.pollTenant.mockResolvedValue({ live: true, liveReason: null, changed: false, reason: null, calls: 2 });
  });

  afterEach(() => {
    job.stop();
    jest.useRealTimers();
  });

  let n = 0;
  async function account(name, tenants, { disabled = false } = {}) {
    const u = await users.createUser(`${name}${++n}-${Date.now()}@test.com`, 'password123', 'user');
    for (const t of tenants) tokenCache.forUser(u.id).cacheToken(t, `Org ${t}`, `token-${t}`, Date.now() + HOUR, 'oauth');
    if (disabled) users.setDisabled(u.id, true);
    return u.id;
  }
  const polled = () => detector.pollTenant.mock.calls.map(([userId, tenantId]) => `${userId}/${tenantId}`);

  test('the SDK is the mock, so nothing here can reach Xero', () => {
    expect(jest.isMockFunction(require('xero-node').AccountingApi)).toBe(true);
    expect(jest.isMockFunction(detector.pollTenant)).toBe(true);
  });

  test('looks at every due company of every active account, and leaves disabled accounts alone', async () => {
    const a   = await account('a', ['t1', 't2']);
    const b   = await account('b', ['t3']);
    const off = await account('off', ['t4'], { disabled: true });
    detector.due.mockImplementation((_u, tenantId) => tenantId !== 't2');
    detector.pollTenant.mockImplementation(async (_u, tenantId) =>
      ({ live: tenantId === 't1', liveReason: null, changed: tenantId === 't3', reason: null, calls: 2 }));

    const summary = await job.runOnce();

    expect(polled().sort()).toEqual([`${a}/t1`, `${b}/t3`].sort());
    expect(polled().some(p => p.startsWith(off))).toBe(false);
    expect(detector.due.mock.calls.map(([, t]) => t).sort()).toEqual(['t1', 't2', 't3']);
    expect(summary).toEqual({ accounts: 2, companies: 3, polled: 2, changed: 1, notLive: 1, failed: 0 });
  });

  test('passes the clock on, so every look in a tick reads the same time', async () => {
    await account('clock', ['t1']);
    const now = () => new Date('2026-10-10T09:00:00Z');
    await job.runOnce({ now });
    expect(detector.due.mock.calls[0][2]).toEqual(new Date('2026-10-10T09:00:00Z'));
    expect(detector.pollTenant.mock.calls[0][2]).toEqual({ now });
  });

  test('one company at a time', async () => {
    await account('x', ['t1', 't2']);
    await account('y', ['t3']);
    let inFlight = 0, most = 0;
    detector.pollTenant.mockImplementation(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise(r => setImmediate(r));
      inFlight--;
      return { live: true, changed: false };
    });
    await job.runOnce();
    expect(detector.pollTenant).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
  });

  test('never throws: an account that fails is counted and the tick carries on', async () => {
    const first  = await account('first', ['t1']);
    const second = await account('second', ['t2']);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    detector.due.mockImplementation(userId => { if (userId === first) throw new Error('database is locked'); return true; });

    const summary = await job.runOnce();

    expect(polled()).toEqual([`${second}/t2`]);
    expect(summary).toEqual({ accounts: 2, companies: 2, polled: 1, changed: 0, notLive: 0, failed: 1 });
    expect(warn).toHaveBeenCalledWith('Xero change detector failed for an account', { userId: first, error: 'database is locked' });
    warn.mockRestore();
  });

  test('never throws when a look rejects, which it should not', async () => {
    await account('reject', ['t1']);
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    detector.pollTenant.mockRejectedValue(new Error('unexpected'));
    await expect(job.runOnce()).resolves.toMatchObject({ failed: 1, polled: 0 });
    logger.warn.mockRestore();
  });

  test('never throws even when the accounts cannot be listed', async () => {
    jest.spyOn(users, 'getAllUsers').mockImplementation(() => { throw new Error('database is locked'); });
    await expect(job.runOnce()).resolves.toEqual({ accounts: 0, companies: 0, polled: 0, changed: 0, notLive: 0, failed: 0 });
    expect(detector.pollTenant).not.toHaveBeenCalled();
  });

  test('a tick while one is running gets that tick, so looks never overlap', async () => {
    await account('only', ['t1']);
    const [a, b] = await Promise.all([job.runOnce(), job.runOnce()]);
    expect(a).toBe(b);
    expect(detector.pollTenant).toHaveBeenCalledTimes(1);
  });

  test('start() ticks every minute however often it is called, and stop() ends it', async () => {
    // The account first: password hashing runs on real timers.
    const id = await account('scheduled', ['t1']);
    jest.useFakeTimers();
    const intervals = jest.spyOn(global, 'setInterval');

    job.start();
    job.start();
    expect(job.TICK_MS).toBe(60 * 1000);
    expect(intervals.mock.calls.filter(([, ms]) => ms === job.TICK_MS)).toHaveLength(1);
    expect(detector.pollTenant).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(job.TICK_MS);
    expect(polled()).toEqual([`${id}/t1`]);
    await jest.advanceTimersByTimeAsync(job.TICK_MS);
    expect(detector.pollTenant).toHaveBeenCalledTimes(2);

    job.stop();
    await jest.advanceTimersByTimeAsync(3 * job.TICK_MS);
    expect(detector.pollTenant).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});
