// The 3-hourly Xero status read-back is started by index.js once the server
// is listening, after the boot jobs, and nothing about it can stop the boot.
// Loaded as index-keepalive.test.js loads it: app.listen hands back its
// callback instead of listening, the recoveries are spied on, and the 3s Xero
// retry is held by fake timers and never fires.
//
// The job module is replaced here. Its factory throws while mockLoadError is
// set, the way a missing or broken module throws from require; once it loads,
// jest keeps that one object, and each test sets its start().
jest.mock('./email/idle-sweeper', () => ({ start: jest.fn() }));
jest.mock('./utils/invoice-handler', () => ({
  createHandler:       jest.fn(() => ({})),
  submitInvoiceToXero: jest.fn(async () => {}),
}));
const mockKeepalive = { start: jest.fn() };
jest.mock('./jobs/xero-keepalive', () => mockKeepalive);
let mockLoadError = null;
const mockStatusSync = { start: jest.fn() };
jest.mock('./jobs/xero-status-sync', () => {
  if (mockLoadError) throw mockLoadError;
  return mockStatusSync;
});

const PROCESS_EVENTS = ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'];
let onListen, logger, registry, emailWorker, claimWorker, receipts, listenersBefore, originalResume;

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

  require('./index');
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
  registry.resumeWatchers = jest.fn(async () => 0);
  mockKeepalive.start = jest.fn();
  mockStatusSync.start = jest.fn();
  jest.spyOn(logger, 'warn');
  jest.spyOn(logger, 'error');
});

afterEach(() => {
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

const syncWarning = () => logger.warn.mock.calls.find(([msg]) => msg === 'Xero status sync start failed');
const fatalLogged = () => logger.error.mock.calls.some(([msg]) => /^FATAL/.test(msg));

// First, while the module has never loaded: jest caches a mock module only
// once its factory has returned.
test('a status-sync module that is missing costs a warning, not the boot', async () => {
  mockLoadError = Object.assign(new Error("Cannot find module './jobs/xero-status-sync'"), { code: 'MODULE_NOT_FOUND' });
  try {
    expect(() => onListen()).not.toThrow();
    await flush();
    expect(syncWarning()[1]).toEqual({ error: expect.stringMatching(/^Cannot find module '\.\/jobs\/xero-status-sync'/) });
    expect(fatalLogged()).toBe(false);
    // Everything else at boot ran regardless.
    expect(registry.resumeWatchers).toHaveBeenCalledTimes(1);
    expect(mockKeepalive.start).toHaveBeenCalledTimes(1);
  } finally { mockLoadError = null; }
});

test('the listen callback starts it once, after the boot jobs and the keep-alive', async () => {
  onListen();
  await flush();
  expect(mockStatusSync.start).toHaveBeenCalledTimes(1);
  const order = fn => fn.mock.invocationCallOrder[0];
  for (const before of [emailWorker.recoverPendingJobs, claimWorker.recoverPendingJobs, receipts.resumeUnreadReceipts, registry.resumeWatchers, mockKeepalive.start]) {
    expect(order(mockStatusSync.start)).toBeGreaterThan(order(before));
  }
  expect(syncWarning()).toBeUndefined();
});

test('a start() that throws only warns', async () => {
  mockStatusSync.start = jest.fn(() => { throw new Error('no invoices table'); });
  expect(() => onListen()).not.toThrow();
  await flush();
  expect(mockStatusSync.start).toHaveBeenCalledTimes(1);
  expect(syncWarning()[1]).toEqual({ error: 'no invoices table' });
  expect(fatalLogged()).toBe(false);
});
