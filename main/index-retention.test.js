// Retention at boot and daily. index.js prunes the old events and sweeps the
// data folders of deleted accounts (utils/account-cleanup.js) as it loads,
// before the queue recoveries look through those folders, and once the
// server is listening starts the daily run (jobs/account-retention.js), which
// nothing about can stop the boot. Loaded as index-geoip.test.js loads it:
// app.listen hands back its callback instead of listening, the recoveries are
// spied on, and the timers are fake and never fire.
//
// The job module is replaced here. Its factory throws while mockLoadError is
// set, the way a missing or broken module throws from require; once it loads,
// jest keeps that one object, and each test sets its start().
jest.mock('./email/idle-sweeper', () => ({ start: jest.fn() }));
jest.mock('./utils/invoice-handler', () => ({
  createHandler:       jest.fn(() => ({})),
  submitInvoiceToXero: jest.fn(async () => {}),
}));
const mockKeepalive  = { start: jest.fn() };
const mockStatusSync = { start: jest.fn() };
const mockDetector   = { start: jest.fn() };
const mockGeoip      = { start: jest.fn() };
jest.mock('./jobs/xero-keepalive', () => mockKeepalive);
jest.mock('./jobs/xero-status-sync', () => mockStatusSync);
jest.mock('./jobs/xero-change-detector', () => mockDetector);
jest.mock('./jobs/geoip-refresh', () => mockGeoip);
let mockLoadError = null;
const mockRetention = { start: jest.fn() };
jest.mock('./jobs/account-retention', () => {
  if (mockLoadError) throw mockLoadError;
  return mockRetention;
});
const mockSweep = jest.fn(() => ({ removed: [], kept: [] }));
jest.mock('./utils/account-cleanup', () => ({ sweepOrphanFolders: mockSweep }));

const PROCESS_EVENTS = ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'];
let onListen, logger, registry, emailWorker, claimWorker, receipts, listenersBefore, originalResume, prune, migrate;

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
  // Watched from before index.js loads, for the order of the boot steps.
  migrate = jest.spyOn(require('./db/migrate'), 'run');
  prune   = jest.spyOn(require('./utils/audit-log'), 'pruneOldEvents');

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
  mockRetention.start = jest.fn();
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

const startWarning = () => logger.warn.mock.calls.find(([msg]) => msg === 'Daily retention start failed');
const fatalLogged  = () => logger.error.mock.calls.some(([msg]) => /^FATAL/.test(msg));

test('as it loads, it prunes the old events and sweeps the folders once, after the migrations', () => {
  expect(prune).toHaveBeenCalledTimes(1);
  expect(mockSweep).toHaveBeenCalledTimes(1);
  expect(mockSweep).toHaveBeenCalledWith();
  const order = fn => fn.mock.invocationCallOrder[0];
  expect(order(prune)).toBeGreaterThan(order(migrate));
  expect(order(mockSweep)).toBeGreaterThan(order(prune));
});

// First of the listen tests, while the module has never loaded: jest caches a
// mock module only once its factory has returned.
test('a retention module that is missing costs a warning, not the boot', async () => {
  mockLoadError = Object.assign(new Error("Cannot find module './jobs/account-retention'"), { code: 'MODULE_NOT_FOUND' });
  try {
    expect(() => onListen()).not.toThrow();
    await flush();
    expect(startWarning()[1]).toEqual({ error: expect.stringMatching(/^Cannot find module '\.\/jobs\/account-retention'/) });
    expect(fatalLogged()).toBe(false);
    expect(registry.resumeWatchers).toHaveBeenCalledTimes(1);
    expect(mockGeoip.start).toHaveBeenCalled();
  } finally { mockLoadError = null; }
});

test('the listen callback starts the daily run once, after the boot recoveries, and before them the sweep had run', async () => {
  onListen();
  await flush();
  expect(mockRetention.start).toHaveBeenCalledTimes(1);
  const order = fn => fn.mock.invocationCallOrder[0];
  for (const before of [emailWorker.recoverPendingJobs, claimWorker.recoverPendingJobs, receipts.resumeUnreadReceipts, registry.resumeWatchers]) {
    expect(order(mockRetention.start)).toBeGreaterThan(order(before));
    expect(order(before)).toBeGreaterThan(order(mockSweep));
  }
  expect(startWarning()).toBeUndefined();
  // The listen callback does not sweep again: boot did, and the job does daily.
  expect(mockSweep).toHaveBeenCalledTimes(1);
});

test('a start() that throws only warns', async () => {
  mockRetention.start = jest.fn(() => { throw new Error('no timers left'); });
  expect(() => onListen()).not.toThrow();
  await flush();
  expect(mockRetention.start).toHaveBeenCalledTimes(1);
  expect(startWarning()[1]).toEqual({ error: 'no timers left' });
  expect(fatalLogged()).toBe(false);
});
