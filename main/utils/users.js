const bcrypt = require('bcryptjs');
const db     = require('../db');

// Maps config.json-style keys (as used throughout routes/setup.js and xero/connect.js)
// to their user_credentials column names.
const CONFIG_KEY_TO_COLUMN = {
  XERO_CLIENT_ID:        'xero_client_id',
  XERO_CLIENT_SECRET:    'xero_client_secret',
  IMAP_HOST:             'imap_host',
  IMAP_PORT:             'imap_port',
  IMAP_USER:             'imap_user',
  IMAP_PASS:             'imap_pass',
  IMAP_FILTER_FROM:      'imap_filter_from',
  IMAP_POLL_INTERVAL_MS: 'imap_poll_interval_ms',
  Gemini_API_KEY:        'gemini_api_key',
  Nvidia_API_KEY:        'nvidia_api_key',
  OPENROUTER_API_KEY:    'openrouter_api_key',
  OPENROUTER_MODEL:      'openrouter_model',
  DEFAULT_ACCOUNT_CODE:  'default_account_code',
  DEFAULT_CURRENCY:      'default_currency',
  ZERO_TAX_RATE:         'zero_tax_rate',
};
const COLUMN_TO_CONFIG_KEY = Object.fromEntries(
  Object.entries(CONFIG_KEY_TO_COLUMN).map(([k, v]) => [v, k])
);

// ── Per-user config (IMAP, Xero credentials, per-user defaults) ──────────────

function getUserConfig(userId) {
  const row = db.prepare('SELECT * FROM user_credentials WHERE user_id = ?').get(userId);
  if (!row) return {};
  const config = {};
  for (const [column, value] of Object.entries(row)) {
    if (column === 'user_id' || value === null) continue;
    config[COLUMN_TO_CONFIG_KEY[column]] = value;
  }
  return config;
}

function saveUserConfig(userId, patch) {
  db.prepare('INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)').run(userId);

  const sets = [];
  const args = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = CONFIG_KEY_TO_COLUMN[key];
    if (!column) continue;
    if (value === null || value === undefined) continue; // not provided
    sets.push(`${column} = ?`);
    args.push(value === '' ? null : value); // explicit empty string = clear this field
  }
  if (sets.length) {
    db.prepare(`UPDATE user_credentials SET ${sets.join(', ')} WHERE user_id = ?`).run(...args, userId);
  }
  return getUserConfig(userId);
}

// ── User CRUD ─────────────────────────────────────────────────────────────────

function hasUsers() {
  return db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined;
}

function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function findByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email) || null;
}

async function createUser(email, password, role = 'user') {
  const hash = await bcrypt.hash(password, 10);

  const create = db.transaction(() => {
    if (findByEmail(email)) throw new Error('Email already exists');

    // 'auto' = first user becomes admin, all subsequent users become 'user'.
    // Resolved inside the transaction so two simultaneous first registrations
    // cannot both claim admin — SQLite serialises writes, only one can go first.
    const actualRole = role === 'auto' ? (hasUsers() ? 'user' : 'admin') : role;
    const user = {
      id:        `${Date.now()}`,
      email:     email.toLowerCase().trim(),
      password:  hash,
      role:      actualRole,
      createdAt: new Date().toISOString(),
    };

    db.prepare(`
      INSERT INTO users (id, email, password, role, created_at)
      VALUES (@id, @email, @password, @role, @createdAt)
    `).run(user);

    // Pre-create the user's credentials row so every account has one from day one
    // (mirrors the old behaviour of always creating config.json on user creation).
    db.prepare('INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)').run(user.id);
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 1)').run(user.id);

    return sanitize(user);
  });

  return create();
}

async function validatePassword(email, password) {
  const user = findByEmail(email);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password);
  return ok ? sanitize(user) : null;
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(sanitize);
}

function updateUserRole(id, role) {
  const user = findById(id);
  if (!user) throw new Error('User not found');
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return sanitize({ ...user, role });
}

function deleteUser(id) {
  // ON DELETE CASCADE removes user_credentials/user_settings/invoices/invoice_reports/
  // xero_tenants rows automatically. PDFs on disk are not touched here — callers that
  // need the data directory removed (routes/admin.js) do that separately via fs.
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function readUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all();
}

function sanitize(u) {
  return { id: u.id, email: u.email, role: u.role, createdAt: u.created_at || u.createdAt };
}

// Returns which setup sections are configured for a user, and whether the
// system is ready to start (imap + xero are both required; llm is optional).
function getSetupStatus(userId) {
  const config = getUserConfig(userId);
  const imap   = !!(config.IMAP_HOST && config.IMAP_USER && config.IMAP_PASS);
  const xero   = !!(config.XERO_CLIENT_ID && config.XERO_CLIENT_SECRET);
  const llm    = !!(config.Gemini_API_KEY || config.Nvidia_API_KEY || config.OPENROUTER_API_KEY);

  const missingConfig = [];
  if (!imap) missingConfig.push('imap');
  if (!xero) missingConfig.push('xero');
  if (!llm)  missingConfig.push('llm');

  return {
    imap:          { configured: imap },
    xero:          { configured: xero },
    llm:           { configured: llm },
    ready:         imap && xero,
    missingConfig,
  };
}

// Ensures every account has a user_credentials/user_settings row. Safe to call on
// every startup — INSERT OR IGNORE never overwrites existing rows. Guards against
// users created before this provisioning logic existed.
function ensureUserDirectories() {
  for (const u of readUsers()) {
    db.prepare('INSERT OR IGNORE INTO user_credentials (user_id) VALUES (?)').run(u.id);
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 1)').run(u.id);
  }
}

module.exports = {
  hasUsers, findById, findByEmail, createUser, validatePassword,
  getAllUsers, updateUserRole, deleteUser, readUsers,
  getUserConfig, saveUserConfig, getSetupStatus, ensureUserDirectories,
  CONFIG_KEY_TO_COLUMN, // exposed for the one-time JSON->SQLite importer
};
