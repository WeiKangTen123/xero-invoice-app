const db = require('../db');

// Off by default — see db/migrate-autoprocess-default.js. Posting to someone's
// books is not something an account should inherit without asking.
//
// defaultTenantId is the Xero company a new document goes to when more than
// one is connected (queue/processor.js). Null until someone picks one.
const DEFAULTS = { autoProcess: false, defaultTenantId: null };

function _toRow(userId) {
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 0)').run(userId);
  const row = db.prepare('SELECT auto_process, default_tenant_id FROM user_settings WHERE user_id = ?').get(userId);
  return { ...DEFAULTS, autoProcess: !!row.auto_process, defaultTenantId: row.default_tenant_id || null };
}

function forUser(userId) {
  function read() { return _toRow(userId); }

  function get(key) { const s = read(); return key ? s[key] : s; }

  function set(patch) {
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 0)').run(userId);
    if ('autoProcess' in patch) {
      db.prepare('UPDATE user_settings SET auto_process = ? WHERE user_id = ?')
        .run(patch.autoProcess ? 1 : 0, userId);
    }
    // Whether the id is a company this account actually has connected is the
    // route's question (routes/process.js); here an empty value clears it.
    if ('defaultTenantId' in patch) {
      db.prepare('UPDATE user_settings SET default_tenant_id = ? WHERE user_id = ?')
        .run(patch.defaultTenantId ? String(patch.defaultTenantId) : null, userId);
    }
    return read();
  }

  return { get, set };
}

module.exports = { forUser };
