const http    = require('http');
const request = require('supertest');

// index.js is the server itself: it listens, starts the idle sweeper and runs
// boot recovery as it loads. The sweeper is stubbed, and app.listen is made a
// no-op so recovery never runs on its own; requests go to a server this file
// opens. Xero submission is stubbed so the boot retry can be watched.
jest.mock('./email/idle-sweeper', () => ({ start: jest.fn() }));
jest.mock('./utils/invoice-handler', () => ({
  createHandler:       jest.fn(() => ({})),
  submitInvoiceToXero: jest.fn(async () => {}),
}));

const PROCESS_EVENTS = ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'];
let app, server, logger, users, settings, invoiceStore, handler, listenersBefore;

beforeAll(() => {
  // Nothing here may reach Slack, whatever main/.env holds: dotenv leaves a
  // variable that is already set alone.
  process.env.SLACK_WEBHOOK_URL = '';
  listenersBefore = Object.fromEntries(PROCESS_EVENTS.map(e => [e, process.listeners(e)]));
  jest.spyOn(require('express').application, 'listen').mockReturnValue({ close: cb => cb && cb() });
  jest.spyOn(console, 'log').mockImplementation(() => {});

  app          = require('./index');
  logger       = require('./utils/logger');
  users        = require('./utils/users');
  settings     = require('./utils/settings-store');
  invoiceStore = require('./utils/invoice-store');
  handler      = require('./utils/invoice-handler');
  server       = http.createServer(app).listen(0);
});

afterAll(() => {
  // index.js's crash and signal handlers must not outlive this file.
  for (const e of PROCESS_EVENTS) {
    for (const l of process.listeners(e)) if (!listenersBefore[e].includes(l)) process.removeListener(e, l);
  }
  jest.restoreAllMocks();
  return new Promise(resolve => server.close(resolve));
});

describe('index — error handler', () => {
  afterEach(() => {
    for (const level of ['error', 'warn', 'info', 'debug']) logger[level].mockRestore?.();
  });
  const watchLog = () => ['error', 'warn', 'info', 'debug'].map(level => jest.spyOn(logger, level));

  test('a malformed JSON body is a 400, and nothing of the body reaches the log', async () => {
    const body = '{"email":"someone@test.com","password": hunter2-secret}';
    // The risk being closed: the parse error's own message quotes the body.
    expect(() => JSON.parse(body)).toThrow(/hunter2/);

    const spies = watchLog();
    const res = await request(server).post('/api/auth/login').set('Content-Type', 'application/json').send(body).expect(400);
    expect(res.body).toEqual({ error: 'Malformed request body' });

    const logged = JSON.stringify(spies.flatMap(s => s.mock.calls));
    expect(logged).toMatch(/Malformed request body/);
    expect(logged).not.toMatch(/hunter2|someone@test\.com|is not valid JSON|Unexpected token/);
  });

  test('any other error is still a 500 with nothing of it shown to the client', async () => {
    watchLog();
    const res = await request(server).post('/api/auth/login')
      .set('Content-Type', 'application/json; charset=latin1').send('{"email":"a@test.com"}').expect(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

test('the API names itself Financial Automation', async () => {
  const res = await request(server).get('/').expect(200);
  expect(res.body.app).toBe('Financial Automation API');
});

// Invoices left pending by a restart are resubmitted to Xero at boot. That
// must not post anything for a disabled account.
describe('index — boot retry of stuck Xero submissions', () => {
  let n = 0;
  async function accountWithStuckInvoices(count = 1) {
    const u = await users.createUser(`boot${Date.now()}-${n++}@test.com`, 'password123', 'user');
    settings.forUser(u.id).set({ autoProcess: true });
    for (let i = 0; i < count; i++) {
      invoiceStore.forUser(u.id).add({ id: `stuck-${u.id}-${i}`, status: 'pending', vendorName: 'A', invoiceNumber: `${i}`, invoiceDate: '2026-09-01', totalAmount: 5, processedAt: new Date().toISOString() });
    }
    return u;
  }
  const submittedFor = () => handler.submitInvoiceToXero.mock.calls.map(([userId]) => userId);

  beforeEach(() => {
    handler.submitInvoiceToXero.mockReset();
    handler.submitInvoiceToXero.mockResolvedValue(undefined);
    // One run per test sees every account made so far, so each test starts
    // from accounts with nothing left to retry.
    for (const u of users.getAllUsers()) users.setDisabled(u.id, true);
  });

  test('skips a disabled account and retries an enabled one', async () => {
    const on  = await accountWithStuckInvoices();
    const off = await accountWithStuckInvoices();
    users.setDisabled(off.id, true);
    await app.retryStuckSubmissions({ gapMs: 0 });
    expect(submittedFor()).toEqual([on.id]);
  });

  test('a disable that lands part-way through stops the rest of that account', async () => {
    const u = await accountWithStuckInvoices(3);
    handler.submitInvoiceToXero.mockImplementation(async userId => { users.setDisabled(userId, true); });
    await app.retryStuckSubmissions({ gapMs: 0 });
    expect(submittedFor()).toEqual([u.id]);
  });
});
