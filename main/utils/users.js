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

// The password is hashed as given: the rule on what a password may be
// (passwordProblem) is applied by every route before it gets here, so the
// tests can make accounts with short fixture passwords without a bcrypt-cost
// password each. `temporary` marks the password as one an admin chose, to be
// replaced at the first sign-in and dead after a day (schema.sql). `demo`
// makes a demo account: one that never connects to Xero and runs against the
// generated Demo Company instead (users.is_demo; see isDemoUser). An admin
// may later switch their own account either way (setDemo).
async function createUser(email, password, role = 'user', { temporary = false, demo = false } = {}) {
  const hash = await bcrypt.hash(password, 10);

  const create = db.transaction(() => {
    if (findByEmail(email)) throw new Error('Email already exists');

    // 'auto' = first user becomes admin, all subsequent users become 'user'.
    // Resolved inside the transaction so two simultaneous first registrations
    // cannot both claim admin — SQLite serialises writes, only one can go first.
    const actualRole = role === 'auto' ? (hasUsers() ? 'user' : 'admin') : role;
    const now  = Date.now();
    const user = {
      // Timestamp alone is not unique: two registrations inside the same
      // millisecond produce the same id and the INSERT fails on the primary key.
      // Keeping the timestamp prefix preserves creation order; the suffix makes
      // a collision effectively impossible.
      id:        `${now}${require('crypto').randomBytes(4).toString('hex')}`,
      email:     email.toLowerCase().trim(),
      password:  hash,
      role:      actualRole,
      createdAt: new Date(now).toISOString(),
      mustChangePassword:    temporary ? 1 : 0,
      tempPasswordExpiresAt: temporary ? new Date(now + TEMP_PASSWORD_TTL_MS).toISOString() : null,
      isDemo:    demo ? 1 : 0,
      // The account's first password was set when the account was made.
      passwordChangedAt: new Date(now).toISOString(),
    };

    db.prepare(`
      INSERT INTO users (id, email, password, role, created_at, must_change_password, temp_password_expires_at, is_demo, password_changed_at)
      VALUES (@id, @email, @password, @role, @createdAt, @mustChangePassword, @tempPasswordExpiresAt, @isDemo, @passwordChangedAt)
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
//
// Three rules and no more: at least twelve characters, not the account's own
// email address (with or without the domain, in any case), and not on the
// list of passwords everyone tries first (common-passwords.js). Length is
// what makes a password hard to guess; rules about digits and symbols only
// decide which short password is chosen. Nothing expires: a password that
// was good stays good, so existing accounts are not asked to change. `email`
// is the account's, for the second rule; without it that rule is skipped.
const PASSWORD_MIN_LENGTH = 12;

// Every account, demo or not, admin or not. Demo accounts used to be allowed a
// six-character permanent password for typing in front of people; the one
// actually used turned up in this public repository's tests, and a demo
// account holds copied settings (Gemini keys, a mailbox), so the exception
// went. An account still on a password these rules refuse is sent to choose a
// new one at its next sign-in (routes/auth.js, requirePasswordChange).
function passwordProblem(password, email = null) {
  const min = PASSWORD_MIN_LENGTH;
  if (typeof password !== 'string' || password.length < min) {
    return `Password must be at least ${min} characters`;
  }
  if (typeof email === 'string' && email.trim()) {
    const pw   = password.toLowerCase();
    const addr = email.toLowerCase().trim();
    if (pw === addr || pw === addr.split('@')[0]) return 'Password must not be your email address';
  }
  if (require('./common-passwords').isCommonPassword(password)) return 'That password is too common; choose another';
  return null;
}

// ── Sign-in lockout ──────────────────────────────────────────────────────────
// Per account, not per IP (routes/auth.js keeps a looser limit per IP too):
// someone guessing one person's password from many addresses meets this; an
// office behind one address where one person mistypes does not lock the
// others out. Five wrong passwords in a row lock the account; each lock
// inside a day of the last is twice as long, up to a day; a right password
// once the lock has ended clears the slate.
const LOCK_AFTER_FAILURES = 5;
const LOCK_BASE_MS        = 15 * 60 * 1000;
const LOCK_MAX_MS         = 24 * 60 * 60 * 1000;
const LOCK_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;

// A password an admin set is good for this long (createUser, setPassword).
const TEMP_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

// Whether the account refuses sign-in at `now`: { lockedUntil, lockMinutes }
// (the end, and the whole minutes left, at least one) or null. Read from the
// row; nothing is written, so a lock that has ended simply stops mattering
// and the columns say what happened until the next sign-in clears them.
function lockStatus(row, now = Date.now()) {
  if (!row || !row.locked_until) return null;
  const until = Date.parse(row.locked_until);
  if (!(until > now)) return null;
  return { lockedUntil: new Date(until).toISOString(), lockMinutes: Math.max(1, Math.ceil((until - now) / 60000)) };
}

// The rule itself, with no database in it: what the four lockout columns
// become after a wrong password at `now`, given the row as it is. `locked` is
// true when this failure is the one that locked the account, and lockMinutes
// then says for how long.
//
// lock_count is how many locks there have been in the current run — a run
// continues while each lock is within a day of the last, and starts over
// otherwise — and sets the length of the next: 15 minutes doubled that many
// times, never more than a day. The failure count starts again at the lock,
// so after it ends there are five more tries before the next, longer, lock.
function lockAfterFailure(row, now = Date.now()) {
  const failed = (row.failed_logins || 0) + 1;
  if (failed < LOCK_AFTER_FAILURES) {
    return {
      failed_logins: failed, locked_until: row.locked_until ?? null,
      lock_count: row.lock_count || 0, last_locked_at: row.last_locked_at ?? null, locked: false,
    };
  }
  const last   = row.last_locked_at ? Date.parse(row.last_locked_at) : NaN;
  const inRun  = Number.isFinite(last) && now - last < LOCK_COUNT_WINDOW_MS;
  const count  = inRun ? (row.lock_count || 0) : 0;
  const length = Math.min(LOCK_BASE_MS * 2 ** count, LOCK_MAX_MS);
  return {
    failed_logins: 0, locked_until: new Date(now + length).toISOString(),
    lock_count: count + 1, last_locked_at: new Date(now).toISOString(),
    locked: true, lockMinutes: Math.round(length / 60000),
  };
}

// A wrong password for this account: applies lockAfterFailure to the row and
// writes the result. Read and written in one transaction, so two wrong
// passwords landing together each count. Returns what lockAfterFailure did,
// or null for an account that no longer exists.
const recordFailedLogin = db.transaction((id, now = Date.now()) => {
  const row = findById(id);
  if (!row) return null;
  const next = lockAfterFailure(row, now);
  db.prepare('UPDATE users SET failed_logins = ?, locked_until = ?, lock_count = ?, last_locked_at = ? WHERE id = ?')
    .run(next.failed_logins, next.locked_until, next.lock_count, next.last_locked_at, id);
  return next;
});

// A sign-in that went through: the lockout record is cleared whole, and the
// time of the sign-in kept.
function recordSuccessfulLogin(id, now = Date.now()) {
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, lock_count = 0, last_locked_at = NULL, last_login_at = ? WHERE id = ?')
    .run(new Date(now).toISOString(), id);
}

// An admin's unlock: the same clean slate a successful sign-in leaves, without
// the sign-in. Also what a password reset does, since the person the reset is
// for is the one who was locked out.
function unlockAccount(id) {
  const user = findById(id);
  if (!user) throw new Error('User not found');
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, lock_count = 0, last_locked_at = NULL WHERE id = ?').run(id);
  return sanitize({ ...user, failed_logins: 0, locked_until: null, lock_count: 0, last_locked_at: null });
}

// Whether the row's password is a temporary one whose day has run out. A
// password the person chose has no expiry.
function temporaryPasswordExpired(row, now = Date.now()) {
  if (!row || !row.must_change_password || !row.temp_password_expires_at) return false;
  const until = Date.parse(row.temp_password_expires_at);
  return Number.isFinite(until) && until <= now;
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
// opposite of what a reset is for. (The session rows are ended by the routes,
// which know which session to keep and who did it: utils/sessions.js.) When
// it happened is kept in password_changed_at, for the Admin page.
//
// `ifCurrentHash` makes the write conditional on the password still being the
// one just verified. Changing your own password checks the current one and
// then hashes the new one, and an admin's reset can land in between; written
// unconditionally, the user's change silently replaced the password the admin
// had just set. Returns false when that happened and nothing was written. An
// admin's reset passes no hash and always writes.
//
// `temporary` is the admin's reset: the new password must be replaced at the
// next sign-in and dies after a day, and the account is unlocked, since the
// person asking for a reset is as likely as not the one who got locked out.
// A person's own change is the opposite: it is the replacement, so the
// temporary marks come off.
async function setPassword(id, newPassword, { ifCurrentHash = null, temporary = false } = {}) {
  const user = findById(id);
  if (!user) throw new Error('User not found');
  const problem = passwordProblem(newPassword, user.email);
  if (problem) throw new Error(problem);
  const hash = await bcrypt.hash(newPassword, 10);
  const now  = Date.now();
  const at   = new Date(now).toISOString();
  const marks = temporary
    ? { must: 1, expires: new Date(now + TEMP_PASSWORD_TTL_MS).toISOString() }
    : { must: 0, expires: null };
  if (ifCurrentHash) {
    const { changes } = db.prepare(`
      UPDATE users SET password = ?, sessions_valid_from = ?, must_change_password = ?, temp_password_expires_at = ?, password_changed_at = ?
      WHERE id = ? AND password = ?
    `).run(hash, at, marks.must, marks.expires, at, id, ifCurrentHash);
    return changes > 0;
  }
  db.prepare(`
    UPDATE users SET password = ?, sessions_valid_from = ?, must_change_password = ?, temp_password_expires_at = ?, password_changed_at = ?
    WHERE id = ?
  `).run(hash, at, marks.must, marks.expires, at, id);
  if (temporary) unlockAccount(id);
  return true;
}

// The account must choose a new password before anything else (the same gate
// as a temporary password, auth-middleware.js), but its current one keeps
// working: no expiry, unlike an admin's temporary password. For a password the
// rules now refuse, found at sign-in (routes/auth.js), and for a demo account
// made an admin (routes/admin.js), which may still have the short password
// demo accounts were once allowed. A no-op on an account already marked.
function requirePasswordChange(id) {
  db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ? AND must_change_password = 0').run(id);
}

// Why the account must choose a new password, for the screen that asks:
// 'temporary' (an admin set it, and it expires), 'rules' (its own password no
// longer meets them), or null when nothing is asked. Takes the raw row.
function passwordChangeReason(row) {
  if (!row || !row.must_change_password) return null;
  return row.temp_password_expires_at ? 'temporary' : 'rules';
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

// Whether this is a demo account (createUser's `demo`, or an admin's own
// switch, setDemo): one whose every Xero call goes to the generated Demo
// Company (xero/demo/api.js) and which has no Xero connection to make,
// refresh or poll. An admin's account switched to sample data may still have
// a real connection on file, untouched and unused until it is switched back;
// only the keep-alive (jobs/xero-keepalive.js) looks after it meanwhile. One
// primary-key read; the callers that ask on every Xero call
// (utils/token-cache.js) are already on a database round trip.
function isDemoUser(id) {
  const user = findById(id);
  return !!(user && user.is_demo);
}

// Switches an account between the generated Demo Company (on) and its own
// Xero (off): PUT /api/setup/data-source, an admin's own account only. Only
// the flag moves. The account's Xero credentials, refresh token and
// connection health stay exactly as they were, so switching back needs no
// reconnect. Returns the account as the client sees it.
function setDemo(id, on) {
  const user = findById(id);
  if (!user) throw new Error('User not found');
  const flag = on ? 1 : 0;
  db.prepare('UPDATE users SET is_demo = ? WHERE id = ?').run(flag, id);
  return sanitize({ ...user, is_demo: flag });
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
  // The account's sessions have no foreign key to cascade by (schema.sql), so
  // they go here, in the same transaction: an IP address kept for an account
  // that no longer exists serves nobody's security.
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(String(id));
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
}

function readUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all();
}

// The account as the client sees it: never the hash, and the lockout and
// temporary-password state in words the Admin page and the sign-in response
// use. lockedUntil is only given while the lock is in force; the column keeps
// its old value after the lock ends, until the next sign-in clears it. `demo`
// is the flag the client hides the Xero connection behind (users.is_demo).
// lockCount and lastLockedAt are the current run of locks (lockAfterFailure),
// passwordChangedAt when the password was last set, and
// tempPasswordExpiresAt when a temporary one stops working: for the Admin
// page's account detail. Nothing here is a secret from the account's owner,
// who is the only other reader (the sign-in response).
function sanitize(u) {
  const lastSeenAt  = u.last_seen_at ?? u.lastSeenAt ?? null;
  const lockedUntil = lockStatus({ locked_until: u.locked_until ?? u.lockedUntil ?? null });
  return {
    id: u.id, email: u.email, role: u.role, createdAt: u.created_at || u.createdAt,
    lastSeenAt, online: isOnline(lastSeenAt),
    disabledAt: u.disabled_at ?? u.disabledAt ?? null,
    failedLogins:       u.failed_logins ?? u.failedLogins ?? 0,
    lockedUntil:        lockedUntil ? lockedUntil.lockedUntil : null,
    mustChangePassword: !!(u.must_change_password ?? u.mustChangePassword),
    passwordChangeReason: u.passwordChangeReason ?? passwordChangeReason(u),
    lastLoginAt:      u.last_login_at ?? u.lastLoginAt ?? null,
    demo:               !!(u.is_demo ?? u.isDemo ?? u.demo),
    lockCount:             u.lock_count ?? u.lockCount ?? 0,
    lastLockedAt:          u.last_locked_at ?? u.lastLockedAt ?? null,
    passwordChangedAt:     u.password_changed_at ?? u.passwordChangedAt ?? null,
    tempPasswordExpiresAt: u.temp_password_expires_at ?? u.tempPasswordExpiresAt ?? null,
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
  // the consent flow; see xero/oauth.js). A demo account has nothing to
  // configure: its Xero is the Demo Company, always there, so its mailbox
  // watcher (routes/process.js _missingForWatcher) can start.
  const xero   = isDemoUser(userId)
    || !!(config.XERO_CLIENT_ID && config.XERO_CLIENT_SECRET) || config.XERO_CONNECTION_TYPE === 'oauth';
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
  passwordProblem, verifiedPasswordHash, setPassword, invalidateSessions, setDisabled, isActive, isDemoUser, setDemo,
  requirePasswordChange, passwordChangeReason,
  PASSWORD_MIN_LENGTH,
  lockStatus, lockAfterFailure, recordFailedLogin, recordSuccessfulLogin, unlockAccount, temporaryPasswordExpired,
  LOCK_AFTER_FAILURES, LOCK_BASE_MS, LOCK_MAX_MS, TEMP_PASSWORD_TTL_MS,
  getAllUsers, updateUserRole, deleteUser, readUsers,
  getUserConfig, saveUserConfig, getUserDefaults, defaultsFrom, getSetupStatus, getImapSettings, ensureUserDirectories,
  checkAllowanceSettings, allowanceSettingsFrom, getAllowanceSettings, formatRate,
  getGeminiKeys, addGeminiKey, removeGeminiKey,
  touchLastSeen, isOnline, DEFAULT_TIMEZONE, isKnownTimezone, timezoneProblem,
  CONFIG_KEY_TO_COLUMN, ENCRYPTED_COLUMNS, // exposed for the one-time JSON->SQLite importer
};
