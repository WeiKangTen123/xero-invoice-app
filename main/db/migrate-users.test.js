// Addresses in one form (step 5) and the guards on users (the last section of
// schema.sql): one account per address in any case, and a role and demo flag
// that can only be what the code knows. On a new database all at once; on an
// old one once its rows pass, and until then an error naming the accounts on
// every boot, which carries on.
const fs   = require('fs');
const path = require('path');

describe('db/migrate — addresses and the guards on users', () => {
  const NAMES = ['idx_invoices_duplicate_of', 'idx_users_email_nocase', 'users_role_insert', 'users_role_update'];
  let db, run, logError, notifyError;

  const definitions = (database = db) => Object.fromEntries(database
    .prepare(`SELECT name, sql FROM sqlite_master WHERE name IN (${NAMES.map(() => '?').join(', ')}) ORDER BY name`)
    .all(...NAMES).map(r => [r.name, r.sql]));
  const emails = () => Object.fromEntries(db.prepare('SELECT id, email FROM users ORDER BY id').all().map(r => [r.id, r.email]));
  const guardErrors = () => logError.mock.calls.filter(([m]) => /^users guard /.test(m));

  // A database from before: none of the four, version 4, and rows as an
  // older server wrote them.
  function oldDatabase(rows) {
    run();
    db.exec('DROP TRIGGER users_role_insert; DROP TRIGGER users_role_update');
    db.exec('DROP INDEX idx_users_email_nocase; DROP INDEX idx_invoices_duplicate_of');
    db.pragma('user_version = 4');
    const insert = db.prepare('INSERT INTO users (id, email, password, role, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [id, email, role = 'user', isDemo = 0] of rows) insert.run(id, email, 'x', role, isDemo, '2026-01-01T00:00:00.000Z');
    expect(definitions()).toEqual({});
  }

  beforeEach(() => {
    jest.resetModules();
    notifyError = jest.fn(async () => {});
    jest.doMock('../utils/notify', () => ({ notifyError }));
    db = require('./index');
    ({ run } = require('./migrate'));
    logError = jest.spyOn(require('../utils/logger'), 'error');
  });
  afterEach(() => jest.dontMock('../utils/notify'));

  test('a new database has all four, defined exactly as schema.sql says', () => {
    run();
    const Database = require('better-sqlite3');
    const fromFile = new Database(':memory:');
    fromFile.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    expect(Object.keys(definitions())).toEqual(NAMES);
    expect(definitions()).toEqual(definitions(fromFile));
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(guardErrors()).toEqual([]);
  });

  test('an old database: addresses put in one form, then the same four as a new one; a second run changes nothing', () => {
    const Database = require('better-sqlite3');
    const fresh = new Database(':memory:');
    fresh.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

    oldDatabase([['u1', '  Alice@Example.COM '], ['u2', 'josé@example.com'], ['u3', 'bob@example.com'], ['u4', 'Ada@Example.com', 'admin', 1]]);
    run();
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(emails()).toEqual({ u1: 'alice@example.com', u2: 'josé@example.com', u3: 'bob@example.com', u4: 'ada@example.com' });
    expect(definitions()).toEqual(definitions(fresh));
    expect(guardErrors()).toEqual([]);

    // And they hold.
    const insert = (id, email, role = 'user', isDemo = 0) => db.prepare('INSERT INTO users (id, email, password, role, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, email, 'x', role, isDemo, '2026-01-01T00:00:00.000Z');
    expect(() => insert('u5', 'ALICE@example.com')).toThrow(/UNIQUE constraint failed: users\.email/);
    expect(() => insert('u6', 'eve@example.com', 'owner')).toThrow('users.role must be admin or user, and users.is_demo 0 or 1');
    expect(() => insert('u7', 'eve@example.com', 'user', 2)).toThrow('users.role must be admin or user');
    expect(() => db.prepare("UPDATE users SET role = 'superuser' WHERE id = 'u1'").run()).toThrow('users.role must be admin or user');
    expect(() => db.prepare("UPDATE users SET is_demo = 5 WHERE id = 'u1'").run()).toThrow('users.role must be admin or user');
    db.prepare("UPDATE users SET role = 'admin', is_demo = 1, last_seen_at = 'now' WHERE id = 'u1'").run();

    run();
    expect(definitions()).toEqual(definitions(fresh));
    expect(emails().u1).toBe('alice@example.com');
  });

  test('accounts that would share an address are left as they are and named; bad roles too; the boot carries on, and the next one finishes once they are put right', () => {
    oldDatabase([
      ['a1', 'Dana@Example.com'], ['a2', 'dana@example.com '], ['a3', ' Erin@Example.com'],
      ['bad', 'frank@example.com', 'owner'],
    ]);
    expect(() => run()).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    // The two that collide keep their addresses; the rest are normalised.
    expect(emails()).toEqual({ a1: 'Dana@Example.com', a2: 'dana@example.com ', a3: 'erin@example.com', bad: 'frank@example.com' });
    // Only what the rows allow: the duplicate_of index has nothing to wait on.
    expect(Object.keys(definitions())).toEqual(['idx_invoices_duplicate_of']);
    expect(guardErrors()).toEqual([
      [expect.stringMatching(/^users guard idx_users_email_nocase was not created: two or more accounts have the same address .*tried again on the next boot$/), { ids: [['a1', 'a2']] }],
      // Both triggers wait on the same rows: said once.
      [expect.stringMatching(/^users guard users_role_insert was not created: accounts whose role is not 'admin' or 'user'/), { ids: ['bad'] }],
    ]);
    expect(notifyError).toHaveBeenCalledTimes(2);
    expect(notifyError.mock.calls[0][0]).toMatchObject({ context: expect.stringMatching(/idx_users_email_nocase/), error: 'accounts: [["a1","a2"]]' });

    // A second boot with nothing put right says so again.
    logError.mockClear();
    run();
    expect(guardErrors()).toHaveLength(2);

    // Put right: one of the two goes, the role is corrected.
    db.prepare("DELETE FROM users WHERE id = 'a2'").run();
    db.prepare("UPDATE users SET role = 'user' WHERE id = 'bad'").run();
    logError.mockClear();
    run();
    expect(emails().a1).toBe('dana@example.com');
    expect(Object.keys(definitions())).toEqual(NAMES);
    expect(guardErrors()).toEqual([]);
  });

  test('deleting an account\'s invoices finds what points at each by the index', () => {
    run();
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM invoices WHERE duplicate_of = ?').all('x').map(r => r.detail).join(' ');
    expect(plan).toMatch(/USING (COVERING )?INDEX idx_invoices_duplicate_of/);
  });
});
