// The one place a Xero API client is made: the SDK for a real token, the
// demo facade for a demo account's, and nothing else in main/ constructs the
// SDK itself. Both edges are replaced — the SDK class, and the demo folder,
// which is built apart from this and stubbed to its contract here.
const fs   = require('fs');
const path = require('path');

const mockFacade    = { kind: 'facade' };
const mockDemoApiFor = jest.fn(() => mockFacade);
jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => ({ kind: 'sdk' })) }));
jest.mock('./demo/api', () => {
  const PREFIX = 'demo:';
  return {
    DEMO_TENANT: { tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' },
    DEMO_TOKEN_PREFIX: PREFIX,
    isDemoToken: t => typeof t === 'string' && t.startsWith(PREFIX),
    userIdFromDemoToken: t => (typeof t === 'string' && t.startsWith(PREFIX) ? t.slice(PREFIX.length) : null),
    demoApiFor: mockDemoApiFor,
  };
});

describe('xero/api-client', () => {
  let apiFor, isDemoToken, AccountingApi;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    ({ apiFor, isDemoToken } = require('./api-client'));
    ({ AccountingApi } = require('xero-node'));
  });

  test('a real token gets the SDK client with the token on it', () => {
    const api = apiFor('access-tok');
    expect(api).toEqual({ kind: 'sdk', accessToken: 'access-tok' });
    expect(AccountingApi).toHaveBeenCalledTimes(1);
    expect(mockDemoApiFor).not.toHaveBeenCalled();
  });

  test("a demo account's token gets the demo facade for that account, and the SDK is never built", () => {
    const api = apiFor('demo:user-42');
    expect(api).toBe(mockFacade);
    expect(mockDemoApiFor).toHaveBeenCalledWith('user-42');
    expect(AccountingApi).not.toHaveBeenCalled();
  });

  test('every call makes a fresh client: two users never share one', () => {
    expect(apiFor('a')).not.toBe(apiFor('b'));
    expect(AccountingApi).toHaveBeenCalledTimes(2);
  });

  test('isDemoToken is the demo folder\'s rule', () => {
    expect(isDemoToken('demo:u1')).toBe(true);
    expect(isDemoToken('access-tok')).toBe(false);
    expect(isDemoToken(undefined)).toBe(false);
  });

  // The report modules reach the client through report-fetch._apiFor; it
  // must be this one, so a demo account's reports come from the facade.
  test('report-fetch._apiFor is apiFor', () => {
    expect(require('./report-fetch')._apiFor).toBe(apiFor);
  });
});

// A module that built its own AccountingApi would send a demo account's
// 'demo:<userId>' token to Xero as a bearer token. Scanned from the source,
// the way the ui tests in main/scripts do, so a new call site cannot slip in.
describe('no other module constructs the SDK', () => {
  const ROOT = path.join(__dirname, '..');

  function jsFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'data') jsFiles(p, out); }
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(p);
    }
    return out;
  }

  test('`new AccountingApi(` appears in api-client.js and nowhere else under main/', () => {
    const hits = jsFiles(ROOT)
      .filter(f => /\bnew AccountingApi\s*\(/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(ROOT, f).split(path.sep).join('/'));
    expect(hits).toEqual(['xero/api-client.js']);
  });

  test('the former call sites go through api-client', () => {
    for (const rel of ['xero/report-fetch.js', 'xero/invoices.js', 'xero/contacts.js', 'xero/change-detector.js', 'xero/status-sync.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/require\('\.\/api-client'\)/);
      expect(src).not.toMatch(/require\('xero-node'\)/);
    }
  });
});
