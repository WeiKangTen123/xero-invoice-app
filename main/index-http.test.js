const http    = require('http');
const request = require('supertest');

// How index.js reads request bodies and writes its access log. The server is
// loaded as index.test.js loads it: the idle sweeper and Xero submission are
// stubbed, app.listen is a no-op so no boot recovery runs, and requests go to
// a server this file opens.
jest.mock('./email/idle-sweeper', () => ({ start: jest.fn() }));
jest.mock('./utils/invoice-handler', () => ({
  createHandler:       jest.fn(() => ({})),
  submitInvoiceToXero: jest.fn(async () => {}),
}));

const PROCESS_EVENTS = ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'];
let app, server, logger, users, listenersBefore, token;

const KB = 1024, MB = 1024 * 1024;
// A JSON body of about `bytes`, carried in a field no route reads.
const bodyOf = (bytes, fields = {}) => JSON.stringify({ ...fields, pad: 'x'.repeat(bytes) });
const post = (url, body) => request(server).post(url).set('Content-Type', 'application/json').send(body);
const signedIn = req => req.set('Authorization', `Bearer ${token}`);
// morgan writes its line when the response finishes; let that happen.
const settle = () => new Promise(resolve => setImmediate(resolve));

beforeAll(async () => {
  process.env.SLACK_WEBHOOK_URL = '';
  listenersBefore = Object.fromEntries(PROCESS_EVENTS.map(e => [e, process.listeners(e)]));
  jest.spyOn(require('express').application, 'listen').mockReturnValue({ close: cb => cb && cb() });
  jest.spyOn(console, 'log').mockImplementation(() => {});

  app    = require('./index');
  logger = require('./utils/logger');
  users  = require('./utils/users');
  server = http.createServer(app).listen(0);

  const user = await users.createUser(`http${Date.now()}@test.com`, 'password123', 'user');
  token = require('jsonwebtoken').sign({ id: user.id, email: user.email, role: user.role }, require('./middleware/auth-middleware').jwtSecret());
});

afterAll(() => {
  for (const e of PROCESS_EVENTS) {
    for (const l of process.listeners(e)) if (!listenersBefore[e].includes(l)) process.removeListener(e, l);
  }
  jest.restoreAllMocks();
  return new Promise(resolve => server.close(resolve));
});

// Every body used to be parsed up to 10MB before any route or auth ran, so
// anyone could have the server hold and parse 10MB per request at sign-in.
describe('request body limits', () => {
  test('sign-in refuses a 200kb body with a 413 that names the 100KB limit', async () => {
    const res = await post('/api/auth/login', bodyOf(200 * KB, { email: 'a@test.com', password: 'x' })).expect(413);
    expect(res.body).toEqual({ error: 'That is too large to send; the limit is 100KB.' });
  });

  test('an ordinary sign-in body still parses', async () => {
    // Wrong password, but read: a 401 from the route, not a 413 from the parser.
    const res = await post('/api/auth/login', JSON.stringify({ email: 'nobody@test.com', password: 'wrong-password' }));
    expect(res.status).not.toBe(413);
    expect(res.status).toBeLessThan(500);
  });

  test('a signed-in route that takes no upload is held to 100kb too', async () => {
    await signedIn(post('/api/setup', bodyOf(200 * KB))).expect(413);
    // The pairing route sits beside the upload route but is not one.
    await signedIn(post('/api/receipts/pair', bodyOf(200 * KB))).expect(413);
  });

  // Each answer below is the route's own, so the 5MB body reached it parsed.
  test('the receipt upload accepts a 5MB body', async () => {
    const res = await signedIn(post('/api/receipts', bodyOf(5 * MB, { mime: 'text/plain', data: 'aGVsbG8=' }))).expect(400);
    expect(res.body.error).toMatch(/^Unsupported file type \(text\/plain\)/);
  });

  test('every other base64 upload route accepts a 5MB body too', async () => {
    const phone = await post('/api/receipts/capture/not-a-live-token', bodyOf(5 * MB, { mime: 'image/jpeg' })).expect(401);
    expect(phone.body.error).toMatch(/link has expired/);

    const claims = await signedIn(post('/api/claims/import', bodyOf(5 * MB, { archives: [] }))).expect(400);
    expect(claims.body.error).toBe('Attach at least a claim archive or a claim form');

    const bill = await signedIn(post('/api/invoices', bodyOf(5 * MB, { name: 'bill.pdf', data: '' }))).expect(400);
    expect(bill.body.error).toMatch(/^bill\.pdf came through empty/);

    const imp = await signedIn(post('/api/invoices/import', bodyOf(5 * MB, { pdfs: 'not a list' }))).expect(400);
    expect(imp.body.error).toBe('Attachments must be lists');
  });

  test('an upload route still stops at 10MB', async () => {
    const res = await signedIn(post('/api/receipts', bodyOf(11 * MB, { mime: 'image/jpeg' }))).expect(413);
    expect(res.body).toEqual({ error: 'That is too large to send; the limit is 10MB.' });
  });

  test('the chat, which resends the conversation each turn, takes more than 100kb', async () => {
    const history = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'y'.repeat(2 * KB) }));
    // No message: the route's own 400, after the body was read.
    const res = await signedIn(post('/api/chat', JSON.stringify({ history }))).expect(400);
    expect(res.body).toEqual({ error: 'Message is required' });
  });
});

describe('access log', () => {
  let info;
  beforeEach(() => { info = jest.spyOn(logger, 'info'); });
  afterEach(() => info.mockRestore());
  const accessLines = () => info.mock.calls.map(c => c[0]).filter(m => typeof m === 'string' && /HTTP\/1\.1" \d{3}/.test(m));

  test('the status poll and the health check are not logged when they succeed', async () => {
    await signedIn(request(server).get('/api/process/status')).expect(200);
    await signedIn(request(server).get('/api/claims/active')).expect(200);
    await request(server).get('/dashboard/health').expect(200);
    await settle();
    expect(accessLines()).toEqual([]);
  });

  test('a poll that fails is still logged', async () => {
    await request(server).get('/api/process/status').expect(401);
    await settle();
    expect(accessLines()).toEqual([expect.stringContaining('"GET /api/process/status HTTP/1.1" 401')]);
  });

  test('an ordinary request is logged in the combined format', async () => {
    await signedIn(request(server).get('/api/auth/me')).expect(200);
    await settle();
    expect(accessLines()).toEqual([expect.stringMatching(/^\S+ - - \[[^\]]+\] "GET \/api\/auth\/me HTTP\/1\.1" 200 \d+ "-" "[^"]*"$/)]);
  });

  test('pairing tokens in the path, and token, code and state in the query, are logged redacted', async () => {
    const secret = 'S3CRET-pairing-token-abcdef';
    await request(server).get(`/api/receipts/capture/${secret}/status`).expect(401);
    await request(server).get(`/api/receipts/capture/${secret}`).expect(401);
    await post(`/api/receipts/capture/${secret}`, JSON.stringify({ mime: 'image/jpeg' })).expect(401);
    await signedIn(request(server).get(`/api/receipts/pair/${secret}`)).expect(404);
    await request(server).get(`/api/invoices/inv-1/pdf?token=${secret}`).expect(401);
    await request(server).get(`/api/receipts/rcpt-1/image?w=76&token=${secret}`).expect(401);
    await request(server).get(`/api/xero/oauth/callback?code=${secret}&state=${secret}x`).expect(302);
    await request(server).get('/api/auth/status').set('Referer', `https://example.test/capture/${secret}?token=${secret}`).expect(200);
    await settle();

    const lines = accessLines();
    expect(lines).toHaveLength(8);
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringContaining('"GET /api/receipts/capture/[redacted]/status HTTP/1.1" 401'),
      expect.stringContaining('"GET /api/receipts/capture/[redacted] HTTP/1.1" 401'),
      expect.stringContaining('"POST /api/receipts/capture/[redacted] HTTP/1.1" 401'),
      expect.stringContaining('"GET /api/receipts/pair/[redacted] HTTP/1.1" 404'),
      expect.stringContaining('"GET /api/invoices/inv-1/pdf?token=[redacted] HTTP/1.1" 401'),
      expect.stringContaining('"GET /api/receipts/rcpt-1/image?w=76&token=[redacted] HTTP/1.1" 401'),
      expect.stringContaining('"GET /api/xero/oauth/callback?code=[redacted]&state=[redacted] HTTP/1.1" 302'),
      expect.stringContaining('"https://example.test/capture/[redacted]?token=[redacted]"'),
    ]));
  });

  test("a phone's rejected upload is logged without its token by the error handler", async () => {
    const warn = jest.spyOn(logger, 'warn');
    try {
      const secret = 'S3CRET-upload-token-123456';
      await post(`/api/receipts/capture/${secret}`, bodyOf(11 * MB)).expect(413);
      await settle();
      expect(warn).toHaveBeenCalledWith('Request rejected', expect.objectContaining({ status: 413, path: '/api/receipts/capture/[redacted]' }));
      expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain(secret);
    } finally { warn.mockRestore(); }
  });
});

// Read from the app loaded in beforeAll: a require() here would run at
// collection time, before app.listen is stubbed, and really listen on PORT.
describe('redactUrl', () => {
  const redactUrl = url => app.redactUrl(url);

  test.each([
    ['/capture/abc123', '/capture/[redacted]'],
    ['/capture/abc123?x=1', '/capture/[redacted]?x=1'],
    ['/api/receipts/capture/abc123/status', '/api/receipts/capture/[redacted]/status'],
    ['/api/receipts/pair/abc123', '/api/receipts/pair/[redacted]'],
    ['/api/xero-reports/budget/export?token=eyJ.a.b', '/api/xero-reports/budget/export?token=[redacted]'],
    ['/setup?xero_oauth=pending&code=c0de&state=st4te', '/setup?xero_oauth=pending&code=[redacted]&state=[redacted]'],
    ['/x?TOKEN=abc#frag', '/x?TOKEN=[redacted]#frag'],
  ])('%s is logged as %s', (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  test('a URL with nothing secret in it is left alone', () => {
    for (const url of ['/api/receipts/pair', '/api/invoices?status=posted', '/api/receipts/r-1/token', '/dashboard', '/api/process/status']) {
      expect(redactUrl(url)).toBe(url);
    }
    expect(redactUrl(undefined)).toBeUndefined();
  });
});

describe('quietRequest', () => {
  const q = (url, { method = 'GET', status = 200 } = {}) => app.quietRequest({ method, originalUrl: url }, { statusCode: status });

  test('fingerprinted assets and static files are quiet when served', () => {
    expect(q('/assets/index-KN4F6LXm.js')).toBe(true);
    expect(q('/assets/index-Bb7pA037.css')).toBe(true);
    expect(q('/vite.svg')).toBe(true);
    expect(q('/favicon.ico', { method: 'HEAD' })).toBe(true);
  });

  test('a missing asset, the page itself, an API call and a write are logged', () => {
    expect(q('/assets/index-gone.js', { status: 404 })).toBe(false);
    expect(q('/')).toBe(false);
    expect(q('/capture/abc')).toBe(false);
    expect(q('/api/receipts/r-1/image.png')).toBe(false);
    expect(q('/api/process/status', { method: 'POST' })).toBe(false);
    expect(q('/dashboard/health', { status: 503 })).toBe(false);
  });
});
