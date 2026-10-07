// The columns that hold what Xero says about a posted record, and the table
// that remembers each company's last complete read. A deployed database has
// neither, so the boot's migration must add them, leave every existing row
// NULL (unknown, which the UI shows as nothing), and be safe to run again.
describe('db/migrate — Xero status read-back', () => {
  let db, run;
  const XERO_COLUMNS = {
    xero_status: 'TEXT', xero_amount_due: 'INTEGER', xero_amount_paid: 'INTEGER', xero_paid_on: 'TEXT', xero_synced_at: 'TEXT',
  };
  const columns = () => Object.fromEntries(db.prepare('PRAGMA table_info(invoices)').all().map(c => [c.name, c.type]));

  beforeEach(() => {
    jest.resetModules();
    db = require('./index');
    ({ run } = require('./migrate'));
  });

  test('a fresh database has the five columns, typed for cents where they hold money', () => {
    run();
    expect(columns()).toMatchObject(XERO_COLUMNS);
  });

  test('a deployed database without them gains them on the next boot, its rows left NULL', () => {
    run();
    db.prepare("INSERT INTO users (id, email, password, created_at) VALUES ('u1', 'u1@test.com', 'x', '2026-01-01')").run();
    db.prepare(`INSERT INTO invoices (id, user_id, status, xero_invoice_id, processed_at)
                VALUES ('old', 'u1', 'posted', 'x-1', '2026-01-01')`).run();
    for (const c of Object.keys(XERO_COLUMNS)) db.exec(`ALTER TABLE invoices DROP COLUMN ${c}`);
    expect(Object.keys(columns())).not.toContain('xero_status');

    run();

    expect(columns()).toMatchObject(XERO_COLUMNS);
    const row = db.prepare('SELECT xero_status, xero_amount_due, xero_amount_paid, xero_paid_on, xero_synced_at FROM invoices WHERE id = ?').get('old');
    expect(Object.values(row)).toEqual([null, null, null, null, null]);
  });

  test('the last-read table exists, and running again changes nothing', () => {
    run();
    run();
    const cols = db.prepare('PRAGMA table_info(xero_status_sync)').all().map(c => c.name);
    expect(cols).toEqual(['user_id', 'tenant_id', 'last_success_at']);
    expect(columns()).toMatchObject(XERO_COLUMNS);
  });
});
