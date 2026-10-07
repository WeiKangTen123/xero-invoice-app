// The worker side of the attempt count. A mail that crashed the server was
// rerun on every boot with its attempts stuck at 1, so pm2 restarted into the
// same crash until it gave up and the app was down for every account.
jest.mock('../email/parser', () => ({ parseInvoice: jest.fn() }));
jest.mock('../utils/users', () => ({ isActive: () => true }));

const fs   = require('fs');
const path = require('path');

const settle = (ms = 80) => new Promise(r => setTimeout(r, ms));
const email  = subject => ({ from: { text: 'billing@vendor.test' }, subject, text: 'body', attachments: [] });
const read   = (userId, id) => JSON.parse(fs.readFileSync(
  path.join(require('../utils/paths').usersDir(), userId, 'email-queue', `${id}.que`), 'utf8'));

// A fresh queue, worker and parser, as a restarted process has them: nothing
// in memory carries over, only the files on disk.
function boot() {
  jest.resetModules();
  return { queue: require('./email-queue'), worker: require('./email-worker'), parser: require('../email/parser') };
}

describe('queue/email-worker — attempts and retries', () => {
  let p, user;
  beforeEach(() => { user = `ewa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; });
  afterEach(() => p && p.worker.stopWorker(user));

  test('a job that takes the server down is counted on every boot and goes dead after the limit', async () => {
    p = boot();
    const job = p.queue.enqueue(user, email('Crashes the parser'));
    for (let run = 1; run <= p.queue.MAX_ATTEMPTS; run++) {
      // Never settles: the process dies mid-parse and the job never reports back.
      p.parser.parseInvoice.mockImplementation(() => new Promise(() => {}));
      p.worker.startWorker(user, jest.fn());
      await settle();
      expect(p.parser.parseInvoice).toHaveBeenCalledTimes(1);
      expect(read(user, job.id)).toMatchObject({ status: 'processing', attempts: run });
      p.worker.stopWorker(user);
      p = boot();
    }

    // The boot after the last attempt: the job is not run again.
    const onInvoice = jest.fn();
    p.worker.startWorker(user, onInvoice);
    await settle();
    expect(p.parser.parseInvoice).not.toHaveBeenCalled();
    expect(onInvoice).not.toHaveBeenCalled();
    expect(read(user, job.id)).toMatchObject({ status: 'dead', attempts: p.queue.MAX_ATTEMPTS });
    expect(read(user, job.id).lastError).toMatch(/never finished/);
    expect(p.queue.getPending(user)).toEqual([]);
  });

  test('a failure is not retried at once, and does not hold up the mail behind it', async () => {
    p = boot();
    const a = p.queue.enqueue(user, email('A'));
    await settle(5);                                   // createdAt orders A before B
    const b = p.queue.enqueue(user, email('B'));
    p.parser.parseInvoice.mockImplementation(async m => {
      if (m.subject === 'A') throw new Error('429 rate limited');
      return [{ invoiceNumber: 'B-1' }];
    });
    const onInvoice = jest.fn();
    p.worker.startWorker(user, onInvoice);
    await settle(200);

    expect(p.parser.parseInvoice.mock.calls.filter(([m]) => m.subject === 'A')).toHaveLength(1);
    expect(onInvoice).toHaveBeenCalledWith({ invoiceNumber: 'B-1' });
    const waiting = read(user, a.id);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1, lastError: '429 rate limited' });
    expect(Date.parse(waiting.nextAttemptAt)).toBeGreaterThan(Date.now() + 50 * 1000);
    expect(p.queue.getPending(user).map(j => j.id)).toEqual([a.id]);
    expect(fs.existsSync(path.join(require('../utils/paths').usersDir(), user, 'email-queue', `${b.id}.que`))).toBe(false);
  });

  test('a worker restarted while a job runs does not claim that job a second time', async () => {
    p = boot();
    const job = p.queue.enqueue(user, email('Slow'));
    let finish;
    p.parser.parseInvoice.mockImplementation(() => new Promise(r => { finish = r; }));
    const onInvoice = jest.fn();
    p.worker.startWorker(user, onInvoice);
    await settle();
    p.worker.stopWorker(user);                         // a watcher restart rebuilds the worker
    p.worker.startWorker(user, onInvoice);
    await settle();

    expect(p.parser.parseInvoice).toHaveBeenCalledTimes(1);
    expect(read(user, job.id).attempts).toBe(1);

    finish([{ invoiceNumber: 'S-1' }]);
    await settle();
    expect(onInvoice).toHaveBeenCalledTimes(1);
    expect(p.queue.getPending(user)).toEqual([]);
  });
});
