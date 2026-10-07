const fs   = require('fs');
const path = require('path');
const jwt  = require('jsonwebtoken');

// The browser's half of 24-hour sliding sessions: ui/src/api/client.js stores
// the fresh token the server hands back in X-Session-Token. There is no React
// test setup in this project (see invoice-tabs.test.js), but client.js imports
// nothing and touches only fetch, localStorage, window and atob, so it is run
// here whole, with those four handed in, and request() is exercised for real.
const ROOT   = path.join(__dirname, '../..');
const CLIENT = path.join(ROOT, 'ui/src/api/client.js');

function loadClient({ fetch, store = new Map(), pathname = '/invoices' }) {
  const src = fs.readFileSync(CLIENT, 'utf8');
  if (/^import /m.test(src)) throw new Error('client.js now imports something; this harness runs it standalone');
  const localStorage = {
    getItem:    k => (store.has(k) ? store.get(k) : null),
    setItem:    (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const window = { location: { pathname, search: '', hash: '', href: pathname } };
  const body = `${src.replace(/^export /gm, '')}\nreturn { api, tokenClaims, newerSessionToken, SESSION_TOKEN_HEADER };`;
  const client = new Function('fetch', 'localStorage', 'window', 'atob', body)(fetch, localStorage, window, atob);
  return { ...client, store, window };
}

const nowSec = () => Math.floor(Date.now() / 1000);
// Real tokens, signed with a throwaway secret: the client never verifies.
const token = (id, exp, extra = {}) => jwt.sign({ id, email: `${id}@test.com`, role: 'user', exp, ...extra }, 'ui-test');
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

describe('newerSessionToken: which token to keep', () => {
  const { newerSessionToken } = loadClient({ fetch: async () => reply(200, {}) });
  const soon = token('u1', nowSec() + 1000), later = token('u1', nowSec() + 2000);

  test('the one that runs out last, whichever order they arrive in', () => {
    expect(newerSessionToken(soon, later)).toBe(later);
    expect(newerSessionToken(later, soon)).toBe(later);
  });

  test('the stored one on a tie, so nothing is rewritten for nothing', () => {
    const twin = token('u1', nowSec() + 1000, { renewed: true });
    expect(newerSessionToken(soon, twin)).toBe(soon);
  });

  test('nothing, when nothing is stored: signed out while the request was out', () => {
    expect(newerSessionToken(null, later)).toBeNull();
  });

  test("the stored one when the renewal is another account's: signed in as someone else meanwhile", () => {
    const someoneElse = token('u2', nowSec() + 10);
    expect(newerSessionToken(someoneElse, later)).toBe(someoneElse);
  });

  test('the stored one when either cannot be read', () => {
    expect(newerSessionToken(soon, 'garbage')).toBe(soon);
    expect(newerSessionToken('garbage', later)).toBe('garbage');
    expect(newerSessionToken(soon, null)).toBe(soon);
  });

  test('tokenClaims reads base64url payloads, unpadded, as JWTs carry them', () => {
    // An id chosen so the payload's base64 needs the url-safe characters.
    const t = token('??>>~~', 1234567890);
    expect(t.split('.')[1]).toMatch(/[-_]/);
    expect(loadClient({ fetch: async () => reply(200, {}) }).tokenClaims(t)).toMatchObject({ id: '??>>~~', exp: 1234567890 });
  });
});

describe('request() stores a renewed token', () => {
  test('the header name is the one the server sends', () => {
    const { SESSION_TOKEN_HEADER } = loadClient({ fetch: async () => reply(200, {}) });
    expect(SESSION_TOKEN_HEADER).toBe(require('../middleware/auth-middleware').SESSION_TOKEN_HEADER);
  });

  test('from a successful response, in place of the older one', async () => {
    const old = token('u1', nowSec() + 1000), fresh = token('u1', nowSec() + 5000);
    const sent = [];
    const c = loadClient({ fetch: async (url, opts) => { sent.push(opts.headers.Authorization); return reply(200, { ok: 1 }, { 'X-Session-Token': fresh }); } });
    c.store.set('token', old);
    expect(await c.api.get('/auth/me')).toEqual({ ok: 1 });
    expect(c.store.get('token')).toBe(fresh);
    await c.api.get('/auth/me');
    expect(sent).toEqual([`Bearer ${old}`, `Bearer ${fresh}`]);
  });

  test('two renewals in flight together end with the newer stored, whichever lands last', async () => {
    const old = token('u1', nowSec() + 100);
    const a = token('u1', nowSec() + 5000), b = token('u1', nowSec() + 5001);
    const pending = [];
    const c = loadClient({ fetch: () => new Promise(resolve => pending.push(resolve)) });
    c.store.set('token', old);
    const first = c.api.get('/one'), second = c.api.get('/two');
    await new Promise(r => setImmediate(r));
    pending[1](reply(200, {}, { 'X-Session-Token': b }));   // the newer lands first...
    await second;
    pending[0](reply(200, {}, { 'X-Session-Token': a }));   // ...and the older after it
    await first;
    expect(c.store.get('token')).toBe(b);
  });

  test('not after signing out while the request was out', async () => {
    let resolve;
    const c = loadClient({ fetch: () => new Promise(r => { resolve = r; }) });
    c.store.set('token', token('u1', nowSec() + 100));
    const inFlight = c.api.get('/auth/me');
    await new Promise(r => setImmediate(r));
    c.store.delete('token');
    resolve(reply(200, {}, { 'X-Session-Token': token('u1', nowSec() + 5000) }));
    await inFlight;
    expect(c.store.has('token')).toBe(false);
  });

  test('not from a response that failed, and a 401 still ends the session as before', async () => {
    const old = token('u1', nowSec() + 100);
    const c = loadClient({ fetch: async () => reply(500, { error: 'boom' }, { 'X-Session-Token': token('u1', nowSec() + 5000) }) });
    c.store.set('token', old);
    await expect(c.api.get('/x')).rejects.toMatchObject({ status: 500 });
    expect(c.store.get('token')).toBe(old);

    const d = loadClient({ fetch: async () => reply(401, { error: 'Your session ended after 24 hours away. Sign in again.' }) });
    d.store.set('token', old);
    await expect(d.api.get('/x')).rejects.toThrow('Your session ended after 24 hours away. Sign in again.');
    expect(d.store.has('token')).toBe(false);
    expect(d.window.location.href).toBe('/login?next=%2Finvoices');
  });

  test('a 401 for a token replaced by a renewal meanwhile retries with the new one, as before', async () => {
    const old = token('u1', nowSec() + 100), fresh = token('u1', nowSec() + 5000);
    const sent = [];
    let c;
    c = loadClient({ fetch: async (url, opts) => {
      sent.push(opts.headers.Authorization);
      if (sent.length === 1) { c.store.set('token', fresh); return reply(401, { error: 'You have been signed out. Sign in again.' }); }
      return reply(200, { ok: 1 });
    } });
    c.store.set('token', old);
    expect(await c.api.get('/x')).toEqual({ ok: 1 });
    expect(sent).toEqual([`Bearer ${old}`, `Bearer ${fresh}`]);
    expect(c.store.get('token')).toBe(fresh);
  });
});

// Same origin today, so nothing is needed for the browser to read the header.
// If the API is ever served cross-origin, fetch hides every response header not
// listed in Access-Control-Expose-Headers, renewals silently stop reaching the
// client, and everyone is signed out a day after signing in.
test('if the server ever turns on CORS, it exposes X-Session-Token', () => {
  const index = fs.readFileSync(path.join(ROOT, 'main/index.js'), 'utf8');
  if (/require\(['"]cors['"]\)|Access-Control-Allow-Origin/i.test(index)) {
    expect(index).toMatch(/X-Session-Token/i);
  }
});
