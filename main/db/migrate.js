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
}

module.exports = { run };
