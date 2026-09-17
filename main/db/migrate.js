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

// One-off steps run once. PRAGMA user_version records the last step applied;
// a step whose number is at or below it is skipped. Before this the backfill,
// the settings-table rebuild and the column drop re-ran on every boot, and
// nothing said what state a database was in.
function _step(n, name, fn) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= n) return;
  try {
    fn();
    db.pragma(`user_version = ${n}`);
  } catch (err) {
    // A failed step must not stop the server booting; it is logged and tried
    // again next boot, since the version was not advanced.
    require('../utils/logger').warn(`migration step ${n} (${name}) skipped`, { error: err.message });
  }
}

// Idempotent — CREATE TABLE/INDEX IF NOT EXISTS, safe to run on every boot.
// Columns added to an already-deployed table are ensured unconditionally
// (cheap, and a database restored from an old backup gets them too).
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
  for (const [col, ddl] of [
    ['receipt_file', 'receipt_file TEXT'], ['receipt_mime', 'receipt_mime TEXT'], ['receipt_box', 'receipt_box TEXT'],
    ['receipt_page', 'receipt_page INTEGER'], ['receipt_group', 'receipt_group TEXT'], ['received_at', 'received_at TEXT'],
    ['receipt_hash', 'receipt_hash TEXT'], ['vendor_phone', 'vendor_phone TEXT'], ['project_name', 'project_name TEXT'],
    ['parsed_at', 'parsed_at TEXT'],
  ]) _ensureColumn('invoices', col, ddl);

  // 1. SHA-256 of every stored receipt that predates the hash column.
  _step(1, 'receipt_hash backfill', () => {
    const unhashed = db.prepare("SELECT id, user_id, receipt_file FROM invoices WHERE receipt_file IS NOT NULL AND (receipt_hash IS NULL OR receipt_hash = '')").all();
    const crypto = require('crypto');
    const hashStmt = db.prepare('UPDATE invoices SET receipt_hash = ? WHERE id = ?');
    for (const r of unhashed) {
      const p = path.join(require('../utils/paths').userDir(r.user_id), 'receipts', r.receipt_file);
      if (fs.existsSync(p)) hashStmt.run(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), r.id);
    }
  });

  // 2. Rebuilds user_settings so a NEW account starts with auto-submit off.
  //    Value-preserving — see the module for why.
  _step(2, 'auto_process default', () => require('./migrate-autoprocess-default').run());

  // 3. Credentials written before at-rest encryption existed are encrypted
  //    in place. encrypt() output is left alone by isEncrypted(), so nothing
  //    is double-encrypted. (This was a standalone script nobody ran.)
  _step(3, 'encrypt plaintext credentials', () => {
    const { encrypt, isEncrypted } = require('../utils/crypto');
    const { ENCRYPTED_COLUMNS }    = require('../utils/users');
    const cols = [...ENCRYPTED_COLUMNS];
    for (const row of db.prepare(`SELECT user_id, ${cols.join(', ')} FROM user_credentials`).all()) {
      const sets = [], args = [];
      for (const column of cols) {
        const value = row[column];
        if (value == null || value === '' || isEncrypted(value)) continue;
        sets.push(`${column} = ?`); args.push(encrypt(value));
      }
      if (sets.length) db.prepare(`UPDATE user_credentials SET ${sets.join(', ')} WHERE user_id = ?`).run(...args, row.user_id);
    }
  });

  // 4. Nvidia and OpenRouter were removed from the LLM client; their columns
  //    held live keys in plaintext. Dropped, values and all.
  _step(4, 'drop dead provider columns', () => {
    for (const column of ['nvidia_api_key', 'openrouter_api_key', 'openrouter_model']) {
      const cols = db.prepare('PRAGMA table_info(user_credentials)').all().map(c => c.name);
      if (cols.includes(column)) db.exec(`ALTER TABLE user_credentials DROP COLUMN ${column}`);
    }
  });
}

module.exports = { run };
