const bcrypt = require('bcryptjs');
const db     = require('../db');
const { encrypt, decrypt } = require('./crypto');

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
  IMAP_LOOKBACK_DAYS:    'imap_lookback_days',
  Gemini_API_KEY:        'gemini_api_key',
  Nvidia_API_KEY:        'nvidia_api_key',
  OPENROUTER_API_KEY:    'openrouter_api_key',
  OPENROUTER_MODEL:      'openrouter_model',
  DEFAULT_ACCOUNT_CODE:  'default_account_code',
  DEFAULT_CURRENCY:      'default_currency',
  ZERO_TAX_RATE:         'zero_tax_rate',
  XERO_CONNECTION_TYPE:     'xero_connection_type',
  XERO_OAUTH_CLIENT_ID:     'xero_oauth_client_id',
  XERO_OAUTH_CLIENT_SECRET: 'xero_oauth_client_secret',
  XERO_OAUTH_REFRESH_TOKEN: 'xero_oauth_refresh_token',
  XERO_OAUTH_CONNECTED_AT:  'xero_oauth_connected_at',
  TIMEZONE:                 'timezone',
};

// IANA timezone used to FORMAT timestamps for display when a user hasn't picked
// one yet — every timestamp is still stored/compared in UTC everywhere. Chosen as
// the default because that's where this deployment's users are.
const DEFAULT_TIMEZONE = 'Asia/Singapore';

// A user counts as "online" if an authenticated request landed inside this window.
// This is real browser presence, not the email pipeline's own activity tracking
// (see process-state.js) — a value long enough that normal polling gaps (the
// dashboard's pipeline-status poll backs off to every 15s when idle) don't flicker
// someone in and out of "online" between requests.
const ONLINE_THRESHOLD_MS = 3 * 60 * 1000;

function isOnline(lastSeenAt) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
}
const COLUMN_TO_CONFIG_KEY = Object.fromEntries(
  Object.entries(CONFIG_KEY_TO_COLUMN).map(([k, v]) => [v, k])
);

// These columns hold real credentials and are encrypted at rest (AES-256-GCM, see
// ./crypto.js) — everything else in user_credentials (client ID, IMAP host/user/
// port, defaults) isn't secret and stays plain for easy querying/debugging.
const ENCRYPTED_COLUMNS = new Set(['xero_client_secret', 'imap_pass', 'gemini_api_key', 'xero_oauth_client_secret', 'xero_oauth_refresh_token']);

// ── Per-user config (IMAP, Xero credentials, per-user defaults) ──────────────

function getUserConfig(userId) {
  const row = db.prepare('SELECT * FROM user_credentials WHERE user_id = ?').get(userId);
  if (!row) return {};
  const config = {};
  for (const [column, value] of Object.entries(row)) {
    if (column === 'user_id' || value === null) continue;
    config[COLUMN_TO_CONFIG_KEY[column]] = ENCRYPTED_COLUMNS.has(column) ? decrypt(value) : value;
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
    if (value === '') {
      args.push(null); // explicit empty string = clear this field
    } else {
      args.push(ENCRYPTED_COLUMNS.has(column) ? encrypt(value) : value);
    }
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

// In-memory throttle so a chatty client (the dashboard's pipeline-status poll can
// fire every few seconds) doesn't turn every request into a DB write — at most one
// UPDATE per user per minute, same throttling philosophy as token-cache.js/
// oauth-state.js's in-memory stores elsewhere in this app.
const _lastTouchWrite = new Map(); // userId -> ms timestamp of last DB write
const TOUCH_THROTTLE_MS = 60 * 1000;

function touchLastSeen(userId) {
  const now = Date.now();
  const last = _lastTouchWrite.get(userId) || 0;
  if (now - last < TOUCH_THROTTLE_MS) return;
  _lastTouchWrite.set(userId, now);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(new Date(now).toISOString(), userId);
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
  const lastSeenAt = u.last_seen_at ?? u.lastSeenAt ?? null;
  return {
    id: u.id, email: u.email, role: u.role, createdAt: u.created_at || u.createdAt,
    lastSeenAt, online: isOnline(lastSeenAt),
  };
}

// Returns which setup sections are configured for a user, and whether the
// system is ready to start (imap + xero are both required; llm is optional).
function getSetupStatus(userId) {
  const config = getUserConfig(userId);
  const imap   = !!(config.IMAP_HOST && config.IMAP_USER && config.IMAP_PASS);
  // Either connection method counts as "configured" — Custom Connection (client ID +
  // secret) or OAuth (connection type flipped to 'oauth' once a user has completed
  // the consent flow; see xero/oauth.js).
  const xero   = !!(config.XERO_CLIENT_ID && config.XERO_CLIENT_SECRET) || config.XERO_CONNECTION_TYPE === 'oauth';
  // Legacy single-field fallback covers an account that hasn't added a key through
  // the multi-key UI yet but still has the old single Gemini_API_KEY column set.
  const llm    = getGeminiKeys(userId).length > 0 || !!config.Gemini_API_KEY;

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

// ── Gemini API keys (1:many — see user_gemini_keys in schema.sql) ────────────
// A user can add more than one key; gemini-client.js rotates through every model
// on a key before moving to the next one, so adding a key is real extra quota
// headroom, not just a spare. Ordered oldest-first so rotation is deterministic.

function getGeminiKeys(userId) {
  const rows = db.prepare('SELECT id, api_key, label, created_at FROM user_gemini_keys WHERE user_id = ? ORDER BY id').all(userId);
  return rows.map(r => ({ id: r.id, apiKey: decrypt(r.api_key), label: r.label, createdAt: r.created_at }));
}

function addGeminiKey(userId, apiKey, label) {
  if (!apiKey || !apiKey.trim()) throw new Error('API key is required');
  const info = db.prepare(`
    INSERT INTO user_gemini_keys (user_id, api_key, label, created_at) VALUES (?, ?, ?, ?)
  `).run(userId, encrypt(apiKey.trim()), label ? label.trim().slice(0, 60) : null, new Date().toISOString());
  return { id: info.lastInsertRowid };
}

function removeGeminiKey(userId, keyId) {
  const info = db.prepare('DELETE FROM user_gemini_keys WHERE id = ? AND user_id = ?').run(keyId, userId);
  return info.changes > 0;
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
  getGeminiKeys, addGeminiKey, removeGeminiKey,
  touchLastSeen, isOnline, DEFAULT_TIMEZONE,
  CONFIG_KEY_TO_COLUMN, ENCRYPTED_COLUMNS, // exposed for the one-time JSON->SQLite importer
};
