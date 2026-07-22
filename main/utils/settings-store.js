const db = require('../db');

const DEFAULTS = { autoProcess: true };

function _toRow(userId) {
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 1)').run(userId);
  const row = db.prepare('SELECT auto_process FROM user_settings WHERE user_id = ?').get(userId);
  return { ...DEFAULTS, autoProcess: !!row.auto_process };
}

function forUser(userId) {
  function read() { return _toRow(userId); }

  function get(key) { const s = read(); return key ? s[key] : s; }

  function set(patch) {
    if ('autoProcess' in patch) {
      db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 1)').run(userId);
      db.prepare('UPDATE user_settings SET auto_process = ? WHERE user_id = ?')
        .run(patch.autoProcess ? 1 : 0, userId);
    }
    return read();
  }

  return { get, set };
}

module.exports = { forUser };
