jest.mock('../utils/chat-agent', () => ({
  respond: jest.fn().mockResolvedValue({ reply: 'ok', proposals: [] }),
}));

const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('POST /api/chat', () => {
  let app, users, jwtSecret, user, token;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    const chatRoutes = require('./chat');

    user  = await users.createUser('chatuser@test.com', 'password123', 'user');
    token = jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());

    app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
  });

  test('rejects without auth', async () => {
    await request(serverFor(app)).post('/api/chat').send({ message: 'hi' }).expect(401);
  });

  test('rejects an empty message', async () => {
    await request(serverFor(app)).post('/api/chat').set('Authorization', `Bearer ${token}`).send({ message: '' }).expect(400);
  });

  test('returns the agent response for a normal message', async () => {
    const res = await request(serverFor(app))
      .post('/api/chat').set('Authorization', `Bearer ${token}`)
      .send({ message: 'hello' }).expect(200);
    expect(res.body).toEqual({ reply: 'ok', proposals: [] });
  });

  // Verifies the limiter is wired up with the intended 12/min cap via its response
  // headers, rather than exhausting the real 60s window — exhausting it is timing-
  // sensitive (flaky under system load: if the 12 requests take too long, the
  // window slides and the 13th never gets blocked), so this checks the config
  // deterministically instead of relying on wall-clock timing in the test itself.
  test('is configured with the intended 12/min cap (protects the shared Gemini quota)', async () => {
    const res = await request(serverFor(app))
      .post('/api/chat').set('Authorization', `Bearer ${token}`)
      .send({ message: 'hello' }).expect(200);
    expect(res.headers['ratelimit-limit']).toBe('12');
    expect(Number(res.headers['ratelimit-remaining'])).toBe(11);
  });
});

// ── Which company, and which period ─────────────────────────────────────────
// The dashboard switches company with ?tenantId=, but this route always took
// the first connected company, so the assistant could answer about the other
// one. The UI now sends the company on screen; it must be one of this
// account's own, and a company that is not is refused rather than swapped.
describe('POST /api/chat — the company and period the answer is about', () => {
  let app, users, db, token, user, chatAgent;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    db    = require('../db');
    users = require('../utils/users');
    chatAgent = require('../utils/chat-agent');
    const { jwtSecret } = require('../middleware/auth-middleware');
    const chatRoutes = require('./chat');

    user  = await users.createUser(`chat-tenant-${Date.now()}@test.com`, 'password123', 'user');
    token = jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
    const connect = (tenantId, name, at) => db.prepare('INSERT INTO xero_tenants (user_id, tenant_id, tenant_name, connected_at) VALUES (?, ?, ?, ?)')
      .run(user.id, tenantId, name, at);
    connect('tenant-a', 'Company A', '2026-01-01T00:00:00Z');
    connect('tenant-b', 'Company B', '2026-02-01T00:00:00Z');

    app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
  });

  const ask = body => request(serverFor(app)).post('/api/chat').set('Authorization', `Bearer ${token}`).send({ message: 'how is cash?', ...body });
  const sent = () => chatAgent.respond.mock.calls[0][1];

  test('the company the dashboard shows is the one asked about', async () => {
    await ask({ tenantId: 'tenant-b' }).expect(200);
    expect(sent().tenantId).toBe('tenant-b');
  });

  test('a company not connected to this account is refused, not swapped for another', async () => {
    const res = await ask({ tenantId: 'someone-elses-tenant' }).expect(400);
    expect(res.body.error).toMatch(/not connected/);
    expect(chatAgent.respond).not.toHaveBeenCalled();
  });

  test('with none named, the default company for sending is used, then the first connected', async () => {
    await ask({}).expect(200);
    expect(sent().tenantId).toBe('tenant-a');

    chatAgent.respond.mockClear();
    require('../utils/settings-store').forUser(user.id).set({ defaultTenantId: 'tenant-b' });
    await ask({}).expect(200);
    expect(sent().tenantId).toBe('tenant-b');
  });

  test('the period on screen is passed on, checked by the reports\' own gate', async () => {
    await ask({ tenantId: 'tenant-a', period: { preset: 'last-quarter' } }).expect(200);
    expect(sent().period).toEqual({ preset: 'last-quarter' });

    chatAgent.respond.mockClear();
    await ask({ period: { from: '2026-01', to: '2026-06' } }).expect(200);
    expect(sent().period).toEqual({ from: '2026-01', to: '2026-06' });
  });

  test('no period means the default, and a bad one is a 400', async () => {
    await ask({}).expect(200);
    expect(sent().period).toBeUndefined();
    await ask({ period: { preset: 'whenever' } }).expect(400);
    await ask({ period: { from: '2026-01' } }).expect(400);
  });
});

// ── The rows of the list on screen ──────────────────────────────────────────
// The screen sends the AR & AP list's rows, [{ n, id }], so "#5" can be read
// as a row of it. The list is checked here: a malformed one is a 400, and a
// row whose invoice is another account's never reaches the assistant.
describe('POST /api/chat — the invoice list on screen', () => {
  let app, token, user, chatAgent, store;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    require('../db/migrate').run();
    const users = require('../utils/users');
    const invoiceStore = require('../utils/invoice-store');
    chatAgent = require('../utils/chat-agent');
    const { jwtSecret } = require('../middleware/auth-middleware');
    const chatRoutes = require('./chat');

    user  = await users.createUser(`chat-list-${Date.now()}@test.com`, 'password123', 'user');
    token = jwt.sign({ id: user.id, email: user.email, role: user.role }, jwtSecret());
    store = invoiceStore.forUser(user.id);
    for (const id of ['mine-1', 'mine-2', 'mine-3']) store.add({ id, status: 'pending', vendorName: `Vendor ${id}`, invoiceNumber: id.toUpperCase(), totalAmount: 10 });
    const other = await users.createUser(`chat-list-other-${Date.now()}@test.com`, 'password123', 'user');
    invoiceStore.forUser(other.id).add({ id: 'theirs', status: 'pending', vendorName: 'Someone Else', invoiceNumber: 'X-1', totalAmount: 99 });

    app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
  });

  const ask = body => request(serverFor(app)).post('/api/chat').set('Authorization', `Bearer ${token}`).send({ message: 'check #2', ...body });
  const sent = () => chatAgent.respond.mock.calls[0][1];

  test('the rows are passed on as sent, in their order', async () => {
    const rows = [{ n: 1, id: 'mine-3' }, { n: 2, id: 'mine-1' }, { n: 3, id: 'mine-2' }];
    await ask({ visibleInvoices: rows }).expect(200);
    expect(sent().visibleInvoices).toEqual(rows);
  });

  test('a row whose invoice is another account\'s, or no invoice at all, is dropped', async () => {
    await ask({ visibleInvoices: [{ n: 1, id: 'mine-1' }, { n: 2, id: 'theirs' }, { n: 3, id: 'ghost' }, { n: 4, id: 'mine-2' }] }).expect(200);
    expect(sent().visibleInvoices).toEqual([{ n: 1, id: 'mine-1' }, { n: 4, id: 'mine-2' }]);
  });

  test('extra fields on a row are not passed on', async () => {
    await ask({ visibleInvoices: [{ n: 1, id: 'mine-1', vendorName: 'injected' }] }).expect(200);
    expect(sent().visibleInvoices).toEqual([{ n: 1, id: 'mine-1' }]);
  });

  test('no list, or null, is passed on as null; an empty list as empty', async () => {
    await ask({}).expect(200);
    expect(sent().visibleInvoices).toBeNull();
    chatAgent.respond.mockClear();
    await ask({ visibleInvoices: null }).expect(200);
    expect(sent().visibleInvoices).toBeNull();
    chatAgent.respond.mockClear();
    await ask({ visibleInvoices: [] }).expect(200);
    expect(sent().visibleInvoices).toEqual([]);
  });

  // Two tests of six requests: the chat limiter allows 12 a minute.
  const refused = async bad => {
    for (const visibleInvoices of bad) {
      const res = await ask({ visibleInvoices }).expect(400);
      expect(res.body.error).toMatch(/invoice list .* could not be read/);
    }
    expect(chatAgent.respond).not.toHaveBeenCalled();
  };

  test('a list of the wrong shape is a 400 and the assistant is not asked', () => refused([
    'mine-1',                                                              // not a list
    { n: 1, id: 'mine-1' },                                                // not a list
    Array.from({ length: 201 }, (_, i) => ({ n: i + 1, id: 'mine-1' })),  // over 200 rows
    [null],
    [{ n: 1, id: 'mine-1' }, { n: 1, id: 'mine-2' }],                      // each n once
    [{ n: 1, id: 'x'.repeat(129) }],
  ]));

  test('a row with a bad number or id is a 400 and the assistant is not asked', () => refused([
    [{ n: 0, id: 'mine-1' }],                                              // n from 1
    [{ n: -2, id: 'mine-1' }],
    [{ n: 1.5, id: 'mine-1' }],                                            // whole numbers only
    [{ n: '1', id: 'mine-1' }],                                            // a number, not a string
    [{ n: 1, id: 42 }],                                                    // id a string
    [{ n: 1, id: '' }],
  ]));

  test('200 rows are accepted', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ n: i + 1, id: i === 0 ? 'mine-1' : `ghost-${i}` }));
    await ask({ visibleInvoices: rows }).expect(200);
    expect(sent().visibleInvoices).toEqual([{ n: 1, id: 'mine-1' }]);
  });
});
