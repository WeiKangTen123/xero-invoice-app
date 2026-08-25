// Flips the auto_process default from ON to OFF.
//
// Nobody ever enabled auto-submit: the column defaulted to 1, settings-store
// inserted rows with 1, and DEFAULTS said true — so the first time the app read
// settings for a new account, it silently opted that account into posting
// invoices to a live accounting system. Opt-out is the wrong direction for an
// action that writes to someone's books.
//
// Existing rows are left exactly as they are. This changes what a NEW account
// starts with, not what anyone has already chosen.
const db = require('./index');
const logger = require('../utils/logger');

function run() {
  const col = db.prepare('PRAGMA table_info(user_settings)').all().find(c => c.name === 'auto_process');
  if (!col) return { skipped: 'no user_settings.auto_process column' };
  if (String(col.dflt_value) === '0') return { skipped: 'already defaults to 0' };

  // SQLite cannot ALTER a column default, so the table is rebuilt. Values are
  // copied verbatim — a user who deliberately turned auto-submit ON keeps it.
  const migrate = db.transaction(() => {
    db.prepare(`CREATE TABLE user_settings_new (
      user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      auto_process INTEGER NOT NULL DEFAULT 0
    )`).run();
    db.prepare('INSERT INTO user_settings_new (user_id, auto_process) SELECT user_id, auto_process FROM user_settings').run();
    db.prepare('DROP TABLE user_settings').run();
    db.prepare('ALTER TABLE user_settings_new RENAME TO user_settings').run();
  });
  const before = db.prepare('SELECT COUNT(*) c FROM user_settings').get().c;
  migrate();
  const after = db.prepare('SELECT COUNT(*) c FROM user_settings').get().c;
  if (before !== after) throw new Error(`row count changed during migration: ${before} -> ${after}`);
  logger.info('Migrated user_settings.auto_process default to 0', { rows: after });
  return { migrated: true, rows: after };
}

module.exports = { run };
if (require.main === module) { console.log(JSON.stringify(run())); process.exit(0); }
