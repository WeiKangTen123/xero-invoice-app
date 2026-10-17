// A demo account (users.is_demo): made with createUser's `demo`, read by
// isDemoUser, shown to the client as `demo`, and counted as Xero-configured
// so its mailbox watcher can start. Real users and database.
describe('users — demo accounts', () => {
  let users, db;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    db    = require('../db');
    users = require('./users');
  });

  test('the migration adds users.is_demo, defaulting to 0, to an older database', () => {
    const col = () => db.prepare('PRAGMA table_info(users)').all().find(c => c.name === 'is_demo');
    expect(col()).toMatchObject({ notnull: 1, dflt_value: '0' });
    db.exec('ALTER TABLE users DROP COLUMN is_demo');
    expect(col()).toBeUndefined();
    require('../db/migrate').run();
    expect(col()).toMatchObject({ notnull: 1, dflt_value: '0' });
  });

  test('createUser makes a real account unless asked for a demo one', async () => {
    const real = await users.createUser('real@test.com', 'password123', 'user');
    const demo = await users.createUser('demo@test.com', 'password123', 'user', { demo: true });
    const both = await users.createUser('both@test.com', 'password123', 'user', { temporary: true, demo: true });
    expect(real.demo).toBe(false);
    expect(demo.demo).toBe(true);
    expect(both).toMatchObject({ demo: true, mustChangePassword: true });
    expect(users.findById(real.id).is_demo).toBe(0);
    expect(users.findById(demo.id).is_demo).toBe(1);
  });

  test('isDemoUser: the flag, false for a real account and for no account', async () => {
    const real = await users.createUser('real@test.com', 'password123', 'user');
    const demo = await users.createUser('demo@test.com', 'password123', 'user', { demo: true });
    expect(users.isDemoUser(demo.id)).toBe(true);
    expect(users.isDemoUser(real.id)).toBe(false);
    expect(users.isDemoUser('nobody')).toBe(false);
  });

  test('sanitize carries demo everywhere an account is listed or returned', async () => {
    const demo = await users.createUser('demo@test.com', 'password123', 'user', { demo: true });
    await users.createUser('real@test.com', 'password123', 'user');
    expect(users.getAllUsers().map(u => [u.email, u.demo])).toEqual([['demo@test.com', true], ['real@test.com', false]]);
    expect((await users.validatePassword('demo@test.com', 'password123')).demo).toBe(true);
    expect(users.updateUserRole(demo.id, 'admin').demo).toBe(true);
    expect(users.setDisabled(demo.id, true).demo).toBe(true);
    expect(users.unlockAccount(demo.id).demo).toBe(true);
  });

  // A demo account has no Xero to set up: the watcher's "setup complete"
  // check (routes/process.js) must not hold it back for Xero.
  test('getSetupStatus counts a demo account as Xero-configured, and nothing else changes', async () => {
    const demo = await users.createUser('demo@gmail.com', 'password123', 'user', { demo: true });
    const real = await users.createUser('real@gmail.com', 'password123', 'user');
    for (const id of [demo.id, real.id]) users.saveUserConfig(id, { IMAP_PASS: 'app-pass' });
    expect(users.getSetupStatus(demo.id)).toMatchObject({ xero: { configured: true }, imap: { configured: true }, ready: true, missingConfig: ['llm'] });
    expect(users.getSetupStatus(real.id)).toMatchObject({ xero: { configured: false }, ready: false, missingConfig: ['xero', 'llm'] });
  });
});
