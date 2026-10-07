// The columns behind mileage and per diem claims: the rates and accounts on
// the user's settings, and the kind, quantity, rate, unit and details on a
// claim. A deployed database gains them on its next boot, and every boot after
// that leaves them as they are.
describe('db/migrate — mileage and per diem columns', () => {
  let db, run;
  const CLAIM_COLUMNS = { claim_kind: 'TEXT', claim_quantity: 'REAL', claim_rate: 'REAL', claim_unit: 'TEXT', claim_details: 'TEXT' };
  const RATE_COLUMNS  = ['mileage_rate', 'mileage_account_code', 'per_diem_rate', 'per_diem_account_code'];

  beforeEach(() => {
    jest.resetModules();
    db = require('./index');
    ({ run } = require('./migrate'));
  });

  const columns = table => Object.fromEntries(db.prepare(`PRAGMA table_info(${table})`).all().map(c => [c.name, c.type]));

  test('a fresh database has them, with their types', () => {
    run();
    expect(columns('invoices')).toMatchObject(CLAIM_COLUMNS);
    for (const c of RATE_COLUMNS) expect(columns('user_credentials')[c]).toBe('TEXT');
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invoices'").all().map(r => r.name);
    expect(indexes).toContain('idx_invoices_claim_kind');
  });

  test('a database from before them gains them, keeping its rows', () => {
    run();
    db.exec("INSERT OR IGNORE INTO users (id, email, password, created_at) VALUES ('mig-u', 'mig@test.com', 'x', '2026-01-01')");
    db.exec("INSERT INTO invoices (id, user_id, status, invoice_type, total_amount, processed_at) VALUES ('mig-1', 'mig-u', 'posted', 'EXPENSE', 1250, '2026-01-01')");
    db.exec('DROP INDEX IF EXISTS idx_invoices_claim_kind');
    for (const c of Object.keys(CLAIM_COLUMNS)) db.exec(`ALTER TABLE invoices DROP COLUMN ${c}`);
    for (const c of RATE_COLUMNS) db.exec(`ALTER TABLE user_credentials DROP COLUMN ${c}`);
    expect(columns('invoices').claim_kind).toBeUndefined();

    run();
    expect(columns('invoices')).toMatchObject(CLAIM_COLUMNS);
    for (const c of RATE_COLUMNS) expect(columns('user_credentials')[c]).toBe('TEXT');
    const row = db.prepare("SELECT total_amount, claim_kind, claim_quantity FROM invoices WHERE id = 'mig-1'").get();
    expect(row).toEqual({ total_amount: 1250, claim_kind: null, claim_quantity: null });
    // An existing claim reads back as a receipt claim.
    expect(require('../utils/invoice-store').forUser('mig-u').getById('mig-1').claimKind).toBe('receipt');
  });

  test('running again changes nothing and does not fail', () => {
    run();
    const before = { inv: columns('invoices'), cred: columns('user_credentials'), version: db.pragma('user_version', { simple: true }) };
    expect(() => { run(); run(); }).not.toThrow();
    expect(columns('invoices')).toEqual(before.inv);
    expect(columns('user_credentials')).toEqual(before.cred);
    expect(db.pragma('user_version', { simple: true })).toBe(before.version);
  });
});
