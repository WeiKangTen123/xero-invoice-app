const bcrypt = require('bcryptjs');
const db     = require('../db');
const { encrypt, decrypt } = require('./crypto');
const { resolveImapSettings } = require('../email/imap-settings');

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
  DEFAULT_ACCOUNT_CODE:  'default_account_code',
  DEFAULT_CURRENCY:      'default_currency',
  ZERO_TAX_RATE:         'zero_tax_rate',
  XERO_CONNECTION_TYPE:     'xero_connection_type',
  XERO_OAUTH_CLIENT_ID:     'xero_oauth_client_id',
  XERO_OAUTH_CLIENT_SECRET: 'xero_oauth_client_secret',
  XERO_OAUTH_REFRESH_TOKEN: 'xero_oauth_refresh_token',
  XERO_OAUTH_CONNECTED_AT:  'xero_oauth_connected_at',
  TIMEZONE:                 'timezone',
  // Who an expense claim is owed to in Xero: the claimant, not the shop.
  CLAIM_PAYEE_NAME:         'claim_payee_name',
  // Claims with no receipt: the rate per km and per day, and the account each
  // is coded to (Setup -> Mileage and allowances).
  MILEAGE_RATE:             'mileage_rate',
  MILEAGE_ACCOUNT_CODE:     'mileage_account_code',
  PER_DIEM_RATE:            'per_diem_rate',
  PER_DIEM_ACCOUNT_CODE:    'per_diem_account_code',
};

// IANA timezone used to FORMAT timestamps for display when a user hasn't picked
// one yet — every timestamp is still stored/compared in UTC everywhere. Chosen as
// the default because that's where this deployment's users are.
const DEFAULT_TIMEZONE = 'Asia/Singapore';

// Setup takes the timezone as free text, and every report dates itself in it
// through Intl, which throws on a name it does not know. So a value is
// checked the way it will be used — by asking Intl — before it is kept, and
// a stored one that would not pass is read as unknown by the callers (see
// routes/xero-reports tz and xero/periods _todayPartsInTz) rather than
// thrown on. Blank means "the default" and is fine. Returns what is wrong
// with it, or null.
const TIMEZONE_PROBLEM = 'Not a known timezone (e.g. Asia/Singapore)';
function isKnownTimezone(timeZone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}
function timezoneProblem(value) {
  const tz = String(value ?? '').trim();
  return !tz || isKnownTimezone(tz) ? null : TIMEZONE_PROBLEM;
}

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

// ── Defaults ──────────────────────────────────────────────────────────────────
// Where a document's currency and account come from when the document itself
// does not say: the user's Setup values, then the environment, then one
// literal per kind. These fallbacks used to be spelled in six files with five
// different values ('SGD'/'USD', '429'/'200'/'310'), so a user with nothing
// configured got SGD claims and USD bills.
const LITERAL_DEFAULTS = {
  currency:    'SGD',
  accountCode: { claim: '429', bill: '310', invoice: '200' },   // Xero's default SG chart
  zeroTaxRate: 'NONE',
};

function defaultsFrom(config = {}) {
  const account = config.DEFAULT_ACCOUNT_CODE || process.env.DEFAULT_ACCOUNT_CODE || null;
  return {
    currency:    config.DEFAULT_CURRENCY || process.env.DEFAULT_CURRENCY || LITERAL_DEFAULTS.currency,
    // One configured code applies to every kind — Setup offers a single default.
    accountCode: account
      ? { claim: account, bill: account, invoice: account }
      : { ...LITERAL_DEFAULTS.accountCode },
    zeroTaxRate: config.ZERO_TAX_RATE || process.env.ZERO_TAX_RATE || LITERAL_DEFAULTS.zeroTaxRate,
    timezone:    config.TIMEZONE || DEFAULT_TIMEZONE,
  };
}

function getUserDefaults(userId) {
  return defaultsFrom(userId ? getUserConfig(userId) : {});
}

// ── Mileage and per diem ──────────────────────────────────────────────────────
// A claim with no receipt is priced from a rate the user sets once. A rate is
// money per unit, so it must be positive; the ceiling catches a slipped digit
// (60 a km is a typo for 0.60, not a policy) rather than expressing one; and
// the precision is what the amount is worked out at. Per km goes to four
// places because real rates do (0.585); per day is money, so to the cent.
const ALLOWANCE_RATES = {
  MILEAGE_RATE:  { kind: 'mileage',  label: 'Mileage rate per km', decimals: 4, max: 100 },
  PER_DIEM_RATE: { kind: 'per_diem', label: 'Per diem daily rate', decimals: 2, max: 10000 },
};
const ALLOWANCE_ACCOUNTS = {
  MILEAGE_ACCOUNT_CODE:  { label: 'Mileage account' },
  PER_DIEM_ACCOUNT_CODE: { label: 'Per diem account' },
};

// At least two places, up to four: 0.6 reads as 0.60, 0.585 keeps its third
// place. The same form on the Setup page, in a claim's line text and on the
// review page, so a rate looks the same wherever it is quoted.
function formatRate(n) {
  return Number(n).toFixed(4).replace(/0{1,2}$/, '');
}

// The allowance settings in a Setup patch, checked. Returns { values, errors }:
// `values` is the patch with each allowance setting normalised ('' clears it,
// a rate is stored in formatRate's form), `errors` one { field, error } per
// value refused. Other keys pass through untouched. Nothing is saved when
// anything is refused, so a half-valid form never half-applies.
function checkAllowanceSettings(patch = {}) {
  const values = { ...patch };
  const errors = [];
  for (const [key, rule] of Object.entries(ALLOWANCE_RATES)) {
    if (patch[key] === undefined || patch[key] === null) continue;
    const raw = String(patch[key]).trim();
    if (raw === '') { values[key] = ''; continue; }
    const n = Number(raw);
    if (!/^(\d+(\.\d+)?|\.\d+)$/.test(raw) || !(n > 0) || (raw.split('.')[1] || '').length > rule.decimals) {
      errors.push({ field: key, error: `${rule.label} must be a positive number with at most ${rule.decimals} decimal places, or blank to turn it off` });
    } else if (n > rule.max) {
      errors.push({ field: key, error: `${rule.label} must be at most ${rule.max.toLocaleString('en-US')}` });
    } else {
      values[key] = formatRate(n);
    }
  }
  for (const [key, rule] of Object.entries(ALLOWANCE_ACCOUNTS)) {
    if (patch[key] === undefined || patch[key] === null) continue;
    const raw = String(patch[key]).trim();
    if (raw === '') { values[key] = ''; continue; }
    // Xero's own limit: an account code is up to ten letters and digits.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/.test(raw)) {
      errors.push({ field: key, error: `${rule.label} must be a Xero account code (up to 10 letters and digits), or blank for your claim account` });
    } else {
      values[key] = raw;
    }
  }
  return { values, errors };
}

// What a new mileage or per diem claim is priced and coded with, keyed by the
// claim kind. A null rate means that kind is off. A stored value that would
// not pass the Setup check now (written before the check, or by hand) also
// reads as off, rather than pricing a claim from it. The account falls back to
// the claim account, the way every default here falls back.
function allowanceSettingsFrom(config = {}) {
  const defaults = defaultsFrom(config);
  const out = { currency: defaults.currency };
  for (const [key, rule] of Object.entries(ALLOWANCE_RATES)) {
    const raw = config[key];
    const { errors } = checkAllowanceSettings({ [key]: raw });
    const usable = raw != null && String(raw).trim() !== '' && !errors.length;
    const accountKey = key.replace('_RATE', '_ACCOUNT_CODE');
    out[rule.kind] = {
      rate:        usable ? Number(raw) : null,
      accountCode: config[accountKey] || defaults.accountCode.claim,
    };
  }
  return out;
}

function getAllowanceSettings(userId) {
  return allowanceSettingsFrom(userId ? getUserConfig(userId) : {});
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
      // Timestamp alone is not unique: two registrations inside the same
      // millisecond produce the same id and the INSERT fails on the primary key.
      // Keeping the timestamp prefix preserves creation order; the suffix makes
      // a collision effectively impossible.
      id:        `${Date.now()}${require('crypto').randomBytes(4).toString('hex')}`,
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
    // Auto-submit OFF for a new account. This line previously hardcoded 1, which
    // silently overrode the column default and opted every new user into posting
    // invoices to a live accounting system before they had configured anything.
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 0)').run(user.id);

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

// Every place that accepts a password checks this — register, the admin's Add
// User and Reset password, and Change password. The Add User form said six
// while the server refused under eight.
const PASSWORD_MIN_LENGTH = 8;

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  return null;
}

// The stored hash when `password` matches it, else null. Change password
// passes it back to setPassword as the hash it expects to replace.
async function verifiedPasswordHash(id, password) {
  const user = findById(id);
  if (!user || typeof password !== 'string') return null;
  return (await bcrypt.compare(password, user.password)) ? user.password : null;
}

// Sets a new password and signs the user out everywhere. Tokens are stateless,
// live 24 hours and renew while in use (auth-middleware.js), so without the
// cutoff a reset would leave an active old session valid indefinitely — the
// opposite of what a reset is for.
//
// `ifCurrentHash` makes the write conditional on the password still being the
// one just verified. Changing your own password checks the current one and
// then hashes the new one, and an admin's reset can land in between; written
// unconditionally, the user's change silently replaced the password the admin
// had just set. Returns false when that happened and nothing was written. An
// admin's reset passes no hash and always writes.
async function setPassword(id, newPassword, { ifCurrentHash = null } = {}) {
  const problem = passwordProblem(newPassword);
  if (problem) throw new Error(problem);
  if (!findById(id)) throw new Error('User not found');
  const hash = await bcrypt.hash(newPassword, 10);
  const at   = new Date().toISOString();
  if (ifCurrentHash) {
    const { changes } = db.prepare('UPDATE users SET password = ?, sessions_valid_from = ? WHERE id = ? AND password = ?')
      .run(hash, at, id, ifCurrentHash);
    return changes > 0;
  }
  db.prepare('UPDATE users SET password = ?, sessions_valid_from = ? WHERE id = ?').run(hash, at, id);
  return true;
}

// Every token issued before now is refused from here on (auth-middleware.js).
function invalidateSessions(id) {
  const at = new Date().toISOString();
  db.prepare('UPDATE users SET sessions_valid_from = ? WHERE id = ?').run(at, id);
  return at;
}

// A disabled account cannot sign in and its existing tokens are refused; the
// rows and files stay, so this is the reversible alternative to deleting.
function setDisabled(id, disabled) {
  const user = findById(id);
  if (!user) throw new Error('User not found');
  const at = disabled ? new Date().toISOString() : null;
  db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(at, id);
  if (disabled) invalidateSessions(id);
  return sanitize({ ...user, disabled_at: at });
}

// Whether anything may still be done for this account in the background: it
// exists and is not disabled. Disabling once only refused sign-in, while the
// mail and job workers, boot recovery and phone-capture links carried on for
// the account — queued mail still posted to its Xero.
function isActive(id) {
  const user = findById(id);
  return !!user && !user.disabled_at;
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
    disabledAt: u.disabled_at ?? u.disabledAt ?? null,
  };
}

// This user's effective mailbox settings: what they typed, filled in from the
// account where nothing was typed. The one place anything IMAP should read.
function getImapSettings(userId, config = null) {
  const user = findById(userId);
  return resolveImapSettings(config || getUserConfig(userId), user ? user.email : '');
}

// Returns which setup sections are configured for a user, and whether the
// system is ready to start (imap + xero are both required; llm is optional).
function getSetupStatus(userId) {
  const config = getUserConfig(userId);
  // Host, mailbox, port, polling and lookback are worked out from the account
  // unless they were typed in, so an ordinary Gmail or Outlook user only has to
  // supply an app password. See email/imap-settings.js.
  const imap   = getImapSettings(userId, config).ready;
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
    // OFF, not ON: this runs on every boot, so provisioning a missing row must
    // never be the thing that starts posting someone's invoices to Xero.
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 0)').run(u.id);
  }
}

module.exports = {
  hasUsers, findById, findByEmail, createUser, validatePassword,
  passwordProblem, verifiedPasswordHash, setPassword, invalidateSessions, setDisabled, isActive, PASSWORD_MIN_LENGTH,
  getAllUsers, updateUserRole, deleteUser, readUsers,
  getUserConfig, saveUserConfig, getUserDefaults, defaultsFrom, getSetupStatus, getImapSettings, ensureUserDirectories,
  checkAllowanceSettings, allowanceSettingsFrom, getAllowanceSettings, formatRate,
  getGeminiKeys, addGeminiKey, removeGeminiKey,
  touchLastSeen, isOnline, DEFAULT_TIMEZONE, isKnownTimezone, timezoneProblem,
  CONFIG_KEY_TO_COLUMN, ENCRYPTED_COLUMNS, // exposed for the one-time JSON->SQLite importer
};
