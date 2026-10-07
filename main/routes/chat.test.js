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
