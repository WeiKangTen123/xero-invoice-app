// One-time migration: rebuilds the `invoices` table to match the current
// schema.sql shape — total_amount/tax_amount/sub_total switch from REAL dollars to
// INTEGER cents, and the line_items JSON blob column is dropped in favour of the
// new invoice_line_items child table. SQLite has no ALTER COLUMN, so this follows
// the standard rebuild recipe: create invoices_new -> copy+convert -> drop old ->
// rename. Safe to re-run — skipped once total_amount is already INTEGER-affinity
// and the line_items column is gone.
//
// Stop the app server first — an open connection with cached prepared statements
// against the old shape will start erroring once this runs. Back up the DB first
// too (npm run backup); this rewrites every row in `invoices`.
//
// Usage: node db/migrate-invoices-v2.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
require('./migrate').run(); // ensure invoice_line_items + the rest of schema.sql exist
const db = require('./index');

function _alreadyMigrated() {
  const cols = db.prepare('PRAGMA table_info(invoices)').all();
  const totalAmount = cols.find(c => c.name === 'total_amount');
  const hasLineItemsColumn = cols.some(c => c.name === 'line_items');
  return !!totalAmount && totalAmount.type === 'INTEGER' && !hasLineItemsColumn;
}

// A prior bug could in theory have left two invoices with the same (user_id,
// xero_invoice_id) — that would make the new partial unique index un-creatable.
// Detect it up front and skip just that index (with a loud warning) rather than
// aborting the whole migration over a pre-existing data issue.
function _hasDuplicateXeroInvoiceIds() {
  const dupes = db.prepare(`
    SELECT user_id, xero_invoice_id, COUNT(*) AS n
    FROM invoices
    WHERE xero_invoice_id IS NOT NULL
    GROUP BY user_id, xero_invoice_id
    HAVING n > 1
  `).all();
  if (dupes.length) {
    console.warn(`Found ${dupes.length} duplicate (user_id, xero_invoice_id) pair(s) — skipping the new unique index:`, dupes);
  }
  return dupes.length > 0;
}

function run() {
  if (_alreadyMigrated()) {
    console.log('invoices table already on the new schema — nothing to do.');
    return;
  }

  const oldCols       = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  const hasLineItems  = oldCols.includes('line_items');
  const skipUniqueIdx = _hasDuplicateXeroInvoiceIds();

  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    // 1. Backfill invoice_line_items from the old JSON blob before the column disappears.
    if (hasLineItems) {
      const rows   = db.prepare('SELECT id, line_items FROM invoices').all();
      const insert = db.prepare(`
        INSERT INTO invoice_line_items (invoice_id, sort_order, description, unit_amount, discount_rate)
        VALUES (?, ?, ?, ?, ?)
      `);
      let itemCount = 0;
      for (const row of rows) {
        let items = [];
        try { items = row.line_items ? JSON.parse(row.line_items) : []; } catch { items = []; }
        items.forEach((item, i) => {
          const cents = Math.round((Number(item.unitAmount) || 0) * 100);
          insert.run(row.id, i, item.description ?? null, cents, item.discountRate ?? null);
          itemCount++;
        });
      }
      console.log(`Backfilled ${itemCount} line item(s) across ${rows.length} invoice(s).`);
    }

    // 2. Rebuild invoices: new table (current schema.sql shape) + converted data.
    //    duplicate_of self-references invoices_new — SQLite rewrites this to `invoices`
    //    automatically when the table is renamed below.
    db.exec(`
      CREATE TABLE invoices_new (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status            TEXT NOT NULL CHECK (status IN (
                             'pending', 'submitting', 'posted', 'error',
                             'duplicate', 'reported', 'review-needed', 'reviewed'
                           )),
        has_pdf           INTEGER NOT NULL DEFAULT 0,
        pdf_filename      TEXT,
        vendor_name       TEXT,
        contact_name      TEXT,
        contact_email     TEXT,
        contact_address   TEXT,
        invoice_number    TEXT,
        invoice_date      TEXT,
        due_date          TEXT,
        total_amount      INTEGER DEFAULT 0,
        currency          TEXT,
        invoice_type      TEXT,
        source            TEXT,
        source_email      TEXT,
        description       TEXT,
        account_code      TEXT,
        tax_amount        INTEGER DEFAULT 0,
        sub_total         INTEGER DEFAULT 0,
        payment_reference TEXT,
        xero_invoice_id   TEXT,
        error_msg         TEXT,
        duplicate_of      TEXT REFERENCES invoices_new(id) ON DELETE SET NULL,
        resolved_by       TEXT,
        resolved_at       TEXT,
        submitted_at      TEXT,
        processed_at      TEXT NOT NULL,
        updated_at        TEXT
      );
    `);

    const passthroughCols = oldCols.filter(c => !['line_items', 'total_amount', 'tax_amount', 'sub_total'].includes(c));
    db.exec(`
      INSERT INTO invoices_new (${passthroughCols.join(', ')}, total_amount, tax_amount, sub_total)
      SELECT ${passthroughCols.join(', ')},
             CAST(ROUND(COALESCE(total_amount, 0) * 100) AS INTEGER),
             CAST(ROUND(COALESCE(tax_amount, 0) * 100) AS INTEGER),
             CAST(ROUND(COALESCE(sub_total, 0) * 100) AS INTEGER)
      FROM invoices
    `);

    db.exec('DROP TABLE invoices');
    db.exec('ALTER TABLE invoices_new RENAME TO invoices');

    // Recreate indexes — dropped along with the old table, not carried by the rename.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices(user_id, status);
    `);
    if (!skipUniqueIdx) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_user_xero_invoice
          ON invoices(user_id, xero_invoice_id) WHERE xero_invoice_id IS NOT NULL;
      `);
    }
  });

  migrate();
  db.pragma('foreign_keys = ON');

  const problems = db.pragma('foreign_key_check');
  if (problems.length) {
    console.error('foreign_key_check found problems after migration (see above) — investigate before trusting this DB:', problems);
    process.exitCode = 1;
    return;
  }

  const invoiceCount   = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  const lineItemCount  = db.prepare('SELECT COUNT(*) AS n FROM invoice_line_items').get().n;
  console.log(`Migration complete: ${invoiceCount} invoice(s), ${lineItemCount} line item(s). Restart the app server now.`);
}

if (require.main === module) run();

module.exports = { run };
