describe('users store (SQLite)', () => {
  let users;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    users = require('./users');
  });

  test('createUser / findByEmail / findById', async () => {
    const u = await users.createUser('a@test.com', 'password123', 'user');
    expect(u.email).toBe('a@test.com');
    expect(u.role).toBe('user');
    expect(users.findByEmail('A@Test.com').id).toBe(u.id);
    expect(users.findById(u.id).email).toBe('a@test.com');
  });

  test('first user via auto role becomes admin, second becomes user', async () => {
    const u1 = await users.createUser('first@test.com', 'password123', 'auto');
    const u2 = await users.createUser('second@test.com', 'password123', 'auto');
    expect(u1.role).toBe('admin');
    expect(u2.role).toBe('user');
  });

  test('createUser rejects duplicate email', async () => {
    await users.createUser('dup@test.com', 'password123', 'user');
    await expect(users.createUser('dup@test.com', 'password123', 'user')).rejects.toThrow('Email already exists');
  });

  test('validatePassword', async () => {
    const u = await users.createUser('pw@test.com', 'correcthorse', 'user');
    expect(await users.validatePassword('pw@test.com', 'correcthorse')).toMatchObject({ id: u.id });
    expect(await users.validatePassword('pw@test.com', 'wrongpass')).toBeNull();
  });

  test('updateUserRole', async () => {
    const u = await users.createUser('role@test.com', 'password123', 'user');
    const updated = users.updateUserRole(u.id, 'admin');
    expect(updated.role).toBe('admin');
    expect(users.findById(u.id).role).toBe('admin');
  });

  test('saveUserConfig / getUserConfig round-trip, empty string clears field', async () => {
    const u = await users.createUser('cfg@test.com', 'password123', 'user');
    users.saveUserConfig(u.id, { XERO_CLIENT_ID: 'abc', IMAP_HOST: 'imap.gmail.com' });
    let cfg = users.getUserConfig(u.id);
    expect(cfg.XERO_CLIENT_ID).toBe('abc');
    expect(cfg.IMAP_HOST).toBe('imap.gmail.com');

    users.saveUserConfig(u.id, { XERO_CLIENT_ID: '' });
    cfg = users.getUserConfig(u.id);
    expect(cfg.XERO_CLIENT_ID).toBeUndefined();
  });

  test('getSetupStatus reflects configured sections', async () => {
    const u = await users.createUser('setup@test.com', 'password123', 'user');
    expect(users.getSetupStatus(u.id).ready).toBe(false);
    users.saveUserConfig(u.id, {
      XERO_CLIENT_ID: 'id', XERO_CLIENT_SECRET: 'secret',
      IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASS: 'p',
    });
    expect(users.getSetupStatus(u.id).ready).toBe(true);
  });

  test('deleteUser cascades to credentials/settings/invoices', async () => {
    const u = await users.createUser('cascade@test.com', 'password123', 'user');
    users.saveUserConfig(u.id, { XERO_CLIENT_ID: 'abc' });
    const invoiceStore = require('./invoice-store');
    invoiceStore.forUser(u.id).add({ id: 'inv1', status: 'pending', processedAt: new Date().toISOString() });

    users.deleteUser(u.id);

    expect(users.findById(u.id)).toBeNull();
    expect(users.getUserConfig(u.id)).toEqual({});
    expect(invoiceStore.forUser(u.id).getAll()).toEqual([]);
  });
});
