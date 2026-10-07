const request = require('supertest');
const { serverFor } = require('../scripts/test-server'); // one server per test, not per request
const express = require('express');
const jwt     = require('jsonwebtoken');

// Nothing in this file starts a watcher; the stand-in keeps node-imap from
// ever being loaded for real.
jest.mock('imap', () => jest.fn());

// No revenue account marked recurring or not recurring.
const NO_MARKS = { recurringAccounts: [], notRecurringAccounts: [] };

// GET/PATCH /api/process/settings. defaultTenantId is the Xero company new
// documents go to when more than one is connected; with several connected and
// none chosen, nothing is sent (queue/processor.js).
describe('routes/process settings', () => {
  let app, users, jwtSecret, testUser, db;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db    = require('../db');
    users = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    const processRoutes = require('./process');

    testUser = await users.createUser(`ps${Date.now()}@test.com`, 'password123', 'user');
    const connect = (tenantId, name) => db.prepare('INSERT INTO xero_tenants (user_id, tenant_id, tenant_name, connected_at) VALUES (?, ?, ?, ?)')
      .run(testUser.id, tenantId, name, new Date().toISOString());
    connect('tenant-a', 'Company A');
    connect('tenant-b', 'Company B');

    app = express();
    app.use(express.json());
    app.use('/api/process', processRoutes);
  });

  const auth = () => `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`;
  const get   = () => request(serverFor(app)).get('/api/process/settings').set('Authorization', auth());
  const patch = body => request(serverFor(app)).patch('/api/process/settings').set('Authorization', auth()).send(body);

  test('GET returns autoProcess and defaultTenantId, both unset for a new account', async () => {
    const res = await get().expect(200);
    expect(res.body).toEqual({ autoProcess: false, defaultTenantId: null, ...NO_MARKS });
  });

  test('PATCH accepts a connected company and GET returns it', async () => {
    const res = await patch({ defaultTenantId: 'tenant-b' }).expect(200);
    expect(res.body).toEqual({ autoProcess: false, defaultTenantId: 'tenant-b', ...NO_MARKS });
    expect((await get().expect(200)).body.defaultTenantId).toBe('tenant-b');
  });

  test('PATCH refuses a company that is not connected, or a value that is not an id', async () => {
    await patch({ defaultTenantId: 'tenant-z' }).expect(400);
    await patch({ defaultTenantId: 42 }).expect(400);
    await patch({ defaultTenantId: ['tenant-a'] }).expect(400);
    expect((await get().expect(200)).body.defaultTenantId).toBeNull();
  });

  test("another account's company is not a connected company", async () => {
    const other = await users.createUser(`ps2${Date.now()}@test.com`, 'password123', 'user');
    db.prepare('INSERT INTO xero_tenants (user_id, tenant_id, tenant_name, connected_at) VALUES (?, ?, ?, ?)')
      .run(other.id, 'tenant-other', 'Theirs', new Date().toISOString());
    await patch({ defaultTenantId: 'tenant-other' }).expect(400);
  });

  test('null or an empty string clears it', async () => {
    await patch({ defaultTenantId: 'tenant-a' }).expect(200);
    expect((await patch({ defaultTenantId: null }).expect(200)).body.defaultTenantId).toBeNull();
    await patch({ defaultTenantId: 'tenant-a' }).expect(200);
    expect((await patch({ defaultTenantId: '' }).expect(200)).body.defaultTenantId).toBeNull();
  });

  test('autoProcess still works on its own and leaves the default alone', async () => {
    await patch({ defaultTenantId: 'tenant-a' }).expect(200);
    const res = await patch({ autoProcess: true }).expect(200);
    expect(res.body).toEqual({ autoProcess: true, defaultTenantId: 'tenant-a', ...NO_MARKS });
  });

  // The Revenue tab's recurring marks.
  test('recurring marks are saved each way, returned by GET, and cleared by null', async () => {
    const res = await patch({ recurringAccounts: ['Hosting'], notRecurringAccounts: ['Project Management Fees'] }).expect(200);
    expect(res.body).toMatchObject({ recurringAccounts: ['Hosting'], notRecurringAccounts: ['Project Management Fees'] });
    expect((await get().expect(200)).body).toMatchObject({ recurringAccounts: ['Hosting'], notRecurringAccounts: ['Project Management Fees'] });
    expect((await patch({ recurringAccounts: null }).expect(200)).body)
      .toMatchObject({ recurringAccounts: [], notRecurringAccounts: ['Project Management Fees'] });
  });

  test('a list that is not an array of at most 200 names is refused, and nothing is saved', async () => {
    await patch({ recurringAccounts: 'Hosting' }).expect(400);
    await patch({ recurringAccounts: [42] }).expect(400);
    await patch({ notRecurringAccounts: { a: 1 } }).expect(400);
    await patch({ recurringAccounts: Array.from({ length: 201 }, (_, i) => `Account ${i}`) }).expect(400);
    await patch({ recurringAccounts: ['x'.repeat(201)] }).expect(400);
    // Refused whole: the valid part of a bad request is not kept either.
    await patch({ autoProcess: true, recurringAccounts: [42] }).expect(400);
    expect((await get().expect(200)).body).toEqual({ autoProcess: false, defaultTenantId: null, ...NO_MARKS });
    // Exactly 200 is allowed.
    await patch({ recurringAccounts: Array.from({ length: 200 }, (_, i) => `Account ${i}`) }).expect(200);
  });

  test('an account cannot be marked both ways in one request', async () => {
    await patch({ recurringAccounts: ['Hosting'], notRecurringAccounts: ['hosting '] }).expect(400);
  });

  test('without the column the marks are refused with 503 and nothing in the request is saved', async () => {
    db.exec('ALTER TABLE user_settings DROP COLUMN recurring_accounts');
    expect((await get().expect(200)).body).toEqual({ autoProcess: false, defaultTenantId: null, ...NO_MARKS });
    await patch({ autoProcess: true, recurringAccounts: ['Hosting'] }).expect(503);
    expect((await get().expect(200)).body.autoProcess).toBe(false);
  });
});
