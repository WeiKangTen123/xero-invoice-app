// A dropped connection during any Xero call used to crash the server: the
// SDK's ApiError read error.response.status on an error that has no response,
// so the SDK's own catch block threw, the awaited promise never settled, and
// the throw reached index.js as an unhandled rejection — which exits.
//
// These make REAL xero-node calls, but only ever to a local server on
// 127.0.0.1 that drops, refuses, ignores or answers the request. Nothing here
// reaches Xero.
const http  = require('http');
const net   = require('net');
const path  = require('path');
const axios = require('axios');
const { spawnSync } = require('child_process');

const { xeroErrMsg, withRetry, _parseXeroErr } = require('./xero-utils');
const guard = require('./sdk-guard');
const apiErrorModule = require('xero-node/dist/model/ApiError');
const { AccountingApi } = require('xero-node');

const TOKEN = 'test-bearer-token-do-not-leak';

// A server whose open sockets can be torn down at the end, so a test that
// leaves a request hanging does not keep the process alive.
function startServer(onConnection) {
  return new Promise(resolve => {
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      onConnection(socket);
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}

function apiAt(port) {
  const api = new AccountingApi();
  api.basePath = `http://127.0.0.1:${port}`;
  api.accessToken = TOKEN;
  return api;
}

// Settles the race so a promise that never settles is a test failure, not a
// test that hangs until jest gives up.
const PENDING = Symbol('pending');
function settleWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(value => ({ value }), error => ({ error })),
    new Promise(r => { timer = setTimeout(() => r(PENDING), ms); }),
  ]).finally(() => clearTimeout(timer));
}

afterEach(() => { guard.settings.timeoutMs = guard.TIMEOUT_MS; });

// ── The crash itself, in a real process ─────────────────────────────────────
//
// Jest installs its own unhandled-rejection handler, so a listener added
// inside a test never hears one (jest fails the running test instead, which
// the in-process tests further down rely on). To see the crash the way
// production does, the call runs in a child node process with the handler
// index.js has: any unhandled rejection ends the process.
const XERO_UTILS = path.join(__dirname, 'xero-utils.js');
const XERO_NODE  = require.resolve('xero-node');
const CHILD = `
  process.on('unhandledRejection', err => {
    console.log(JSON.stringify({ unhandled: String((err && err.message) || err) }));
    process.exit(3);
  });
  const guarded = process.env.WITH_GUARD === '1';
  const utils = guarded ? require(${JSON.stringify(XERO_UTILS)}) : null;
  const { AccountingApi } = require(${JSON.stringify(XERO_NODE)});
  // Accepts the connection and drops it: the ECONNRESET of a network blip.
  const server = require('net').createServer(socket => socket.destroy());
  server.listen(0, '127.0.0.1', async () => {
    const api = new AccountingApi();
    api.basePath = 'http://127.0.0.1:' + server.address().port;
    api.accessToken = 'token';
    setTimeout(() => { console.log(JSON.stringify({ pending: true })); process.exit(4); }, 3000).unref();
    try {
      await api.getOrganisations('tenant');
      console.log(JSON.stringify({ resolved: true }));
    } catch (err) {
      console.log(JSON.stringify({ rejected: true, message: guarded ? utils.xeroErrMsg(err) : null }));
    }
    process.exit(0);
  });
`;

function runChild(withGuard) {
  const res = spawnSync(process.execPath, ['-e', CHILD], {
    env: { ...process.env, NODE_ENV: 'test', WITH_GUARD: withGuard ? '1' : '0' },
    encoding: 'utf8',
    timeout: 15000,
  });
  const lines = String(res.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  return {
    status: res.status,
    stderr: res.stderr,
    result: lines.length ? JSON.parse(lines[lines.length - 1]) : null,
  };
}

describe('xero/sdk-guard — a dropped connection in a real process', () => {
  // Proves the check can see the bug at all: without the guard, the same call
  // is exactly the production crash.
  test('control: without the guard the rejection is unhandled and the process exits', () => {
    const { status, result } = runChild(false);
    expect(status).toBe(3);
    expect(result.unhandled).toMatch(/reading 'status'/);
  });

  test('with the guard the call rejects normally and the process carries on', () => {
    const { status, result, stderr } = runChild(true);
    expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
    expect(result).toEqual({ rejected: true, message: 'Could not reach Xero (ECONNRESET) — check the connection and try again' });
  });
});

// ── What the app receives ───────────────────────────────────────────────────
//
// Jest fails any test during which an unhandled rejection occurs, so each of
// these passing also means the call produced none.
describe('xero/sdk-guard — the SDK on a dropped connection', () => {
  test('the guard is installed by loading xero-utils', () => {
    expect(apiErrorModule.ApiError.Original).toEqual(expect.any(Function));
    expect(apiErrorModule.ApiError).not.toBe(apiErrorModule.ApiError.Original);
  });

  test('a connection reset rejects with a readable error', async () => {
    const server = await startServer(socket => socket.destroy());
    try {
      const outcome = await settleWithin(apiAt(server.port).getOrganisations('tenant'), 5000);
      expect(outcome).not.toBe(PENDING);
      expect(outcome.error).toBeDefined();
      expect(_parseXeroErr(outcome.error)).toMatchObject({ status: 0, code: 'ECONNRESET' });
      expect(xeroErrMsg(outcome.error)).toBe('Could not reach Xero (ECONNRESET) — check the connection and try again');
      expect(String(outcome.error)).not.toContain(TOKEN);
    } finally {
      await server.close();
    }
  });

  test('a closed port rejects with a readable error', async () => {
    const server = await startServer(() => {});
    const { port } = server;
    await server.close();
    const outcome = await settleWithin(apiAt(port).getOrganisations('tenant'), 10000);
    expect(outcome).not.toBe(PENDING);
    expect(_parseXeroErr(outcome.error).code).toBe('ECONNREFUSED');
    expect(xeroErrMsg(outcome.error)).toMatch(/^Could not reach Xero \(ECONNREFUSED\)/);
  });

  test('a server that accepts and never answers is cut off by the timeout', async () => {
    const server = await startServer(() => {}); // holds the socket open, says nothing
    guard.settings.timeoutMs = 300;
    try {
      const started = Date.now();
      const outcome = await settleWithin(apiAt(server.port).getOrganisations('tenant'), 5000);
      const elapsed = Date.now() - started;
      expect(outcome).not.toBe(PENDING);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(3000);
      expect(_parseXeroErr(outcome.error).message).toMatch(/timeout of 300ms exceeded/);
      expect(xeroErrMsg(outcome.error)).toBe('Xero did not respond in time — please try again in a moment');
    } finally {
      await server.close();
    }
  });

  test('withRetry fails a network error once instead of retrying it', async () => {
    const server = await startServer(socket => socket.destroy());
    const api = apiAt(server.port);
    const call = jest.fn(() => api.getOrganisations('tenant'));
    try {
      const outcome = await settleWithin(withRetry(call, 5, 10), 5000);
      expect(outcome).not.toBe(PENDING);
      expect(outcome.error).toBeDefined();
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  // An ordinary HTTP failure must come out exactly as the app already knew it.
  test('an HTTP error from Xero keeps its status and message, minus the bearer token', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Detail: 'Ordering by DueDate is unavailable' }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const outcome = await settleWithin(apiAt(server.address().port).getOrganisations('tenant'), 5000);
      expect(outcome).not.toBe(PENDING);
      expect(_parseXeroErr(outcome.error).status).toBe(400);
      expect(xeroErrMsg(outcome.error)).toBe('Ordering by DueDate is unavailable');
      expect(String(outcome.error)).not.toContain(TOKEN);
      expect(String(outcome.error)).toContain('[redacted]');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  test('the replacement ApiError tolerates errors with no response, no request, or no object at all', () => {
    const { ApiError } = apiErrorModule;
    const dns = { message: 'getaddrinfo ENOTFOUND api.xero.com', code: 'ENOTFOUND' };
    expect(() => new ApiError(dns)).not.toThrow();
    expect(() => new ApiError('a bare string')).not.toThrow();
    expect(() => new ApiError(undefined)).not.toThrow();
    const serialised = JSON.stringify(new ApiError(dns).generateError());
    expect(JSON.parse(serialised)).toMatchObject(dns);
    expect(xeroErrMsg(serialised)).toBe('Could not reach Xero (ENOTFOUND) — check the connection and try again');
  });
});

describe('xero/sdk-guard — the timeout applies to Xero requests only', () => {
  // A stand-in adapter reports the timeout axios would have used, so this
  // checks the interceptor's scoping without opening any connection.
  const timeoutFor = (url, config = {}) => axios({
    url, method: 'get', ...config,
    adapter: async cfg => ({ data: cfg.timeout, status: 200, statusText: 'OK', headers: {}, config: cfg }),
  }).then(res => res.data);

  test('a call to a xero.com host gets the 60-second limit', async () => {
    expect(await timeoutFor('https://api.xero.com/api.xro/2.0/Organisation')).toBe(60_000);
    expect(await timeoutFor('https://identity.xero.com/connect/token')).toBe(60_000);
  });

  test('a call carrying the SDK\'s user-agent gets it wherever it points', async () => {
    expect(await timeoutFor('http://127.0.0.1:1/x', { headers: { 'user-agent': 'xero-node-7.0.0' } })).toBe(60_000);
  });

  test('a Xero call that already sets its own timeout keeps it', async () => {
    expect(await timeoutFor('https://identity.xero.com/connect/token', { timeout: 10_000 })).toBe(10_000);
  });

  test('other hosts sharing this axios instance are left alone', async () => {
    expect(await timeoutFor('https://generativelanguage.googleapis.com/v1beta/models')).toBe(0);
    expect(await timeoutFor('https://hooks.slack.com/services/x')).toBe(0);
    expect(await timeoutFor('https://notxero.com/api')).toBe(0);
    expect(await timeoutFor('https://generativelanguage.googleapis.com/v1', { timeout: 120_000 })).toBe(120_000);
  });

  test('isXeroRequest matches hosts exactly, not by substring', () => {
    expect(guard.isXeroRequest({ url: 'https://api.xero.com/connections' })).toBe(true);
    expect(guard.isXeroRequest({ url: 'https://xero.com.evil.example/' })).toBe(false);
    expect(guard.isXeroRequest({ url: '/relative/path' })).toBe(false);
    expect(guard.isXeroRequest(undefined)).toBe(false);
  });
});
