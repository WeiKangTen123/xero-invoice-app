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
