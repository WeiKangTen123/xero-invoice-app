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

  // One invoice goes to one Xero company: the row records which, and the
  // account records which company new documents default to.
  test('invoices.xero_tenant_id and user_settings.default_tenant_id exist after a run', () => {
    run();
    const cols = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    expect(cols('invoices')).toContain('xero_tenant_id');
    expect(cols('user_settings')).toContain('default_tenant_id');
  });

  // Tax-inclusive, branding theme, a claim's exchange rate, a note from the
  // send in progress, and the claimant's payee name.
  test('the posting columns and the claim payee column exist, and are added to an older database', () => {
    run();
    const cols = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    for (const c of ['line_amount_types', 'branding_theme_name', 'currency_rate', 'post_note']) {
      db.exec(`ALTER TABLE invoices DROP COLUMN ${c}`);
    }
    db.exec('ALTER TABLE user_credentials DROP COLUMN claim_payee_name');
    run();
    for (const c of ['line_amount_types', 'branding_theme_name', 'currency_rate', 'post_note']) expect(cols('invoices')).toContain(c);
    expect(cols('user_credentials')).toContain('claim_payee_name');
  });

  test('a deployed database without them gains both on the next boot', () => {
    run();
    db.exec('ALTER TABLE invoices DROP COLUMN xero_tenant_id');
    db.exec('ALTER TABLE user_settings DROP COLUMN default_tenant_id');
    run();
    const cols = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    expect(cols('invoices')).toContain('xero_tenant_id');
    expect(cols('user_settings')).toContain('default_tenant_id');
  });

  // Step 2 rebuilds user_settings with only the columns it knew. On a database
  // old enough to run it, a column ensured before the step would be dropped.
  test('the user_settings rebuild of an old database does not lose default_tenant_id', () => {
    run();
    db.exec('DROP TABLE user_settings');
    db.exec(`CREATE TABLE user_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      auto_process INTEGER NOT NULL DEFAULT 1
    )`);
    db.pragma('user_version = 1');
    run();
    const cols = db.prepare('PRAGMA table_info(user_settings)').all();
    expect(String(cols.find(c => c.name === 'auto_process').dflt_value)).toBe('0');
    expect(cols.map(c => c.name)).toContain('default_tenant_id');
  });

  test('one-off steps run once: a second run leaves the version where it is and touches nothing', () => {
    run();
    const v = db.pragma('user_version', { simple: true });
    run();
    expect(db.pragma('user_version', { simple: true })).toBe(v);
  });

  // The mailbox watcher's on/off is kept so a restart can bring it back.
  test('user_settings.watcher_enabled exists after a run, defaults to off, and is added to an older database', () => {
    run();
    const col = () => db.prepare('PRAGMA table_info(user_settings)').all().find(c => c.name === 'watcher_enabled');
    expect(col()).toMatchObject({ notnull: 1, dflt_value: '0' });
    db.exec('ALTER TABLE user_settings DROP COLUMN watcher_enabled');
    expect(col()).toBeUndefined();
    run();
    expect(col()).toMatchObject({ notnull: 1, dflt_value: '0' });
  });

  // A step that threw part-way used to leave what it had written so far, log
  // a warning, and let later steps move the version past it for good.
  test('a failing step is rolled back whole, alerts, does not exit, and stops the steps after it; the next boot retries it', async () => {
    run();
    const users = require('../utils/users');
    const u = await users.createUser('retry@test.com', 'password123', 'user');
    db.prepare('INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)').run(u.id);
    db.prepare('UPDATE user_credentials SET imap_pass = ? WHERE user_id = ?').run('still-plain', u.id);
    db.pragma('user_version = 1');   // steps 2-4 are still to run

    const notifyError = jest.fn(async () => {});
    jest.doMock('../utils/notify', () => ({ notifyError }));
    jest.doMock('./migrate-autoprocess-default', () => ({ run: () => {
      db.exec('CREATE TABLE half_done (x INTEGER)');
      db.prepare('INSERT INTO half_done VALUES (1)').run();
      throw new Error('row count changed during migration: 3 -> 2');
    } }));
    const logError = jest.spyOn(require('../utils/logger'), 'error');
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
    const plain = () => db.prepare('SELECT imap_pass FROM user_credentials WHERE user_id = ?').get(u.id).imap_pass;
    try {
      expect(() => run()).not.toThrow();
      expect(exit).not.toHaveBeenCalled();
      // Nothing the step wrote survives, and the version did not move.
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
      expect(db.pragma('user_version', { simple: true })).toBe(1);
      // Step 3 did not run past it: it would have moved the version to 3 and
      // step 2 would never have been retried.
      expect(plain()).toBe('still-plain');
      expect(logError).toHaveBeenCalledWith(expect.stringMatching(/^migration step 2 \(auto_process default\) failed and was rolled back/), expect.objectContaining({ error: 'row count changed during migration: 3 -> 2' }));
      expect(notifyError).toHaveBeenCalledTimes(1);
      expect(notifyError.mock.calls[0][0]).toMatchObject({ context: expect.stringMatching(/step 2 .*retried on the next boot/), error: 'row count changed during migration: 3 -> 2' });
      // The columns ensured after the steps are still ensured.
      expect(db.prepare('PRAGMA table_info(user_settings)').all().map(c => c.name)).toContain('watcher_enabled');
    } finally {
      jest.dontMock('./migrate-autoprocess-default');
      jest.dontMock('../utils/notify');
      exit.mockRestore();
    }

    // Next boot, with the cause gone: the step and everything after it run.
    run();
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(plain()).toMatch(/^enc:v1:/);
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
