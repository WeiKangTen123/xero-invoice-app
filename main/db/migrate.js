const fs   = require('fs');
const path = require('path');
const db   = require('./index');

// SQLite has no ADD COLUMN IF NOT EXISTS — schema.sql's CREATE TABLE IF NOT EXISTS
// only takes effect for a table that doesn't exist yet, so a column added to an
// already-deployed table needs an explicit, checked ALTER TABLE here instead.
function _ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// Idempotent — CREATE TABLE/INDEX IF NOT EXISTS, safe to run on every boot.
function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  _ensureColumn('user_credentials', 'imap_lookback_days', 'imap_lookback_days TEXT');
  _ensureColumn('user_credentials', 'xero_connection_type',     'xero_connection_type TEXT');
  _ensureColumn('user_credentials', 'xero_oauth_client_id',     'xero_oauth_client_id TEXT');
  _ensureColumn('user_credentials', 'xero_oauth_client_secret', 'xero_oauth_client_secret TEXT');
  _ensureColumn('user_credentials', 'xero_oauth_refresh_token', 'xero_oauth_refresh_token TEXT');
  _ensureColumn('user_credentials', 'xero_oauth_connected_at',  'xero_oauth_connected_at TEXT');
  _ensureColumn('user_credentials', 'timezone', 'timezone TEXT');
  _ensureColumn('users', 'last_seen_at', 'last_seen_at TEXT');
  // Expense claims: a receipt is an attached FILE the way a bill has a PDF, but
  // it is usually an image and Xero needs the mime type to attach it.
  _ensureColumn('invoices', 'receipt_file', 'receipt_file TEXT');
  _ensureColumn('invoices', 'receipt_mime', 'receipt_mime TEXT');
  // One upload can hold several receipts. Rather than cutting the file apart,
  // every split record points at the SAME stored file and carries the region it
  // owns — a box for a photo, a page for a PDF. The original is never destroyed,
  // so merging back is just deleting rows.
  _ensureColumn('invoices', 'receipt_box',  'receipt_box TEXT');     // JSON [ymin,xmin,ymax,xmax], 0-1000
  _ensureColumn('invoices', 'receipt_page', 'receipt_page INTEGER'); // 1-based page of a multi-page PDF
  _ensureColumn('invoices', 'receipt_group','receipt_group TEXT');   // ties siblings from one upload together

  // Rebuilds user_settings so a NEW account starts with auto-submit off.
  // Idempotent and value-preserving — see the migration for why.
  try {
    require('./migrate-autoprocess-default').run();
  } catch (err) {
    // A failed default flip must not stop the server booting; existing rows are
    // untouched either way.
    require('../utils/logger').warn('auto_process default migration skipped', { error: err.message });
  }
}

module.exports = { run };
