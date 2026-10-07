// What status-sync.js assumes about the installed xero-node's getInvoices.
//
// status-sync.test.js replaces the SDK, so it proves which argument slots the
// module fills, not what xero-node 20 means by them. getInvoices takes its
// options by position, and an upgrade that moved one would send the IDs as
// invoice numbers, or summaryOnly as something else, with no error at all.
//
// The second half runs the real SDK end to end with axios's adapter replaced
// by a function that records the request and answers it, so nothing leaves
// the process: the IDs must reach Xero as one comma-separated IDs parameter,
// summaryOnly as summaryOnly=true, the last read as an If-Modified-Since
// header, and Xero's answer must come back as status, amounts and a paid-on
// day.
//
// No jest.resetModules here: a reset would hand xero-node a fresh axios
// without the stand-in adapter, and the request would really go out.
const axios = require('axios');
const { AccountingApi } = require('xero-node');

function paramsOf(name) {
  const fn = AccountingApi.prototype[name];
  if (typeof fn !== 'function') throw new Error(`AccountingApi.${name} is gone`);
  const list = /^[^(]*\(([^)]*)\)/.exec(fn.toString());
  return list[1].split(',')
    .map(p => p.trim().replace(/\s*=.*$/, '').replace(/_1$/, ''))
    .filter(p => p && p !== 'options');
}

describe('xero-node getInvoices — the slots status-sync fills', () => {
  test('tenant, ifModifiedSince, where, order, iDs ... summaryOnly, in that order', () => {
    expect(paramsOf('getInvoices').slice(0, 13)).toEqual([
      'xeroTenantId', 'ifModifiedSince', 'where', 'order', 'iDs', 'invoiceNumbers',
      'contactIDs', 'statuses', 'page', 'includeArchived', 'createdByMyApp', 'unitdp', 'summaryOnly',
    ]);
  });

  test('ifModifiedSince is 2nd, iDs 5th and summaryOnly 13th, counting the tenant', () => {
    const p = paramsOf('getInvoices');
    expect(p.indexOf('ifModifiedSince')).toBe(1);
    expect(p.indexOf('iDs')).toBe(4);
    expect(p.indexOf('summaryOnly')).toBe(12);
  });
});

describe('status-sync through the real SDK, with the network replaced', () => {
  const HOUR = 60 * 60 * 1000;
  const ID1 = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';
  let originalAdapter, requests, answer;

  beforeAll(() => {
    originalAdapter = axios.defaults.adapter;
    axios.defaults.adapter = async config => {
      requests.push(config);
      // Anything not aimed at the Invoices endpoint would be a call this
      // module must never make.
      if (config.method !== 'get' || !/\/api\.xro\/2\.0\/Invoices$/.test(config.url)) {
        throw new Error(`unexpected ${config.method} ${config.url}`);
      }
      return { data: answer(config), status: 200, statusText: 'OK', headers: {}, config, request: {} };
    };
  });
  afterAll(() => { axios.defaults.adapter = originalAdapter; });

  test('IDs, summaryOnly and If-Modified-Since reach Xero as Xero expects, and the answer is stored', async () => {
    requests = [];
    // The SDK must be using the axios whose adapter was replaced.
    expect(require.resolve('axios', { paths: [require('path').dirname(require.resolve('xero-node'))] })).toBe(require.resolve('axios'));
    require('../db/migrate').run();
    const users      = require('../utils/users');
    const tokenCache = require('../utils/token-cache');
    const store      = require('../utils/invoice-store');
    const statusSync = require('./status-sync');

    const u = await users.createUser(`sdk${Date.now()}@test.com`, 'password123', 'user');
    tokenCache.forUser(u.id).cacheToken('tenant-1', 'Org', 'access-token', Date.now() + HOUR, 'oauth');
    const s = store.forUser(u.id);
    for (const [id, xeroInvoiceId] of [['a', ID1], ['b', ID2]]) {
      s.add({ id, status: 'posted', vendorName: 'Acme', totalAmount: 110, currency: 'SGD', xeroInvoiceId,
              xeroTenantId: 'tenant-1', processedAt: new Date().toISOString() });
    }

    // Xero's own JSON: PascalCase, and dates as "/Date(ms+0000)/".
    answer = () => ({ Invoices: [
      { InvoiceID: ID1, Status: 'PAID', AmountDue: 0, AmountPaid: 110, Total: 110, FullyPaidOnDate: '/Date(1757894400000+0000)/' },
      { InvoiceID: ID2, Status: 'AUTHORISED', AmountDue: 70, AmountPaid: 40, Total: 110 },
    ] });
    let clock = Date.now();
    await expect(statusSync.syncUser(u.id, { now: () => new Date(clock) }))
      .resolves.toEqual({ checked: 2, updated: 2, failedTenants: 0 });

    expect(requests).toHaveLength(1);
    const first = requests[0];
    expect(first.params).toMatchObject({ IDs: `${ID1},${ID2}`, summaryOnly: true });
    expect(first.params).not.toHaveProperty('page');
    expect(first.params).not.toHaveProperty('Statuses');
    const header = (cfg, name) => {
      const h = cfg.headers || {};
      if (typeof h.get === 'function') return h.get(name) ?? undefined;
      const key = Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase());
      return key ? h[key] : undefined;
    };
    expect(header(first, 'xero-tenant-id')).toBe('tenant-1');
    expect(header(first, 'If-Modified-Since')).toBeUndefined();

    expect(s.getById('a')).toMatchObject({ xeroStatus: 'PAID', xeroAmountDue: 0, xeroAmountPaid: 110, xeroPaidOn: '2025-09-15' });
    expect(s.getById('b')).toMatchObject({ xeroStatus: 'AUTHORISED', xeroAmountDue: 70, xeroAmountPaid: 40 });

    // The next read: only what changed comes back, asked for with the header.
    answer = () => ({ Invoices: [] });
    const lastRead = clock;
    clock += 3 * HOUR;
    await statusSync.syncUser(u.id, { now: () => new Date(clock) });
    expect(requests).toHaveLength(2);
    expect(header(requests[1], 'If-Modified-Since')).toBe(new Date(lastRead - statusSync.CLOCK_SLACK_MS).toISOString());
    expect(requests[1].params).toMatchObject({ IDs: `${ID1},${ID2}`, summaryOnly: true });
    expect(s.getById('b').xeroStatus).toBe('AUTHORISED');
  });
});
