// utils/onboarding.js keeps its own table (user_onboarding), created at load
// as token-cache.js creates xero_connection_health. TABLE_SQL is the
// definition to copy into db/schema.sql, so it is pinned here: the columns
// the brief names, a row per account, gone with the account.
describe('utils/onboarding', () => {
  let db, users, onboarding;

  beforeEach(() => {
    jest.resetModules();
    require('../db/migrate').run();
    db         = require('../db');
    users      = require('../utils/users');
    onboarding = require('./onboarding');
  });

  test('the table is created at load, with exactly the columns TABLE_SQL names', () => {
    const cols = db.prepare('PRAGMA table_info(user_onboarding)').all();
    expect(cols.map(c => c.name)).toEqual([
      'user_id', 'notice_version', 'notice_seen_at',
      'llm_ok', 'llm_message', 'llm_checked_at',
      'imap_ok', 'imap_message', 'imap_checked_at',
      'xero_ok', 'xero_message', 'xero_checked_at',
    ]);
    expect(cols.find(c => c.name === 'user_id')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(onboarding.TABLE_SQL).toMatch(/^CREATE TABLE IF NOT EXISTS user_onboarding \(/);
    expect(onboarding.TABLE_SQL).toContain('user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE');
    // Safe to run again, as every boot does.
    expect(() => db.exec(onboarding.TABLE_SQL)).not.toThrow();
  });

  test("an account's row goes with the account", async () => {
    const u = await users.createUser('gone@gmail.com', 'password123', 'user');
    onboarding.acknowledgeNotice(u.id, 1);
    onboarding.recordTest(u.id, 'llm', { ok: true });
    users.deleteUser(u.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_onboarding').get().n).toBe(0);
  });

  test('a Test result: kept, read back, cleared; only the three kinds there are', async () => {
    const u = await users.createUser('t@gmail.com', 'password123', 'user');
    expect(onboarding.lastTest(u.id, 'imap')).toBeNull();
    expect(onboarding.recordTest(u.id, 'imap', { ok: false, message: 'x'.repeat(400), at: '2026-10-22T01:02:03Z' })).toBe(true);
    const r = onboarding.lastTest(u.id, 'imap');
    expect(r).toMatchObject({ ok: false, checkedAt: '2026-10-22T01:02:03.000Z' });
    expect(r.message).toHaveLength(300);
    expect(onboarding.clearTest(u.id, 'imap')).toBe(true);
    expect(onboarding.lastTest(u.id, 'imap')).toBeNull();

    // A name that is not a kind never reaches the SQL it would be part of.
    expect(onboarding.recordTest(u.id, 'notice_version = 9, llm', { ok: true })).toBe(false);
    expect(onboarding.clearTest(u.id, 'smtp')).toBe(false);
    expect(onboarding.lastTest(u.id, 'smtp')).toBeNull();
  });

  test('a write that fails is reported as false, never thrown', () => {
    // No such account: the foreign key refuses the row.
    expect(onboarding.recordTest('no-such-user', 'llm', { ok: true })).toBe(false);
    expect(onboarding.lastTest('no-such-user', 'llm')).toBeNull();
  });

  test('the notice: required until this version is acknowledged, and again for a newer one', async () => {
    const u = await users.createUser('n@gmail.com', 'password123', 'user');
    expect(onboarding.noticeState(u.id)).toMatchObject({ required: true, version: 1, seenVersion: null, seenAt: null });
    onboarding.acknowledgeNotice(u.id, 1, '2026-10-22T00:00:00Z');
    expect(onboarding.noticeState(u.id)).toMatchObject({ required: false, seenVersion: 1, seenAt: '2026-10-22T00:00:00.000Z' });
    expect(onboarding.noticeState(u.id, 2)).toMatchObject({ required: true, version: 2, seenVersion: 1 });
    expect(onboarding.currentNoticeVersion()).toBe(onboarding.NOTICE_VERSION);
  });
});
