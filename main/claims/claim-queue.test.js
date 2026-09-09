const fs = require('fs');
const path = require('path');
const claimQueue = require('./claim-queue');
const claimWorker = require('./claim-worker');

describe('claims/claim-queue', () => {
  const userId = `test-user-queue-${Date.now()}`;

  afterEach(() => {
    claimWorker._reset();
    claimQueue.clearAll(userId);
  });

  afterAll(() => {
    try {
      fs.rmSync(path.join(__dirname, '../data/users', userId), { recursive: true, force: true });
    } catch {}
  });

  test('enqueue writes .que and binary payload blobs to disk atomically', () => {
    const archives = [{ name: 'receipts.zip', buffer: Buffer.from('zip-content-123') }];
    const forms    = [{ name: 'claim.xlsx', buffer: Buffer.from('excel-content-456') }];

    const { job, error } = claimQueue.enqueue(userId, { archives, forms, label: 'May Claim' });
    expect(error).toBeUndefined();
    expect(job.id).toBeTruthy();
    expect(job.stage).toBe('queued');
    expect(job.payload.archives).toHaveLength(1);
    expect(job.payload.forms).toHaveLength(1);

    // Verify files on disk
    const stored = claimQueue.get(userId, job.id);
    expect(stored).toBeTruthy();
    expect(stored.label).toBe('May Claim');

    // Read payload buffers back
    const payload = claimQueue.readPayload(userId, stored);
    expect(payload.archives[0].buffer.toString()).toBe('zip-content-123');
    expect(payload.forms[0].buffer.toString()).toBe('excel-content-456');
  });

  test('enqueue rejects with friendly error when user queue limit is reached', () => {
    for (let i = 0; i < claimQueue.MAX_QUEUED_PER_USER; i++) {
      const res = claimQueue.enqueue(userId, { archives: [], forms: [], label: `Claim ${i}` });
      expect(res.job).toBeTruthy();
    }

    const overflow = claimQueue.enqueue(userId, { archives: [], forms: [], label: 'Overflow' });
    expect(overflow.job).toBeUndefined();
    expect(overflow.error).toMatch(/already have 10 imports queued/i);
  });

  test('markRunning increments attempt count and transitions stage', () => {
    const { job } = claimQueue.enqueue(userId, { archives: [], forms: [] });
    expect(job.attempts).toBe(0);

    const running = claimQueue.markRunning(userId, job.id);
    expect(running.attempts).toBe(1);
    expect(running.stage).toBe('unpacking');

    const runningAgain = claimQueue.markRunning(userId, job.id);
    expect(runningAgain.attempts).toBe(2);
  });

  test('terminal stages automatically clean up binary payload blobs', () => {
    const archives = [{ name: 'a.zip', buffer: Buffer.from('blob-to-delete') }];
    const { job } = claimQueue.enqueue(userId, { archives, forms: [] });
    const ref = job.payload.archives[0].ref;
    const blobPath = path.join(__dirname, '../data/users', userId, 'claim-queue', ref);
    expect(fs.existsSync(blobPath)).toBe(true);

    claimQueue.save(userId, { id: job.id, stage: 'done' });
    expect(fs.existsSync(blobPath)).toBe(false);
  });

  test('getPoisoned flags jobs that failed MAX_ATTEMPTS times', () => {
    const { job } = claimQueue.enqueue(userId, { archives: [], forms: [] });
    for (let i = 0; i < claimQueue.MAX_ATTEMPTS; i++) {
      claimQueue.markRunning(userId, job.id);
    }
    const poisoned = claimQueue.getPoisoned(userId);
    expect(poisoned.some(p => p.id === job.id)).toBe(true);
  });

  test('worker processes enqueued jobs and sets aside poisoned jobs', async () => {
    const { job } = claimQueue.enqueue(userId, { archives: [], forms: [] });
    // Manually push attempts to poison threshold
    for (let i = 0; i < claimQueue.MAX_ATTEMPTS; i++) {
      claimQueue.markRunning(userId, job.id);
    }

    claimWorker.startWorker(userId, {
      parseReceipts: jest.fn(),
      storeReceipt: jest.fn(),
      createRecord: jest.fn(),
      suggest: jest.fn(),
    });

    // Worker tick should poison-retire it
    await new Promise(r => setTimeout(r, 50));
    const stored = claimQueue.get(userId, job.id);
    expect(stored.stage).toBe('failed');
    expect(stored.error).toMatch(/protect system stability/i);
  });
});
