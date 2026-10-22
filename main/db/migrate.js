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

// schema.sql in two: everything before its guards section, run as it is on
// every boot, and the guards by name (the "-- guard: <name>" lines), which
// _ensureGuards applies only once the rows already there pass them.
function _readSchema() {
  const parts  = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8').split(/^-- guard: (\S+)[^\n]*\n/m);
  const guards = {};
  for (let i = 1; i < parts.length; i += 2) guards[parts[i]] = parts[i + 1];
  return { base: parts[0], guards };
}

// Every stored address in the one form users.js#normalizeEmail gives it.
// Accounts that would end up with the same address are left as they are —
// which of them is the person's is not for a migration to guess — and
// returned, as groups of ids, for the caller to report.
function _normaliseEmails() {
  const { normalizeEmail } = require('../utils/users');
  const byAddress = new Map();
  for (const row of db.prepare('SELECT id, email FROM users').all()) {
    const address = normalizeEmail(String(row.email));
    if (!byAddress.has(address)) byAddress.set(address, []);
    byAddress.get(address).push(row);
  }
  const update = db.prepare('UPDATE users SET email = ? WHERE id = ?');
  const collisions = [];
  for (const [address, rows] of byAddress) {
    if (rows.length > 1) collisions.push(rows.map(r => r.id));
    else if (rows[0].email !== address) update.run(address, rows[0].id);
  }
  return collisions;
}

// What stops a guard holding for the rows already there — what is wrong and
// the ids of the accounts in the way — or null. A guard with no check here is
// simply created.
function _badRoleRows() {
  const ids = db.prepare("SELECT id FROM users WHERE role IS NULL OR role NOT IN ('admin', 'user') OR is_demo IS NULL OR is_demo NOT IN (0, 1)").all().map(r => r.id);
  return ids.length ? { problem: "accounts whose role is not 'admin' or 'user', or whose is_demo is not 0 or 1", ids } : null;
}
const GUARD_CHECKS = {
  // Normalises first, so an account left out by an earlier collision is put
  // in the one form once the collision is gone.
  idx_users_email_nocase: () => {
    const ids = _normaliseEmails();
    return ids.length ? { problem: 'two or more accounts have the same address once it is trimmed and lower-cased', ids } : null;
  },
  users_role_insert: _badRoleRows,
  users_role_update: _badRoleRows,
};

// The guards on users (the end of schema.sql), each created once the rows
// pass its check. One the rows would break is left out, with an error and a
// Slack alert naming the accounts, and tried again on the next boot: the
// server still starts, since the running code does not depend on a guard, and
// the accounts are for a person to put right. A guard already there costs one
// lookup.
function _ensureGuards(guards) {
  const reported = new Set();
  for (const [name, sql] of Object.entries(guards)) {
    if (db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name)) continue;
    let blocked = null;
    try {
      db.transaction(() => {
        blocked = GUARD_CHECKS[name] ? GUARD_CHECKS[name]() : null;
        if (!blocked) db.exec(sql);
      })();
    } catch (err) {
      blocked = { problem: err.message, ids: [] };
    }
    if (!blocked || reported.has(blocked.problem)) continue;
    reported.add(blocked.problem);
    const msg = `users guard ${name} was not created: ${blocked.problem}; it will be tried again on the next boot`;
    require('../utils/logger').error(msg, { ids: blocked.ids });
    try {
      require('../utils/notify').notifyError({ context: msg, error: `accounts: ${JSON.stringify(blocked.ids)}` }).catch(() => {});
    } catch {}
  }
}

// Idempotent — CREATE TABLE/INDEX IF NOT EXISTS, safe to run on every boot.
// Columns added to an already-deployed table are ensured unconditionally
// (cheap, and a database restored from an old backup gets them too).
function run() {
  const { base, guards } = _readSchema();
  db.exec(base);

  _ensureColumn('user_credentials', 'imap_lookback_days', 'imap_lookback_days TEXT');
  _ensureColumn('user_credentials', 'xero_connection_type',     'xero_connection_type TEXT');
  _ensureColumn('user_credentials', 'xero_oauth_client_id',     'xero_oauth_client_id TEXT');
  _ensureColumn('user_credentials', 'xero_oauth_client_secret', 'xero_oauth_client_secret TEXT');
  _ensureColumn('user_credentials', 'xero_oauth_refresh_token', 'xero_oauth_refresh_token TEXT');
  _ensureColumn('user_credentials', 'xero_oauth_connected_at',  'xero_oauth_connected_at TEXT');
  _ensureColumn('user_credentials', 'timezone', 'timezone TEXT');
  _ensureColumn('user_credentials', 'claim_payee_name', 'claim_payee_name TEXT');
  // Mileage and per diem rates, and the account each is coded to (Setup).
  for (const col of ['mileage_rate', 'mileage_account_code', 'per_diem_rate', 'per_diem_account_code']) {
    _ensureColumn('user_credentials', col, `${col} TEXT`);
  }
  _ensureColumn('users', 'last_seen_at', 'last_seen_at TEXT');
  // Scopes Xero's consent screen refused this app (xero/oauth.js): left out of
  // the next consent link and of the connection status's missing scopes.
  _ensureColumn('xero_connection_health', 'refused_scopes', 'refused_scopes TEXT');
  // Optional scopes the person connected without, and what Xero's authorize
  // page said this app may ask for (xero/oauth.js probeOptionalScopes).
  _ensureColumn('xero_connection_health', 'declined_scopes', 'declined_scopes TEXT');
  _ensureColumn('xero_connection_health', 'scope_probe', 'scope_probe TEXT');
  _ensureColumn('users', 'sessions_valid_from', 'sessions_valid_from TEXT');
  _ensureColumn('users', 'disabled_at', 'disabled_at TEXT');
  // Sign-in lockout, temporary passwords and the last sign-in (schema.sql).
  // The counters default to 0, so an existing account starts with a clean
  // record and no temporary password.
  for (const [col, ddl] of [
    ['failed_logins', 'failed_logins INTEGER NOT NULL DEFAULT 0'], ['locked_until', 'locked_until TEXT'],
    ['lock_count', 'lock_count INTEGER NOT NULL DEFAULT 0'], ['last_locked_at', 'last_locked_at TEXT'],
    ['must_change_password', 'must_change_password INTEGER NOT NULL DEFAULT 0'],
    ['temp_password_expires_at', 'temp_password_expires_at TEXT'], ['last_login_at', 'last_login_at TEXT'],
  ]) _ensureColumn('users', col, ddl);
  // A demo account runs against generated data instead of Xero (schema.sql).
  // Defaults to 0, so every existing account stays a real one.
  _ensureColumn('users', 'is_demo', 'is_demo INTEGER NOT NULL DEFAULT 0');
  // When the password was last set. NULL on every existing account: when its
  // password was set was never kept, and a guess would read as a fact.
  _ensureColumn('users', 'password_changed_at', 'password_changed_at TEXT');
  // The sessions table itself is schema.sql's CREATE TABLE IF NOT EXISTS,
  // which an existing database gets on its next boot like a new one. So is
  // auth_tokens (invite and reset links): a new table with nothing to fill
  // in from older rows needs no numbered step below.
  //
  // 2-step sign-in (utils/mfa.js) and when a session last confirmed it was its
  // owner. NULL on every existing row: 2-step off, and no session confirmed,
  // which is the truth for both.
  for (const col of ['mfa_secret', 'mfa_pending_secret', 'mfa_enabled_at', 'mfa_recovery']) {
    _ensureColumn('users', col, `${col} TEXT`);
  }
  _ensureColumn('users', 'mfa_last_step', 'mfa_last_step INTEGER');
  _ensureColumn('sessions', 'reauth_at', 'reauth_at TEXT');
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

    // 5. Every stored address in the form users.js#normalizeEmail gives it
    //    (trimmed, Unicode NFC, lower case), so a sign-in finds its account
    //    with a plain `email = ?` on the column's index. Accounts that would
    //    end up sharing an address keep theirs; the email guard after the
    //    steps names them, on every boot until they are put right. The guards
    //    themselves (one account per address in any case, the role and demo
    //    triggers) are not a step: they wait on the rows, so they are ensured
    //    after the steps on every boot, the way the columns are.
    [5, 'normalise stored emails', () => { _normaliseEmails(); }],
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
  // A claim with no receipt: mileage or a per diem, its quantity, the rate it
  // was priced at, the unit and what was typed (JSON). NULL on every existing
  // row, which is what a receipt claim, a bill and an invoice all are.
  for (const [col, ddl] of [
    ['claim_kind', 'claim_kind TEXT'], ['claim_quantity', 'claim_quantity REAL'],
    ['claim_rate', 'claim_rate REAL'], ['claim_unit', 'claim_unit TEXT'], ['claim_details', 'claim_details TEXT'],
  ]) _ensureColumn('invoices', col, ddl);
  // Which fields supplier memory filled in on a new bill or invoice, and from
  // which earlier record (JSON). NULL on every existing row: nothing on them
  // was remembered, they were read or typed.
  _ensureColumn('invoices', 'prefilled_from', 'prefilled_from TEXT');
  // Here rather than in schema.sql: the schema runs first, and on a database
  // without the column an index naming it would stop the boot.
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_message_id ON invoices(user_id, message_id)');
  // The duplicate check on a new mileage or per diem claim looks up the same
  // kind on the same day (invoice-store findAllowanceDuplicate).
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_claim_kind ON invoices(user_id, claim_kind, invoice_date)');

  // Last: the triggers name users.is_demo, ensured above, and the email index
  // wants step 5's normalised addresses.
  _ensureGuards(guards);
}

module.exports = { run };
