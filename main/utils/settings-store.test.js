// No revenue account marked recurring or not recurring (see the marks below).
const NO_MARKS = { recurringAccounts: [], notRecurringAccounts: [] };

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
    expect(settingsStore.forUser(u.id).get()).toEqual({ autoProcess: false, defaultTenantId: null, ...NO_MARKS });
  });

  // The Xero company new documents go to when more than one is connected.
  test('defaultTenantId is stored, read back, and cleared by null or an empty value', async () => {
    const u = await users.createUser('s4@test.com', 'password123', 'user');
    const s = settingsStore.forUser(u.id);
    expect(s.get('defaultTenantId')).toBeNull();
    expect(s.set({ defaultTenantId: 'tenant-a' })).toEqual({ autoProcess: false, defaultTenantId: 'tenant-a', ...NO_MARKS });
    expect(settingsStore.forUser(u.id).get('defaultTenantId')).toBe('tenant-a');
    // Changing one setting leaves the other alone.
    s.set({ autoProcess: true });
    expect(s.get()).toEqual({ autoProcess: true, defaultTenantId: 'tenant-a', ...NO_MARKS });
    s.set({ defaultTenantId: '' });
    expect(s.get('defaultTenantId')).toBeNull();
    s.set({ defaultTenantId: 'tenant-b' });
    s.set({ defaultTenantId: null });
    expect(s.get('defaultTenantId')).toBeNull();
    expect(s.get('autoProcess')).toBe(true);
  });

  // The Start/Stop state a restart puts back (routes/process.js resumeWatchers).
  test('watcherEnabled is off for a new account, set and cleared, and listed while on', async () => {
    const a = await users.createUser('w1@test.com', 'password123', 'user');
    const b = await users.createUser('w2@test.com', 'password123', 'user');
    expect(settingsStore.forUser(a.id).watcherEnabled()).toBe(false);
    settingsStore.forUser(a.id).setWatcherEnabled(true);
    settingsStore.forUser(b.id).setWatcherEnabled(true);
    expect(settingsStore.forUser(a.id).watcherEnabled()).toBe(true);
    expect(settingsStore.watcherEnabledUserIds()).toEqual([a.id, b.id]);
    settingsStore.forUser(a.id).setWatcherEnabled(false);
    expect(settingsStore.forUser(a.id).watcherEnabled()).toBe(false);
    expect(settingsStore.watcherEnabledUserIds()).toEqual([b.id]);
    // Not part of the settings object the settings page reads and writes.
    expect(settingsStore.forUser(b.id).get()).toEqual({ autoProcess: false, defaultTenantId: null, ...NO_MARKS });
  });

  test('clearing it never creates a row (a stop during an account delete)', () => {
    settingsStore.forUser('no-such-user').setWatcherEnabled(false);
    const db = require('../db');
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?').get('no-such-user').n).toBe(0);
  });

  // The Revenue tab's per-account recurring marks, which override the guess
  // the reports make from an account's name.
  describe('recurring marks', () => {
    test('are stored per account each way, read back, and leave the other settings alone', async () => {
      const u = await users.createUser('r1@test.com', 'password123', 'user');
      const s = settingsStore.forUser(u.id);
      s.set({ autoProcess: true });
      expect(s.set({ recurringAccounts: ['Hosting'], notRecurringAccounts: ['Project Management Fees'] }))
        .toEqual({ autoProcess: true, defaultTenantId: null, recurringAccounts: ['Hosting'], notRecurringAccounts: ['Project Management Fees'] });
      expect(settingsStore.forUser(u.id).recurringOverrides())
        .toEqual({ recurringAccounts: ['Hosting'], notRecurringAccounts: ['Project Management Fees'] });
      // Stored as one JSON array of entries, one per marked account.
      const db = require('../db');
      expect(JSON.parse(db.prepare('SELECT recurring_accounts FROM user_settings WHERE user_id = ?').get(u.id).recurring_accounts))
        .toEqual([{ label: 'Hosting', recurring: true }, { label: 'Project Management Fees', recurring: false }]);
    });

    test('marking an account one way takes it off the other list, case and spacing ignored', async () => {
      const u = await users.createUser('r2@test.com', 'password123', 'user');
      const s = settingsStore.forUser(u.id);
      s.set({ notRecurringAccounts: ['Support  Fees', 'Consulting'] });
      expect(s.set({ recurringAccounts: ['support fees'] }))
        .toMatchObject({ recurringAccounts: ['support fees'], notRecurringAccounts: ['Consulting'] });
      expect(s.set({ notRecurringAccounts: ['Consulting', 'SUPPORT FEES'] }))
        .toMatchObject({ recurringAccounts: [], notRecurringAccounts: ['Consulting', 'SUPPORT FEES'] });
    });

    test('labels are trimmed, blanks dropped and duplicates kept once; empty lists clear the column', async () => {
      const u = await users.createUser('r3@test.com', 'password123', 'user');
      const s = settingsStore.forUser(u.id);
      expect(s.set({ recurringAccounts: [' Hosting ', '', 'hosting', 'SaaS'] }).recurringAccounts).toEqual(['Hosting', 'SaaS']);
      s.set({ recurringAccounts: [], notRecurringAccounts: [] });
      const db = require('../db');
      expect(db.prepare('SELECT recurring_accounts FROM user_settings WHERE user_id = ?').get(u.id).recurring_accounts).toBeNull();
      expect(s.get()).toMatchObject(NO_MARKS);
    });

    test('a plain array of labels, the simpler shape, reads as all recurring', async () => {
      const u = await users.createUser('r4@test.com', 'password123', 'user');
      settingsStore.forUser(u.id).get();
      const db = require('../db');
      db.prepare('UPDATE user_settings SET recurring_accounts = ? WHERE user_id = ?').run(JSON.stringify(['Hosting']), u.id);
      expect(settingsStore.forUser(u.id).recurringOverrides()).toEqual({ recurringAccounts: ['Hosting'], notRecurringAccounts: [] });
      db.prepare('UPDATE user_settings SET recurring_accounts = ? WHERE user_id = ?').run('not json', u.id);
      expect(settingsStore.forUser(u.id).recurringOverrides()).toEqual(NO_MARKS);
    });

    test('reading the marks never creates a settings row', () => {
      expect(settingsStore.forUser('nobody').recurringOverrides()).toEqual(NO_MARKS);
      const db = require('../db');
      expect(db.prepare('SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?').get('nobody').n).toBe(0);
    });

    test('without the column: reads give no marks, and a save refuses without changing anything', async () => {
      const u = await users.createUser('r5@test.com', 'password123', 'user');
      const db = require('../db');
      db.exec('ALTER TABLE user_settings DROP COLUMN recurring_accounts');
      const s = settingsStore.forUser(u.id);
      expect(s.get()).toEqual({ autoProcess: false, defaultTenantId: null, ...NO_MARKS });
      expect(s.recurringOverrides()).toEqual(NO_MARKS);
      expect(() => s.set({ autoProcess: true, recurringAccounts: ['Hosting'] })).toThrow(settingsStore.RecurringUnavailableError);
      // One transaction: the autoProcess half of that patch was not kept either.
      expect(s.get('autoProcess')).toBe(false);
      // Settings that do not touch the marks still save.
      expect(s.set({ autoProcess: true }).autoProcess).toBe(true);
    });
  });
});
