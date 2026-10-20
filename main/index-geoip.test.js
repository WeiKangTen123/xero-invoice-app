// The IP-location refresh (jobs/geoip-refresh.js) is started by index.js once
// the server is listening, after the boot jobs, and nothing about it can stop
// the boot. Loaded as index-status-sync.test.js loads it: app.listen hands
// back its callback instead of listening, the recoveries are spied on, and
// the timers are fake and never fire. The admin account page it serves
// locations to is mounted too.
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
jest.mock('./jobs/xero-keepalive', () => mockKeepalive);
jest.mock('./jobs/xero-status-sync', () => mockStatusSync);
jest.mock('./jobs/xero-change-detector', () => mockDetector);
let mockLoadError = null;
const mockGeoipJob = { start: jest.fn() };
jest.mock('./jobs/geoip-refresh', () => {
  if (mockLoadError) throw mockLoadError;
  return mockGeoipJob;
});

const request = require('supertest');

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
  registry.resumeWatchers = jest.fn(async () => 0);
  mockKeepalive.start  = jest.fn();
  mockStatusSync.start = jest.fn();
  mockDetector.start   = jest.fn();
  mockGeoipJob.start   = jest.fn();
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

const geoWarning  = () => logger.warn.mock.calls.find(([msg]) => msg === 'IP location refresh start failed');
const fatalLogged = () => logger.error.mock.calls.some(([msg]) => /^FATAL/.test(msg));

// First, while the module has never loaded: jest caches a mock module only
// once its factory has returned.
test('a refresh module that is missing costs a warning, not the boot', async () => {
  mockLoadError = Object.assign(new Error("Cannot find module './jobs/geoip-refresh'"), { code: 'MODULE_NOT_FOUND' });
  try {
    expect(() => onListen()).not.toThrow();
    await flush();
    expect(geoWarning()[1]).toEqual({ error: expect.stringMatching(/^Cannot find module '\.\/jobs\/geoip-refresh'/) });
    expect(fatalLogged()).toBe(false);
    expect(registry.resumeWatchers).toHaveBeenCalledTimes(1);
    expect(mockDetector.start).toHaveBeenCalledTimes(1);
  } finally { mockLoadError = null; }
});

test('the listen callback starts it once, after the boot jobs and the Xero jobs', async () => {
  onListen();
  await flush();
  expect(mockGeoipJob.start).toHaveBeenCalledTimes(1);
  const order = fn => fn.mock.invocationCallOrder[0];
  for (const before of [emailWorker.recoverPendingJobs, claimWorker.recoverPendingJobs, receipts.resumeUnreadReceipts,
    registry.resumeWatchers, mockKeepalive.start, mockStatusSync.start, mockDetector.start]) {
    expect(order(mockGeoipJob.start)).toBeGreaterThan(order(before));
  }
  expect(geoWarning()).toBeUndefined();
});

test('a start() that throws only warns', async () => {
  mockGeoipJob.start = jest.fn(() => { throw new Error('no data folder'); });
  expect(() => onListen()).not.toThrow();
  await flush();
  expect(mockGeoipJob.start).toHaveBeenCalledTimes(1);
  expect(geoWarning()[1]).toEqual({ error: 'no data folder' });
  expect(fatalLogged()).toBe(false);
});

test('the real job does nothing under the test suite, wherever it is started from', () => {
  expect(jest.requireActual('./jobs/geoip-refresh').start()).toBe(false);
});

test('the account page is mounted under /api/admin, for admins only', async () => {
  await request(app).get('/api/admin/users/someone/detail').expect(401);
});
