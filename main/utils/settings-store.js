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

  // Whether this account wants its mailbox watched. Kept apart from get() and
  // set(): it is not a preference edited on the settings page but the
  // Start/Stop state, written by routes/process.js and email/watcher-registry.js
  // and read at boot so a restart puts every mailbox back the way its owner
  // left it.
  function watcherEnabled() {
    const row = db.prepare('SELECT watcher_enabled FROM user_settings WHERE user_id = ?').get(userId);
    return !!(row && row.watcher_enabled);
  }

  function setWatcherEnabled(on) {
    // Clearing never inserts: a stop for an account being deleted must not
    // recreate its row.
    if (on) db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 0)').run(userId);
    db.prepare('UPDATE user_settings SET watcher_enabled = ? WHERE user_id = ?').run(on ? 1 : 0, userId);
  }

  return { get, set, watcherEnabled, setWatcherEnabled };
}

// Every account whose owner left the mailbox watcher switched on, oldest row
// first so a resume at boot goes in a stable order.
function watcherEnabledUserIds() {
  return db.prepare('SELECT user_id FROM user_settings WHERE watcher_enabled = 1 ORDER BY rowid').all().map(r => r.user_id);
}

module.exports = { forUser, watcherEnabledUserIds };
