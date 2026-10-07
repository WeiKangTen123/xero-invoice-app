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
//
// Each step runs in one transaction with its version bump, so a step either
// happened and is recorded, or did not happen at all. Before, a step that
// threw part-way left whatever it had written so far in place, unrecorded,
// for the retry to trip over. Returns false when the step failed.
function _step(n, name, fn) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= n) return true;
  try {
    db.transaction(() => {
      fn();
      db.pragma(`user_version = ${n}`);
    })();
    return true;
  } catch (err) {
    // Rolled back and not recorded, so the next boot tries again. The server
    // still boots, deliberately: every step so far is a backfill or a
    // tidy-up the running code does not depend on, and refusing to start
    // over one would take the whole app down for something a person can fix
    // while it runs. It is an error and a Slack alert, though, not a quiet
    // warning — a step that fails on every boot needs someone to look.
    const msg = `migration step ${n} (${name}) failed and was rolled back; it will be retried on the next boot`;
    require('../utils/logger').error(msg, { error: err.message, stack: err.stack });
    try {
      require('../utils/notify').notifyError({ context: msg, error: err.message }).catch(() => {});
    } catch {}
    return false;
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
  _ensureColumn('user_credentials', 'claim_payee_name', 'claim_payee_name TEXT');
  _ensureColumn('users', 'last_seen_at', 'last_seen_at TEXT');
  _ensureColumn('users', 'sessions_valid_from', 'sessions_valid_from TEXT');
  _ensureColumn('users', 'disabled_at', 'disabled_at TEXT');
  for (const [col, ddl] of [
    ['receipt_file', 'receipt_file TEXT'], ['receipt_mime', 'receipt_mime TEXT'], ['receipt_box', 'receipt_box TEXT'],
    ['receipt_page', 'receipt_page INTEGER'], ['receipt_group', 'receipt_group TEXT'], ['received_at', 'received_at TEXT'],
    ['receipt_hash', 'receipt_hash TEXT'], ['vendor_phone', 'vendor_phone TEXT'], ['project_name', 'project_name TEXT'],
    ['parsed_at', 'parsed_at TEXT'], ['xero_tenant_id', 'xero_tenant_id TEXT'],
    ['line_amount_types', 'line_amount_types TEXT'], ['branding_theme_name', 'branding_theme_name TEXT'],
    ['currency_rate', 'currency_rate REAL'], ['post_note', 'post_note TEXT'],
  ]) _ensureColumn('invoices', col, ddl);

  const steps = [
    // 1. SHA-256 of every stored receipt that predates the hash column.
    [1, 'receipt_hash backfill', () => {
      const unhashed = db.prepare("SELECT id, user_id, receipt_file FROM invoices WHERE receipt_file IS NOT NULL AND (receipt_hash IS NULL OR receipt_hash = '')").all();
      const crypto = require('crypto');
      const hashStmt = db.prepare('UPDATE invoices SET receipt_hash = ? WHERE id = ?');
      for (const r of unhashed) {
        const p = path.join(require('../utils/paths').userDir(r.user_id), 'receipts', r.receipt_file);
        if (fs.existsSync(p)) hashStmt.run(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), r.id);
      }
    }],

    // 2. Rebuilds user_settings so a NEW account starts with auto-submit off.
    //    Value-preserving — see the module for why.
    [2, 'auto_process default', () => require('./migrate-autoprocess-default').run()],

    // 3. Credentials written before at-rest encryption existed are encrypted
    //    in place. encrypt() output is left alone by isEncrypted(), so nothing
    //    is double-encrypted. (This was a standalone script nobody ran.)
    [3, 'encrypt plaintext credentials', () => {
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
    }],

    // 4. Nvidia and OpenRouter were removed from the LLM client; their columns
    //    held live keys in plaintext. Dropped, values and all.
    [4, 'drop dead provider columns', () => {
      for (const column of ['nvidia_api_key', 'openrouter_api_key', 'openrouter_model']) {
        const cols = db.prepare('PRAGMA table_info(user_credentials)').all().map(c => c.name);
        if (cols.includes(column)) db.exec(`ALTER TABLE user_credentials DROP COLUMN ${column}`);
      }
    }],
  ];
  // In order, and no further than the first failure: the version is a high-
  // water mark, so if a later step succeeded after an earlier one failed, the
  // version would move past the failed step and it would never run again.
  for (const [n, name, fn] of steps) {
    if (!_step(n, name, fn)) break;
  }

  // After the steps, not with the columns above: step 2 rebuilds user_settings
  // with only the columns it knew about, so on a database old enough to run it
  // a column added beforehand would be dropped again by the rebuild.
  _ensureColumn('user_settings', 'default_tenant_id', 'default_tenant_id TEXT');
  // Whether the account's mailbox watcher should be running, so a restart can
  // bring back the watchers that were on (email/watcher-registry).
  _ensureColumn('user_settings', 'watcher_enabled', 'watcher_enabled INTEGER NOT NULL DEFAULT 0');
  // Revenue accounts the user marked recurring or project (JSON [{label, recurring}]).
  _ensureColumn('user_settings', 'recurring_accounts', 'recurring_accounts TEXT');
  // The email a row came from, so a re-delivered message is recognised before
  // it is read again, and how sure the reader was of what it read.
  _ensureColumn('invoices', 'message_id', 'message_id TEXT');
  _ensureColumn('invoices', 'confidence', 'confidence TEXT');
  // What Xero says about a posted document now: its status, what is still owed
  // and what was paid (cents), the day it was paid in full, and when Xero last
  // confirmed them (xero/status-sync.js). NULL on every existing row: unknown
  // until the first check, which is not the same as a draft.
  for (const [col, ddl] of [
    ['xero_status', 'xero_status TEXT'], ['xero_amount_due', 'xero_amount_due INTEGER'],
    ['xero_amount_paid', 'xero_amount_paid INTEGER'], ['xero_paid_on', 'xero_paid_on TEXT'],
    ['xero_synced_at', 'xero_synced_at TEXT'],
  ]) _ensureColumn('invoices', col, ddl);
  // Here rather than in schema.sql: the schema runs first, and on a database
  // without the column an index naming it would stop the boot.
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_message_id ON invoices(user_id, message_id)');
}

module.exports = { run };
