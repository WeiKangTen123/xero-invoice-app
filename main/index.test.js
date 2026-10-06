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

  test('a row that stopped being pending while the retry waited is not sent', async () => {
    const u = await accountWithStuckInvoices(2);
    // The first send's gap is when the live pipeline posts the other row.
    let other;
    handler.submitInvoiceToXero.mockImplementationOnce(async (userId, id) => {
      other = id.endsWith('-0') ? `stuck-${userId}-1` : `stuck-${userId}-0`;
      invoiceStore.forUser(userId).update(other, { status: 'posted', xeroInvoiceId: `x-${userId}` });
    });
    await app.retryStuckSubmissions({ gapMs: 0 });
    const sent = handler.submitInvoiceToXero.mock.calls.map(([, id]) => id);
    expect(sent).toHaveLength(1);
    expect(sent).not.toContain(other);
    expect(submittedFor()).toEqual([u.id]);
  });

  // Every deploy is a restart. A send in flight at that moment left its row in
  // 'submitting' for good: the retry re-submitted it, claimForSubmit refused
  // 'submitting', and so did the manual submit. The send may have reached
  // Xero, so a person checks first.
  test("a 'submitting' row becomes review-needed at boot and is not re-sent", async () => {
    const u = await accountWithStuckInvoices(0);
    const store = invoiceStore.forUser(u.id);
    store.add({ id: `mid-${u.id}`, status: 'submitting', vendorName: 'A', invoiceNumber: 'M1', invoiceDate: '2026-09-01', totalAmount: 5, processedAt: new Date().toISOString() });
    store.add({ id: `fix-${u.id}`, status: 'submitting', xeroInvoiceId: `xero-${u.id}`, vendorName: 'A', invoiceNumber: 'M2', invoiceDate: '2026-09-01', totalAmount: 5, processedAt: new Date().toISOString() });

    app.releaseInterruptedSubmissions();
    await app.retryStuckSubmissions({ gapMs: 0 });

    const msg = 'Sending was interrupted by a restart. Check Xero for this document before sending it again.';
    expect(store.getById(`mid-${u.id}`)).toMatchObject({ status: 'review-needed', errorMsg: msg });
    // A correction to a bill already in Xero stays posted.
    expect(store.getById(`fix-${u.id}`)).toMatchObject({ status: 'posted', errorMsg: msg });
    expect(submittedFor()).toEqual([]);
  });

  test('interrupted sends are released for a disabled account too; nothing is sent for it', async () => {
    const u = await accountWithStuckInvoices(1);
    users.setDisabled(u.id, true);
    invoiceStore.forUser(u.id).update(`stuck-${u.id}-0`, { status: 'submitting' });
    app.releaseInterruptedSubmissions();
    await app.retryStuckSubmissions({ gapMs: 0 });
    expect(invoiceStore.forUser(u.id).getById(`stuck-${u.id}-0`).status).toBe('review-needed');
    expect(submittedFor()).toEqual([]);
  });
});
