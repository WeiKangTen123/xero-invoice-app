// One-time importer: reads the old JSON/file-based storage under main/data/ and
// inserts it into the new SQLite tables. Safe to re-run — existing rows (matched
// by id) are left untouched, never overwritten.
//
// Usage: node db/migrate-from-json.js

const fs   = require('fs');
const path = require('path');

require('./migrate').run(); // ensure schema exists first
const db = require('./index');
const { CONFIG_KEY_TO_COLUMN, ENCRYPTED_COLUMNS } = require('../utils/users');
const { encrypt } = require('../utils/crypto');
const { FIELD_TO_COLUMN, _toBindable } = require('../utils/invoice-store');

const DATA_DIR  = path.join(__dirname, '../data');
const USERS_JSON = path.join(DATA_DIR, 'users.json');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`Skipping unreadable file ${file}: ${err.message}`);
    return fallback;
  }
}

function importUsers() {
  const users = readJson(USERS_JSON, []);
  let imported = 0;
  for (const u of users) {
    const info = db.prepare(`
      INSERT OR IGNORE INTO users (id, email, password, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(u.id, u.email, u.password, u.role || 'user', u.createdAt || new Date().toISOString());
    if (info.changes > 0) imported++;
  }
  console.log(`users: ${imported} imported, ${users.length - imported} already present`);
  return users;
}

function importCredentials(userId) {
  const config = readJson(path.join(DATA_DIR, 'users', userId, 'config.json'), {});
  const keys   = Object.keys(config).filter(k => CONFIG_KEY_TO_COLUMN[k] && config[k]);
  if (!keys.length) return;

  db.prepare('INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)').run(userId);
  const sets = keys.map(k => `${CONFIG_KEY_TO_COLUMN[k]} = ?`).join(', ');
  const args = keys.map(k => {
    const column = CONFIG_KEY_TO_COLUMN[k];
    return ENCRYPTED_COLUMNS.has(column) ? encrypt(config[k]) : config[k];
  });
  db.prepare(`UPDATE user_credentials SET ${sets} WHERE user_id = ?`).run(...args, userId);
}

function importSettings(userId) {
  const settings = readJson(path.join(DATA_DIR, 'users', userId, 'settings.json'), null);
  // Seeded OFF; the UPDATE below applies whatever the JSON actually said. A
  // file with no autoProcess key must not inherit auto-submit.
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 0)').run(userId);
  if (settings && 'autoProcess' in settings) {
    db.prepare('UPDATE user_settings SET auto_process = ? WHERE user_id = ?')
      .run(settings.autoProcess ? 1 : 0, userId);
  }
}

function importInvoices(userId) {
  const invoices = readJson(path.join(DATA_DIR, 'users', userId, 'invoices.json'), []);
  let imported = 0;

  for (const inv of invoices) {
    const existing = db.prepare('SELECT 1 FROM invoices WHERE id = ?').get(inv.id);
    if (existing) continue;

    const cols = ['id', 'user_id'];
    const vals = [inv.id, userId];
    for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
      if (field === 'id' || field === 'userId' || !(field in inv)) continue;
      cols.push(column);
      vals.push(_toBindable(field, inv[field]));
    }
    if (!cols.includes('processed_at')) { cols.push('processed_at'); vals.push(new Date().toISOString()); }

    db.prepare(`INSERT INTO invoices (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
    imported++;

    for (const r of inv.reports || []) {
      db.prepare(`
        INSERT INTO invoice_reports (invoice_id, user_email, note, reported_at)
        VALUES (?, ?, ?, ?)
      `).run(inv.id, r.userEmail, r.note, r.reportedAt || new Date().toISOString());
    }

    // lineItems isn't in FIELD_TO_COLUMN (it's a child table, not a column — see
    // invoice-store.js), so it needs its own insert here, same as invoice_reports above.
    (inv.lineItems || []).forEach((item, i) => {
      db.prepare(`
        INSERT INTO invoice_line_items (invoice_id, sort_order, description, unit_amount, discount_rate)
        VALUES (?, ?, ?, ?, ?)
      `).run(inv.id, i, item.description ?? null, Math.round((Number(item.unitAmount) || 0) * 100), item.discountRate ?? null);
    });
  }
  console.log(`  invoices for user ${userId}: ${imported} imported, ${invoices.length - imported} already present`);
}

function run() {
  const users = importUsers();
  for (const u of users) {
    importCredentials(u.id);
    importSettings(u.id);
    importInvoices(u.id);
  }
  console.log('JSON -> SQLite import complete.');
}

if (require.main === module) run();

module.exports = { run };
