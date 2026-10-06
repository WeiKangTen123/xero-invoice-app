// A disabled account's mail must not be worked on. Disabling stops the worker
// (routes/admin.js), but a tick already scheduled, a kick from a watcher
// mid-fetch or boot recovery can still reach a queued job, and a job that runs
// stores invoices and, with auto-submit on, posts them to that account's Xero.
jest.mock('../email/parser', () => ({ parseInvoice: jest.fn() }));

const settle = () => new Promise(r => setTimeout(r, 50));
const parsed = () => ({ from: { text: 'billing@vendor.test' }, subject: 'Invoice 42', text: 'body', attachments: [] });

describe('queue/email-worker — disabled accounts', () => {
  let worker, queue, users, parser, user;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users  = require('../utils/users');
    queue  = require('./email-queue');
    parser = require('../email/parser');
    worker = require('./email-worker');
    user   = await users.createUser(`ew${Date.now()}@test.com`, 'password123', 'user');
    parser.parseInvoice.mockResolvedValue([{ invoiceNumber: 'INV-42' }]);
  });
  afterEach(() => { worker.stopWorker(user.id); });

  test('the control: an enabled account\'s queued job is parsed and handed on', async () => {
    queue.enqueue(user.id, parsed());
    const onInvoice = jest.fn();
    worker.startWorker(user.id, onInvoice);
    await settle();
    expect(onInvoice).toHaveBeenCalledWith({ invoiceNumber: 'INV-42' });
    expect(queue.getPending(user.id)).toEqual([]);
  });

  test('a job queued for a disabled account is not touched, and runs once the account is enabled', async () => {
    const job = queue.enqueue(user.id, parsed());
    users.setDisabled(user.id, true);
    const onInvoice = jest.fn();
    worker.startWorker(user.id, onInvoice);
    await settle();

    expect(parser.parseInvoice).not.toHaveBeenCalled();
    expect(onInvoice).not.toHaveBeenCalled();
    // Left exactly as it was: still pending, no attempt spent.
    expect(queue.getPending(user.id)).toEqual([expect.objectContaining({ id: job.id, status: 'pending', attempts: 0 })]);

    users.setDisabled(user.id, false);
    worker.startWorker(user.id, onInvoice);
    await settle();
    expect(onInvoice).toHaveBeenCalledTimes(1);
    expect(queue.getPending(user.id)).toEqual([]);
  });

  test('a disable that lands while the mail is being parsed stops it before anything is stored', async () => {
    // Parsing is seconds of LLM calls: the likeliest moment for the disable.
    parser.parseInvoice.mockImplementation(async () => {
      users.setDisabled(user.id, true);
      return [{ invoiceNumber: 'INV-42' }];
    });
    const job = queue.enqueue(user.id, parsed());
    const onInvoice = jest.fn();
    worker.startWorker(user.id, onInvoice);
    await settle();

    expect(parser.parseInvoice).toHaveBeenCalledTimes(1);
    expect(onInvoice).not.toHaveBeenCalled();
    // Kept, not failed or deleted: it runs again if the account is enabled.
    expect(queue.getPending(user.id).map(j => j.id)).toEqual([job.id]);
  });

  test('boot recovery builds nothing for a disabled account', async () => {
    const other = await users.createUser(`ew-other${Date.now()}@test.com`, 'password123', 'user');
    queue.enqueue(user.id, parsed());
    queue.enqueue(other.id, parsed());
    users.setDisabled(user.id, true);

    const onInvoice = jest.fn();
    const makeOnInvoice = jest.fn(async () => onInvoice);
    await worker.recoverPendingJobs(makeOnInvoice);
    await settle();

    expect(makeOnInvoice.mock.calls.map(([id]) => id)).toEqual([other.id]);
    expect(onInvoice).toHaveBeenCalledTimes(1);
    expect(queue.getPending(user.id)).toHaveLength(1);
    worker.stopWorker(other.id);
  });
});
