// The Xero keep-alive is started by index.js once the server is listening,
// after the boot recoveries, and nothing about it can stop the boot. Loaded as
// index-boot.test.js loads it: app.listen hands back its callback instead of
// listening, the recoveries are spied on, and the 3s Xero retry is held by
// fake timers and never fires.
//
// The keep-alive module is replaced here (virtual, so this holds whether or
// not the real file exists yet). Its factory throws while mockLoadError is
// set, the way a missing or broken module throws from require; once it loads,
// jest keeps that one object, and each test sets its start().
jest.mock('./email/idle-sweeper', () => ({ start: jest.fn() }));
jest.mock('./utils/invoice-handler', () => ({
  createHandler:       jest.fn(() => ({})),
  submitInvoiceToXero: jest.fn(async () => {}),
}));
let mockLoadError = null;
const mockKeepalive = { start: jest.fn() };
// Not { virtual: true }: the module exists now, and a virtual mock is keyed by
// the path as written (no extension) while index.js resolves the real file
// (.js). Windows happened to match the two; on Linux CI the real module loaded
// and the mock was never called.
jest.mock('./jobs/xero-keepalive', () => {
  if (mockLoadError) throw mockLoadError;
  return mockKeepalive;
});

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
  mockKeepalive.start = jest.fn();
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

const keepaliveWarning = () => logger.warn.mock.calls.find(([msg]) => msg === 'Xero keep-alive start failed');
const fatalLogged = () => logger.error.mock.calls.some(([msg]) => /^FATAL/.test(msg));

// First, while the module has never loaded: jest caches a mock module only
// once its factory has returned.
test('a keep-alive module that is missing costs a warning, not the boot', async () => {
  mockLoadError = Object.assign(new Error("Cannot find module './jobs/xero-keepalive'"), { code: 'MODULE_NOT_FOUND' });
  try {
    expect(() => onListen()).not.toThrow();
    await flush();
    // Jest adds its own hints to a not-found message; the start of it is ours.
    expect(keepaliveWarning()[1]).toEqual({ error: expect.stringMatching(/^Cannot find module '\.\/jobs\/xero-keepalive'/) });
    expect(fatalLogged()).toBe(false);
    // The recoveries ran regardless.
    expect(registry.resumeWatchers).toHaveBeenCalledTimes(1);
    expect(receipts.resumeUnreadReceipts).toHaveBeenCalledTimes(1);
  } finally { mockLoadError = null; }
});

test('the listen callback starts it once, after the boot recoveries', async () => {
  onListen();
  await flush();
  expect(mockKeepalive.start).toHaveBeenCalledTimes(1);
  const order = fn => fn.mock.invocationCallOrder[0];
  for (const recovery of [emailWorker.recoverPendingJobs, claimWorker.recoverPendingJobs, receipts.resumeUnreadReceipts, registry.resumeWatchers]) {
    expect(order(mockKeepalive.start)).toBeGreaterThan(order(recovery));
  }
  expect(keepaliveWarning()).toBeUndefined();
});

test('a start() that throws only warns', async () => {
  mockKeepalive.start = jest.fn(() => { throw new Error('no Xero tenants table'); });
  expect(() => onListen()).not.toThrow();
  await flush();
  expect(mockKeepalive.start).toHaveBeenCalledTimes(1);
  expect(keepaliveWarning()[1]).toEqual({ error: 'no Xero tenants table' });
  expect(fatalLogged()).toBe(false);
});

test('a start() that rejects only warns, and the helper itself always resolves', async () => {
  mockKeepalive.start = jest.fn(async () => { throw new Error('token refresh failed'); });
  await expect(app.startXeroKeepalive()).resolves.toBeUndefined();
  expect(keepaliveWarning()[1]).toEqual({ error: 'token refresh failed' });
  expect(fatalLogged()).toBe(false);
});
