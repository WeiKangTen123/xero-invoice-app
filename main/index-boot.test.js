// What index.js does once the server is listening, and the secrets check it
// runs before anything else. app.listen is stubbed to hand back its callback
// instead of listening, so the boot recoveries run when a test says so; the
// recoveries themselves are spied on, and the 3s Xero retry is held by fake
// timers and never fires.
jest.mock('./email/idle-sweeper', () => ({ start: jest.fn() }));
jest.mock('./utils/invoice-handler', () => ({
  createHandler:       jest.fn(() => ({})),
  submitInvoiceToXero: jest.fn(async () => {}),
}));

const PROCESS_EVENTS = ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'];
let app, onListen, logger, registry, emailWorker, claimWorker, receipts, listenersBefore, originalResume;

const flush = () => new Promise(resolve => setImmediate(resolve));

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  process.env.SLACK_WEBHOOK_URL = '';
  listenersBefore = Object.fromEntries(PROCESS_EVENTS.map(e => [e, process.listeners(e)]));
  jest.spyOn(require('express').application, 'listen').mockImplementation((...args) => {
    onListen = args.find(a => typeof a === 'function');
    return { close: cb => cb && cb() };
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});

  app         = require('./index');
  logger      = require('./utils/logger');
  registry    = require('./email/watcher-registry');
  emailWorker = require('./queue/email-worker');
  claimWorker = require('./claims/claim-worker');
  receipts    = require('./routes/receipts');
  originalResume = Object.getOwnPropertyDescriptor(registry, 'resumeWatchers');
});

beforeEach(() => {
  jest.spyOn(emailWorker, 'recoverPendingJobs').mockImplementation(() => {});
  jest.spyOn(claimWorker, 'recoverPendingJobs').mockImplementation(() => {});
  jest.spyOn(receipts, 'resumeUnreadReceipts').mockResolvedValue(undefined);
  jest.spyOn(logger, 'warn');
  jest.spyOn(logger, 'error');
});

afterEach(() => {
  // The real export, whatever the registry module holds today.
  if (originalResume) Object.defineProperty(registry, 'resumeWatchers', originalResume);
  else delete registry.resumeWatchers;
  emailWorker.recoverPendingJobs.mockRestore();
  claimWorker.recoverPendingJobs.mockRestore();
  receipts.resumeUnreadReceipts.mockRestore();
  logger.warn.mockRestore();
  logger.error.mockRestore();
  jest.clearAllTimers();
});

afterAll(() => {
  for (const e of PROCESS_EVENTS) {
    for (const l of process.listeners(e)) if (!listenersBefore[e].includes(l)) process.removeListener(e, l);
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const warned = text => logger.warn.mock.calls.some(([msg]) => msg.includes(text));
const fatalLogged = () => logger.error.mock.calls.some(([msg]) => /^FATAL/.test(msg));

describe('index — mailbox watchers resume at boot', () => {
  test('the listen callback resumes them, after the queue and receipt recoveries', async () => {
    registry.resumeWatchers = jest.fn(async () => 2);
    onListen();
    await flush();
    expect(registry.resumeWatchers).toHaveBeenCalledTimes(1);
    const order = fn => fn.mock.invocationCallOrder[0];
    expect(order(registry.resumeWatchers)).toBeGreaterThan(order(emailWorker.recoverPendingJobs));
    expect(order(registry.resumeWatchers)).toBeGreaterThan(order(claimWorker.recoverPendingJobs));
    expect(order(registry.resumeWatchers)).toBeGreaterThan(order(receipts.resumeUnreadReceipts));
  });

  test('a resume that throws does not crash startup — a warning, nothing fatal', async () => {
    registry.resumeWatchers = jest.fn(() => { throw new Error('IMAP credentials unreadable'); });
    expect(() => onListen()).not.toThrow();
    await flush();
    expect(registry.resumeWatchers).toHaveBeenCalled();
    expect(warned('Mailbox watcher resume failed')).toBe(true);
    expect(logger.warn.mock.calls.find(([m]) => m === 'Mailbox watcher resume failed')[1]).toEqual({ error: 'IMAP credentials unreadable' });
    expect(fatalLogged()).toBe(false);
  });

  test('a resume that rejects, or a registry without the hook, only warns', async () => {
    registry.resumeWatchers = jest.fn(async () => { throw new Error('mail server down'); });
    await expect(app.resumeMailboxWatchers()).resolves.toBeUndefined();
    expect(warned('Mailbox watcher resume failed')).toBe(true);

    delete registry.resumeWatchers;
    await expect(app.resumeMailboxWatchers()).resolves.toBeUndefined();
    expect(warned('the watcher registry has no resumeWatchers()')).toBe(true);
    expect(fatalLogged()).toBe(false);
  });
});

// The rules behind the refusal tested in a real process by index-startup.test.js.
describe('index — checkSecrets', () => {
  const KEY = 'ab'.repeat(32), STRONG = 'k'.repeat(48);

  test('missing secrets are refusals outside tests, and never under NODE_ENV=test', () => {
    expect(app.checkSecrets({ NODE_ENV: 'production' }).refusals).toEqual([
      expect.stringMatching(/^JWT_SECRET is not set/), expect.stringMatching(/^ENCRYPTION_KEY not set/),
    ]);
    expect(app.checkSecrets({ NODE_ENV: 'development', JWT_SECRET: STRONG }).refusals).toEqual([expect.stringMatching(/^ENCRYPTION_KEY not set/)]);
    expect(app.checkSecrets({ NODE_ENV: 'test' }).refusals).toEqual([]);
  });

  test('a weak JWT_SECRET is a warning, not a refusal', () => {
    expect(app.checkSecrets({ NODE_ENV: 'production', JWT_SECRET: 'short', ENCRYPTION_KEY: KEY }))
      .toEqual({ refusals: [], warnings: [expect.stringMatching(/only 5 characters/)] });
    expect(app.checkSecrets({ NODE_ENV: 'production', JWT_SECRET: 'change_this_to_a_long_random_string', ENCRYPTION_KEY: KEY }))
      .toEqual({ refusals: [], warnings: [expect.stringMatching(/published in this repository/)] });
  });

  test('good secrets pass clean — including a key crypto.js reads though it is not lower-case hex', () => {
    expect(app.checkSecrets({ NODE_ENV: 'production', JWT_SECRET: STRONG, ENCRYPTION_KEY: KEY })).toEqual({ refusals: [], warnings: [] });
    expect(app.checkSecrets({ NODE_ENV: 'production', JWT_SECRET: STRONG, ENCRYPTION_KEY: KEY.toUpperCase() + 'z' })).toEqual({ refusals: [], warnings: [] });
  });
});
