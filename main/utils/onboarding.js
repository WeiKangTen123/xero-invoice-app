const db     = require('../db');
const logger = require('./logger');

// What a new account is walked through before it starts work, as
// GET /api/onboarding answers it (routes/onboarding.js):
//
//   - The privacy notice: what this app keeps about a person, why, where it
//     goes, how long it is kept and who to ask (the notification obligation
//     of Singapore's PDPA). Shown once to each account, and again whenever
//     its text changes, which is what NOTICE_VERSION is for. Which version an
//     account saw, and when, is kept here. The words themselves are the
//     client's (ui/src/components/privacy-notice.js), under the same number.
//
//   - The "Get set up" checklist: AI reading, the mailbox, Xero and the
//     watcher, in the setup guide's order. A step is done when it works, not
//     when its boxes are filled in, so the last Test of each connection is
//     kept here too (routes/setup.js records it after each Test answers).
//
// The table is created here rather than in db/schema.sql, as token-cache.js
// creates xero_connection_health, so this change keeps out of the schema
// while another change is editing it. TABLE_SQL is the definition to copy
// there. CREATE TABLE IF NOT EXISTS is safe on every boot, and the foreign
// key removes the row with the account.

// The privacy notice's version. Raise it when the notice's words change in a
// way people must be told about: every account is asked to read it again.
const NOTICE_VERSION = 1;

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS user_onboarding (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notice_version   INTEGER,
  notice_seen_at   TEXT,
  llm_ok           INTEGER,
  llm_message      TEXT,
  llm_checked_at   TEXT,
  imap_ok          INTEGER,
  imap_message     TEXT,
  imap_checked_at  TEXT,
  xero_ok          INTEGER,
  xero_message     TEXT,
  xero_checked_at  TEXT
)`;

// The Tests whose outcome is kept: Test LLM, Test IMAP and Test Xero. Each
// name is also its columns' prefix, so only these may reach the SQL below.
const TEST_KINDS = ['llm', 'imap', 'xero'];

// A failed test's message is a server's error text and can run long; this
// is plenty to say what went wrong.
const MESSAGE_MAX = 300;

let _tableReady = false;
function _ensureTable() {
  if (_tableReady) return;
  db.exec(TABLE_SQL);
  _tableReady = true;
}
// At load, so the table is there before the first request needs it. A
// failure here is tried again by the first read or write.
try { _ensureTable(); } catch (err) {
  logger.warn('Could not create the onboarding table yet', { error: err.message });
}

function _row(userId) {
  _ensureTable();
  return db.prepare('SELECT * FROM user_onboarding WHERE user_id = ?').get(String(userId)) || null;
}

// ── The privacy notice ───────────────────────────────────────────────────────

// The version accounts must have seen. A function so the route reads it at
// the time of each request (and a test can stand a newer one in).
function currentNoticeVersion() {
  return NOTICE_VERSION;
}

// Whether this account must be shown the notice: it has never seen one, or
// only an older version. `seenAt` is when it saw the version it last saw.
function noticeState(userId, version = NOTICE_VERSION) {
  const row  = _row(userId);
  const seen = row && row.notice_version != null ? Number(row.notice_version) : null;
  return { required: seen == null || seen < version, version, seenVersion: seen, seenAt: row ? row.notice_seen_at : null };
}

// Records that the account was shown this version of the notice, now. Not
// swallowed: the record is the whole point of the button, so a failure must
// reach the person, who is then asked again.
function acknowledgeNotice(userId, version, at = new Date()) {
  _ensureTable();
  db.prepare(`
    INSERT INTO user_onboarding (user_id, notice_version, notice_seen_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET notice_version = excluded.notice_version, notice_seen_at = excluded.notice_seen_at
  `).run(String(userId), version, new Date(at).toISOString());
}

// Who to ask about one's data, as the notice names them: the address an
// admin set in Setup (PRIVACY_CONTACT_EMAIL, read at the time of use, as
// every server-wide setting is), else the admin who signed in most recently,
// as the one most likely to answer. A disabled admin is passed over. null
// when there is no admin at all.
function privacyContact() {
  const set = String(process.env.PRIVACY_CONTACT_EMAIL || '').trim();
  if (set) return set;
  const row = db.prepare(`
    SELECT email FROM users WHERE role = 'admin' AND disabled_at IS NULL
    ORDER BY last_login_at IS NULL, last_login_at DESC, created_at
    LIMIT 1
  `).get();
  return row ? row.email : null;
}

// ── Test results ─────────────────────────────────────────────────────────────

// One line, cut to length, and never a Google API key: a Gemini error can
// quote the request it failed on.
function _cleanMessage(message) {
  const text = String(message ?? '').replace(/\s+/g, ' ').replace(/AIza[0-9A-Za-z_-]{8,}/g, 'AIza…').trim();
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text;
}

// Keeps the outcome of one Test (kind 'llm' | 'imap' | 'xero'). Never throws:
// a Test's answer must reach the person whatever becomes of this record, so
// a failure is logged and reported as false.
function recordTest(userId, kind, { ok, message = '', at = new Date() } = {}) {
  if (!TEST_KINDS.includes(kind)) return false;
  try {
    _ensureTable();
    db.prepare(`
      INSERT INTO user_onboarding (user_id, ${kind}_ok, ${kind}_message, ${kind}_checked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        ${kind}_ok = excluded.${kind}_ok, ${kind}_message = excluded.${kind}_message, ${kind}_checked_at = excluded.${kind}_checked_at
    `).run(String(userId), ok ? 1 : 0, _cleanMessage(message), new Date(at).toISOString());
    return true;
  } catch (err) {
    logger.warn('Setup test result not recorded', { userId, kind, error: err.message });
    return false;
  }
}

// Forgets a Test's outcome: the settings it was about have changed since, so
// it no longer says whether they work. Never throws, as recordTest.
function clearTest(userId, kind) {
  if (!TEST_KINDS.includes(kind)) return false;
  try {
    _ensureTable();
    db.prepare(`UPDATE user_onboarding SET ${kind}_ok = NULL, ${kind}_message = NULL, ${kind}_checked_at = NULL WHERE user_id = ?`)
      .run(String(userId));
    return true;
  } catch (err) {
    logger.warn('Setup test result not cleared', { userId, kind, error: err.message });
    return false;
  }
}

// The last outcome of one Test: { ok, message, checkedAt }, or null when the
// account has never run it (or its settings changed since).
function lastTest(userId, kind, row = undefined) {
  if (!TEST_KINDS.includes(kind)) return null;
  const r = row === undefined ? _row(userId) : row;
  if (!r || r[`${kind}_checked_at`] == null) return null;
  return { ok: r[`${kind}_ok`] === 1, message: r[`${kind}_message`] || '', checkedAt: r[`${kind}_checked_at`] };
}

// ── The checklist ────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// '22 Oct', in the account's own timezone (Setup's preference). Built from
// the numbers rather than a locale's month names, which differ between ICU
// versions ('Sep' or 'Sept').
function _dayFormatter(timeZone) {
  const { isKnownTimezone, DEFAULT_TIMEZONE } = require('./users');
  const tz  = timeZone && isKnownTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  const fmt = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'numeric', timeZone: tz });
  return iso => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
    return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]}`;
  };
}

// A failed test's reason, short enough for one line of the checklist.
function _short(message) {
  const text = String(message || '').trim() || 'no reason given';
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

// A step that is set up and needs its Test to pass: done once it has.
function _testedStep(what, test, day) {
  if (!test)    return { done: false, detail: `${what} · not tested yet` };
  if (!test.ok) return { done: false, detail: `Last test failed: ${_short(test.message)}` };
  return { done: true, detail: `${what} · tested ${day(test.checkedAt)}` };
}

// 1. AI reading: a key reading can use, and a Test LLM that passed. Keys are
// counted as reading uses them (gemini-client.js _resolveKeys): the added
// ones, else the old single-key field, else the server's shared key.
function _llmStep(userId, setup, test, day) {
  const users = require('./users');
  if (setup.llm.configured) {
    const n = users.getGeminiKeys(userId).length || 1;
    return _testedStep(`${n} ${n === 1 ? 'key' : 'keys'}`, test, day);
  }
  if (process.env.Gemini_API_KEY) return _testedStep('Shared key', test, day);
  return { done: false, detail: 'No key yet' };
}

// 2. Mailbox: settings the watcher can use (users.getImapSettings, the same
// test getSetupStatus makes) and a Test IMAP that passed.
function _mailboxStep(userId, config, setup, test, day) {
  if (!setup.imap.configured) return { done: false, detail: 'Not set up yet' };
  const mailbox = require('./users').getImapSettings(userId, config).user || 'Mailbox';
  return _testedStep(mailbox, test, day);
}

// 3. Xero: an organisation connected, by either method, as the connection
// banner reads it (xero/reconnect.js getConnectionStatus), or a Test Xero
// that passed on a connection nothing has since found broken. A demo
// account's Xero is the Demo Company, always there.
function _xeroStep(userId, demo, test) {
  if (demo) return { done: true, detail: 'Sample data' };
  const status = require('../xero/reconnect').getConnectionStatus(userId);
  const done   = status.connected || (!!test?.ok && !!status.method && !status.needsReconnect);
  if (done) {
    const names = (require('./token-cache').getPersistedTenants(userId) || []).map(t => t.tenantName).filter(Boolean);
    const detail = names.length > 1 ? `${names[0]} + ${names.length - 1} more` : names[0] || 'Connected';
    return { done: true, detail };
  }
  if (test && !test.ok)       return { done: false, detail: `Last test failed: ${_short(test.message)}` };
  if (status.needsReconnect)  return { done: false, detail: 'Needs reconnecting' };
  return { done: false, detail: 'Not connected' };
}

// 4. Watcher: watching the mailbox now (watcher-registry, as the Automation
// page's status reads it).
function _watcherStep(userId) {
  const running = require('../email/watcher-registry').isRunning(userId);
  return { done: running, detail: running ? 'On' : 'Off' };
}

// The four steps, each { done, detail }, keyed llm, mailbox, xero, watcher.
// The client puts them in order and counts them (ui/src/components/setup-checklist.js).
function checklist(userId) {
  const users  = require('./users');
  const config = users.getUserConfig(userId) || {};
  const setup  = users.getSetupStatus(userId);
  const demo   = users.isDemoUser(userId);
  const row    = _row(userId);
  const day    = _dayFormatter(config.TIMEZONE);
  return {
    llm:     _llmStep(userId, setup, lastTest(userId, 'llm', row), day),
    mailbox: _mailboxStep(userId, config, setup, lastTest(userId, 'imap', row), day),
    xero:    _xeroStep(userId, demo, lastTest(userId, 'xero', row)),
    watcher: _watcherStep(userId),
  };
}

module.exports = {
  NOTICE_VERSION, TABLE_SQL, TEST_KINDS,
  currentNoticeVersion, noticeState, acknowledgeNotice, privacyContact,
  recordTest, clearTest, lastTest, checklist,
};
