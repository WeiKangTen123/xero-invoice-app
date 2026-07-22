describe('settings-store (SQLite)', () => {
  let users, settingsStore;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    users         = require('./users');
    settingsStore = require('./settings-store');
  });

  test('defaults to autoProcess true for a fresh user', async () => {
    const u = await users.createUser('s1@test.com', 'password123', 'user');
    expect(settingsStore.forUser(u.id).get('autoProcess')).toBe(true);
  });

  test('set persists across separate forUser() calls', async () => {
    const u = await users.createUser('s2@test.com', 'password123', 'user');
    settingsStore.forUser(u.id).set({ autoProcess: false });
    expect(settingsStore.forUser(u.id).get('autoProcess')).toBe(false);
  });

  test('get() with no key returns the whole settings object', async () => {
    const u = await users.createUser('s3@test.com', 'password123', 'user');
    expect(settingsStore.forUser(u.id).get()).toEqual({ autoProcess: true });
  });
});
