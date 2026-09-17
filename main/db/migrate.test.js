// The runner had no version: every boot re-ran the backfill, the rebuild and
// the column drop, and schema.sql did not even list the receipt columns.
// One-off steps now run once and the database records where it is.
describe('db/migrate', () => {
  let db, run;
  beforeEach(() => {
    jest.resetModules();
    db = require('./index');
    ({ run } = require('./migrate'));
  });

  test('a database built from an older schema gains the columns and records its version', () => {
    run();
    const cols = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
    for (const c of ['receipt_file', 'receipt_hash', 'received_at', 'vendor_phone', 'project_name']) expect(cols).toContain(c);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(1);
  });

  test('one-off steps run once: a second run leaves the version where it is and touches nothing', () => {
    run();
    const v = db.pragma('user_version', { simple: true });
    run();
    expect(db.pragma('user_version', { simple: true })).toBe(v);
  });

  test('a plaintext credential left from before encryption is encrypted on boot', async () => {
    run();
    const users = require('../utils/users');
    const u = await users.createUser('plain@test.com', 'password123', 'user');
    db.prepare('INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)').run(u.id);
    db.prepare('UPDATE user_credentials SET imap_pass = ? WHERE user_id = ?').run('legacy-plain', u.id);
    db.pragma('user_version = 0');   // pretend this database predates the step
    run();
    expect(db.prepare('SELECT imap_pass FROM user_credentials WHERE user_id = ?').get(u.id).imap_pass).toMatch(/^enc:v1:/);
    expect(users.getUserConfig(u.id).IMAP_PASS).toBe('legacy-plain');
  });
});
