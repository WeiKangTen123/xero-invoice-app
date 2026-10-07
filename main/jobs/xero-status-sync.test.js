// The 3-hourly read-back of Xero statuses: active accounts only, one at a
// time, and nothing it meets can escape to the timer. Real users and
// database; the per-account read (xero/status-sync.js, tested on its own) is
// replaced, so nothing here reaches Xero.
jest.mock('../xero/status-sync', () => ({ syncUser: jest.fn() }));

describe('jobs/xero-status-sync', () => {
  let job, users, statusSync;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users      = require('../utils/users');
    statusSync = require('../xero/status-sync');
    job        = require('./xero-status-sync');
    statusSync.syncUser.mockResolvedValue({ checked: 2, updated: 1, failedTenants: 0 });
  });

  afterEach(() => {
    job.stop();
    jest.useRealTimers();
  });

  let n = 0;
  async function account(name, { disabled = false } = {}) {
    const u = await users.createUser(`${name}${++n}-${Date.now()}@test.com`, 'password123', 'user');
    if (disabled) users.setDisabled(u.id, true);
    return u.id;
  }

  test('reads back every active account and leaves disabled ones alone', async () => {
    const a = await account('a');
    const b = await account('b');
    const off = await account('off', { disabled: true });

    const summary = await job.runOnce();

    const synced = statusSync.syncUser.mock.calls.map(([id]) => id);
    expect(synced.sort()).toEqual([a, b].sort());
    expect(synced).not.toContain(off);
    expect(summary).toEqual({ accounts: 2, checked: 4, updated: 2, failedTenants: 0, failed: 0 });
  });

  test('one account at a time', async () => {
    for (const name of ['x', 'y', 'z']) await account(name);
    let inFlight = 0, most = 0;
    statusSync.syncUser.mockImplementation(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise(r => setImmediate(r));
      inFlight--;
      return { checked: 0, updated: 0, failedTenants: 0 };
    });
    await job.runOnce();
    expect(statusSync.syncUser).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
  });

  test('never throws: an account that fails is counted and the run carries on', async () => {
    const first  = await account('first');
    const second = await account('second');
    statusSync.syncUser.mockImplementation(async id => {
      if (id === first) throw new Error('database is locked');
      return { checked: 1, updated: 0, failedTenants: 1 };
    });

    const summary = await job.runOnce();

    expect(statusSync.syncUser.mock.calls.map(([id]) => id)).toEqual([first, second]);
    expect(summary).toEqual({ accounts: 2, checked: 1, updated: 0, failedTenants: 1, failed: 1 });
  });

  test('never throws even when the accounts cannot be listed', async () => {
    jest.spyOn(users, 'getAllUsers').mockImplementation(() => { throw new Error('database is locked'); });
    await expect(job.runOnce()).resolves.toEqual({ accounts: 0, checked: 0, updated: 0, failedTenants: 0, failed: 0 });
    expect(statusSync.syncUser).not.toHaveBeenCalled();
  });

  test('a call while a run is going gets that run', async () => {
    await account('only');
    const [a, b] = await Promise.all([job.runOnce(), job.runOnce()]);
    expect(a).toBe(b);
    expect(statusSync.syncUser).toHaveBeenCalledTimes(1);
  });

  test('start() runs once after boot has settled and then every three hours, however often it is called', async () => {
    // The account first: password hashing runs on real timers.
    const id = await account('scheduled');
    jest.useFakeTimers();
    const intervals = jest.spyOn(global, 'setInterval');
    const delays    = jest.spyOn(global, 'setTimeout');

    job.start();
    job.start();
    expect(job.EVERY_MS).toBe(3 * 60 * 60 * 1000);
    expect(intervals.mock.calls.filter(([, ms]) => ms === job.EVERY_MS)).toHaveLength(1);
    expect(delays.mock.calls.filter(([, ms]) => ms === job.FIRST_RUN_DELAY_MS)).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(job.FIRST_RUN_DELAY_MS);
    expect(statusSync.syncUser.mock.calls.map(([u]) => u)).toEqual([id]);

    await jest.advanceTimersByTimeAsync(job.EVERY_MS);
    expect(statusSync.syncUser).toHaveBeenCalledTimes(2);

    job.stop();
    await jest.advanceTimersByTimeAsync(job.EVERY_MS);
    expect(statusSync.syncUser).toHaveBeenCalledTimes(2);
  });
});
