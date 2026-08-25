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
    expect(settingsStore.forUser(u.id).get()).toEqual({ autoProcess: false });
  });
});
