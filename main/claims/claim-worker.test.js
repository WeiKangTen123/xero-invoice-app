// A disabled account's background jobs must not run. Disabling stops the
// worker (routes/admin.js), but a tick already scheduled, a kick or boot
// recovery can still reach a queued job.
const settle = () => new Promise(r => setTimeout(r, 50));

describe('claims/claim-worker — disabled accounts', () => {
  let jobs, users, user, ran;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('../utils/users');
    jobs  = require('../jobs');
    user  = await users.createUser(`cw${Date.now()}@test.com`, 'password123', 'user');
    ran   = [];
    jobs.registerJobType('probe', {
      run({ userId, job, deps }) {
        ran.push(userId);
        deps.onSettle({ id: job.id, stage: 'done', error: null, result: {}, receiptsTotal: 0, receiptsRead: 0, rowsTotal: 0 });
      },
    });
  });
  afterEach(() => { jobs._worker._reset(); });

  const enqueue = userId => jobs.enqueue(userId, { type: 'probe', label: 'probe', payload: { files: [] } }).job;

  test('a job queued for a disabled account does not run, and runs once the account is enabled', async () => {
    const job = enqueue(user.id);
    users.setDisabled(user.id, true);
    jobs.startWorker(user.id);
    await settle();

    expect(ran).toEqual([]);
    // Left exactly as it was: still queued, no attempt spent.
    expect(jobs.get(user.id, job.id)).toMatchObject({ stage: 'queued', attempts: 0 });

    users.setDisabled(user.id, false);
    jobs.startWorker(user.id);
    await settle();
    expect(ran).toEqual([user.id]);
    expect(jobs.get(user.id, job.id).stage).toBe('done');
  });

  test('boot recovery starts nothing for a disabled account', async () => {
    const other = await users.createUser(`cw-other${Date.now()}@test.com`, 'password123', 'user');
    enqueue(user.id);
    enqueue(other.id);
    users.setDisabled(user.id, true);

    await jobs.recoverPendingJobs();
    await settle();
    expect(ran).toEqual([other.id]);
  });
});
