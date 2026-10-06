describe('settings-store (SQLite)', () => {
  let users, settingsStore;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    users         = require('./users');
    settingsStore = require('./settings-store');
  });

  // Deliberately OFF. Auto-submit posts invoices into a live accounting system,
  // and nobody had ever chosen it — the column default, the settings-store
  // default and createUser all said ON, so a new account started writing to
  // someone's books before they had configured anything. Opt-in, not opt-out.
  test('a fresh user has autoProcess OFF — auto-submit is never inherited', async () => {
    const u = await users.createUser('s1@test.com', 'password123', 'user');
    expect(settingsStore.forUser(u.id).get('autoProcess')).toBe(false);
  });

  test('turning it on works, and survives a fresh forUser() lookup', async () => {
    const u = await users.createUser('s1b@test.com', 'password123', 'user');
    settingsStore.forUser(u.id).set({ autoProcess: true });
    expect(settingsStore.forUser(u.id).get('autoProcess')).toBe(true);
  });

  test('set persists across separate forUser() calls', async () => {
    const u = await users.createUser('s2@test.com', 'password123', 'user');
    settingsStore.forUser(u.id).set({ autoProcess: false });
    expect(settingsStore.forUser(u.id).get('autoProcess')).toBe(false);
  });

  test('get() with no key returns the whole settings object', async () => {
    const u = await users.createUser('s3@test.com', 'password123', 'user');
    expect(settingsStore.forUser(u.id).get()).toEqual({ autoProcess: false, defaultTenantId: null });
  });

  // The Xero company new documents go to when more than one is connected.
  test('defaultTenantId is stored, read back, and cleared by null or an empty value', async () => {
    const u = await users.createUser('s4@test.com', 'password123', 'user');
    const s = settingsStore.forUser(u.id);
    expect(s.get('defaultTenantId')).toBeNull();
    expect(s.set({ defaultTenantId: 'tenant-a' })).toEqual({ autoProcess: false, defaultTenantId: 'tenant-a' });
    expect(settingsStore.forUser(u.id).get('defaultTenantId')).toBe('tenant-a');
    // Changing one setting leaves the other alone.
    s.set({ autoProcess: true });
    expect(s.get()).toEqual({ autoProcess: true, defaultTenantId: 'tenant-a' });
    s.set({ defaultTenantId: '' });
    expect(s.get('defaultTenantId')).toBeNull();
    s.set({ defaultTenantId: 'tenant-b' });
    s.set({ defaultTenantId: null });
    expect(s.get('defaultTenantId')).toBeNull();
    expect(s.get('autoProcess')).toBe(true);
  });
});
