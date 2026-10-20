// GET /api/admin/users/:id/detail — one account on one page, for the admin
// asking "what is going on with this person": the account and its sign-in
// state, where it is signed in now, its last month of sign-ins with where
// and on what each came from, what its automation is doing, and what has
// happened to it lately.
//
// Read-only, and nothing secret in it: no password hash, token, API key or
// mailbox password, only whether each is there (the mailbox address, how many
// LLM keys). The account is copied field by field rather than spread, so a
// column added to users later is not shown here until someone decides it
// should be.
//
// Locations come from utils/geoip.js (DB-IP's offline data; `attribution` is
// the credit its licence requires wherever one is shown), devices from
// utils/user-agent.js.
const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const router   = express.Router();
const { requireAdmin } = require('../middleware/auth-middleware');
const asyncHandler     = require('../middleware/async-handler');
const users            = require('../utils/users');
const sessions         = require('../utils/sessions');
const auditLog         = require('../utils/audit-log');
const invoiceEvents    = require('../utils/invoice-events');
const invoiceStore     = require('../utils/invoice-store');
const settingsStore    = require('../utils/settings-store');
const tokenCache       = require('../utils/token-cache');
const emailQueue       = require('../queue/email-queue');
const watcherRegistry  = require('../email/watcher-registry');
const paths            = require('../utils/paths');
const geoip            = require('../utils/geoip');
const { describeUserAgent } = require('../utils/user-agent');
const db               = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;

// The sign-ins shown: the last month, at most this many.
const SIGN_IN_DAYS = 30;
const SIGN_IN_MAX  = 50;
// An address or a device is new when the account had not signed in from it
// in this many days before. The sign-in records themselves are kept 90 days
// (audit-log.js SIGN_IN_RETENTION_DAYS), so this is as far back as there is.
const NEW_WINDOW_DAYS = 90;
// A session is made moments after the sign-in that made it, which must not
// count as having been seen "before" it.
const SAME_SIGN_IN_MS = 60 * 1000;
const ACTIVITY_MAX = 50;
// How many pages (of audit-log.PAGE_MAX events) one question reads at most,
// so an account with years of history is still one quick answer.
const MAX_EVENT_PAGES = 10;
// Totalling a folder means listing every file in it; a figure ten minutes old
// is good enough for "how much does this account keep on disk".
const STORAGE_TTL_MS = 10 * 60 * 1000;
const ERROR_MAX = 300;

// The sign-in record kinds (routes/auth.js, routes/admin.js), and what each
// came to.
const SIGN_IN_RESULTS = {
  'login.success':  'success',
  'login.failed':   'failure',
  'login.locked':   'locked',
  'login.refused':  'refused',
  'login.unlocked': 'unlocked',
  logout:           'logout',
  'session.revoke': 'revoked',
};

// The account's folders and what they hold: receipts (utils/receipt-store.js),
// bill PDFs (utils/pdf-store.js), and mail and import jobs waiting with their
// attachments (queue/email-queue.js, claims/claim-queue.js).
const STORAGE_FOLDERS = { receipts: ['receipts'], pdfs: ['pdfs'], queue: ['email-queue', 'claim-queue'] };

const _clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const _count = n => Number(n) || 0;

// ── The account ──────────────────────────────────────────────────────────────

// The account as users.js gives it to the client (sanitize), with the four
// fields about its password and locks read from the row while users.js does
// not give them yet.
function _userView(row) {
  const s = (typeof users.sanitize === 'function'
    ? users.sanitize(row)
    : users.getAllUsers().find(u => String(u.id) === String(row.id))) || {};
  const either = (field, column) => s[field] ?? row[column] ?? null;
  return {
    id:                    row.id,
    email:                 row.email,
    role:                  row.role,
    demo:                  !!s.demo,
    createdAt:             s.createdAt ?? row.created_at ?? null,
    lastLoginAt:           s.lastLoginAt ?? null,
    lastSeenAt:            s.lastSeenAt ?? null,
    online:                !!s.online,
    disabledAt:            s.disabledAt ?? null,
    mustChangePassword:    !!s.mustChangePassword,
    failedLogins:          _count(s.failedLogins),
    // Only while the lock is in force; sanitize drops a lock that has ended.
    lockedUntil:           s.lockedUntil ?? null,
    lockCount:             _count(either('lockCount', 'lock_count')),
    lastLockedAt:          either('lastLockedAt', 'last_locked_at'),
    passwordChangedAt:     either('passwordChangedAt', 'password_changed_at'),
    tempPasswordExpiresAt: either('tempPasswordExpiresAt', 'temp_password_expires_at'),
  };
}

// ── Sign-ins and sessions ────────────────────────────────────────────────────

// Admin events on this account, newest first, that `keep` accepts, until
// `want` are kept, they run out, or MAX_EVENT_PAGES pages have been read.
function _adminEvents(userId, { from = null, action = null, keep = () => true, want = Infinity }) {
  const out = [];
  let before = null;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const { events, nextBefore } = auditLog.listAdminEvents({ targetUserId: userId, action, from, before, limit: auditLog.PAGE_MAX });
    for (const e of events) {
      if (!keep(e)) continue;
      out.push(e);
      if (out.length >= want) return out;
    }
    if (!nextBefore) break;
    before = nextBefore;
  }
  return out;
}

const _ip = ip => (ip ? geoip.normalizeIp(ip) || String(ip) : null);

// Where an address is, in words, looked up once per address per request.
function _locator() {
  const seen = new Map();
  return ip => {
    if (!ip) return '';
    if (!seen.has(ip)) seen.set(ip, geoip.locationLabel(geoip.lookupIp(ip)));
    return seen.get(ip);
  };
}

// Whether `ip` or `device` is one this account had not signed in from in the
// NEW_WINDOW_DAYS before `at`. Only successful sign-ins make an address or a
// device familiar: a guesser's failures do not. A device is judged only
// against sign-ins that recorded one, since those from before the browser was
// recorded say nothing about it; an address is judged against every one.
function _isNew(successes, { at, ip, device, graceMs = 0, skip = () => false }) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  const end   = t - graceMs;
  const start = t - NEW_WINDOW_DAYS * DAY_MS;
  const earlier = successes.filter(s => s.t >= start && s.t < end && !skip(s));
  if (ip && !earlier.some(s => s.ip === ip)) return true;
  const withDevice = earlier.filter(s => s.device);
  return !!device && withDevice.length > 0 && !withDevice.some(s => s.device === device);
}

function _signInsAndSessions(userId, requestSid, now) {
  const where = _locator();
  const recent = _adminEvents(userId, {
    from: new Date(now - SIGN_IN_DAYS * DAY_MS).toISOString(),
    keep: e => !!SIGN_IN_RESULTS[e.action],
    want: SIGN_IN_MAX,
  });
  const live = sessions.listSessions(userId, { active: true }) || [];

  // Every successful sign-in the "new" checks below could look back to.
  const times = [...recent.map(e => Date.parse(e.at)), ...live.map(s => Date.parse(s.createdAt))].filter(Number.isFinite);
  const from = new Date((times.length ? Math.min(...times) : now) - NEW_WINDOW_DAYS * DAY_MS).toISOString();
  const successes = _adminEvents(userId, { from, action: 'login.success' }).map(e => {
    const d = e.details || {};
    return { id: e.id, t: Date.parse(e.at), ip: _ip(d.ip), device: d.ua ? describeUserAgent(d.ua).label : null, sid: d.sid || null };
  });

  // `reason` is the code the record keeps (a refusal's locked | disabled |
  // expired_temporary), which the page words; a lock also says how long, as
  // GET /api/auth/sign-ins does.
  const signIns = recent.map(e => {
    const d = e.details || {};
    const ip = _ip(d.ip);
    const device = describeUserAgent(d.ua).label;
    const row = {
      at: e.at, action: e.action, result: SIGN_IN_RESULTS[e.action], reason: d.reason ? String(d.reason) : null,
      ip, location: where(ip), device,
      isNew: _isNew(successes, { at: e.at, ip, device: d.ua ? device : null, skip: s => s.id === e.id }),
    };
    if (e.action === 'login.locked' && Number.isFinite(Number(d.lockMinutes))) row.lockMinutes = Number(d.lockMinutes);
    return row;
  });

  const sessionList = live.map(s => {
    const ip = _ip(s.lastIp || s.firstIp);
    const device = describeUserAgent(s.userAgent).label;
    return {
      sid: s.sid, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt,
      ip, location: where(ip), device,
      isNew: _isNew(successes, {
        at: s.createdAt, ip, device: s.userAgent ? device : null,
        graceMs: SAME_SIGN_IN_MS, skip: x => !!x.sid && x.sid === s.sid,
      }),
      current: !!requestSid && s.sid === requestSid,
    };
  });

  return { signIns, sessions: sessionList };
}

// ── Work ─────────────────────────────────────────────────────────────────────

// Every value this account keeps secret, to take out of text that came from
// elsewhere (a queued email's error). Short values are left alone: replacing
// three letters wherever they appear would mangle the text and hide nothing.
function _secretsOf(userId, config) {
  const values = [
    config.XERO_CLIENT_SECRET, config.XERO_OAUTH_CLIENT_SECRET, config.XERO_OAUTH_REFRESH_TOKEN,
    config.IMAP_PASS, config.Gemini_API_KEY,
    ...users.getGeminiKeys(userId).map(k => k.apiKey),
  ];
  return values.map(v => String(v ?? '')).filter(v => v.length >= 8);
}

function _redact(text, secrets) {
  let s = String(text);
  for (const secret of secrets) s = s.split(secret).join('[redacted]');
  return s;
}

const _storage = new Map(); // userId -> { at, value } | { promise }

async function _bytesUnder(dir) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return 0; }
  let total = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await _bytesUnder(p);
    else if (e.isFile()) {
      try { total += (await fs.promises.stat(p)).size; } catch (_) { /* gone since the listing */ }
    }
  }
  return total;
}

async function _measure(userId) {
  const base = paths.userDir(userId);
  const out = { bytes: 0 };
  for (const [part, folders] of Object.entries(STORAGE_FOLDERS)) {
    out[part] = 0;
    for (const f of folders) out[part] += await _bytesUnder(path.join(base, f));
    out.bytes += out[part];
  }
  return out;
}

// The account's bytes on disk, measured at most once per STORAGE_TTL_MS.
function _storageFor(userId, now) {
  const key = String(userId);
  const have = _storage.get(key);
  if (have && have.value && now - have.at < STORAGE_TTL_MS) return Promise.resolve(have.value);
  if (have && have.promise) return have.promise;
  const promise = _measure(key)
    .then(value => { _storage.set(key, { at: Date.now(), value }); return value; })
    .catch(err => { _storage.delete(key); throw err; });
  _storage.set(key, { promise });
  return promise;
}

function _work(userId) {
  const config  = users.getUserConfig(userId) || {};
  const status  = watcherRegistry.getStatus(userId) || {};
  const imap    = users.getImapSettings(userId, config) || {};
  const health  = tokenCache.getHealth(userId) || {};
  const tenants = tokenCache.getPersistedTenants(userId) || [];
  const settings = settingsStore.forUser(userId);

  // The same counts /api/process/status gives the account's own dashboard.
  const byStatus = invoiceStore.forUser(userId).countByStatus();
  const total = Object.values(byStatus).reduce((sum, n) => sum + _count(n), 0);
  // As /api/process/status and /api/admin/monitoring read it: the newest
  // processed_at among the account's records.
  const last = db.prepare('SELECT MAX(processed_at) AS at FROM invoices WHERE user_id = ?').get(userId);

  const queue = emailQueue.getStats(userId);
  const dead  = (queue.jobs || []).filter(j => j.status === 'dead')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const lastError = dead[0] && dead[0].lastError
    ? _clip(_redact(dead[0].lastError, _secretsOf(userId, config)), ERROR_MAX) : null;

  const listKeys = users.getGeminiKeys(userId).length;

  return {
    watcher: {
      running: watcherRegistry.isRunning(userId),
      state:   status.state || 'stopped',
      reason:  status.reason || null,
      enabled: settings.watcherEnabled(),
    },
    autoSubmit: !!settings.get('autoProcess'),
    mailbox: { configured: !!imap.ready, address: imap.user || null },
    xero: {
      connected:       tenants.length > 0,
      method:          health.method || config.XERO_CONNECTION_TYPE || null,
      needsReconnect:  !!health.needsReconnect,
      reason:          health.reason || null,
      lastRefreshedAt: health.lastRefreshedAt || null,
      organisations:   tenants.map(t => t.tenantName).filter(Boolean),
    },
    documents: {
      pending:      _count(byStatus.pending),
      reviewNeeded: _count(byStatus['review-needed']),
      reviewed:     _count(byStatus.reviewed),
      submitting:   _count(byStatus.submitting),
      posted:       _count(byStatus.posted),
      error:        _count(byStatus.error),
      duplicate:    _count(byStatus.duplicate),
      reported:     _count(byStatus.reported),
      total,
      lastProcessedAt: (last && last.at) || null,
    },
    queue: { pending: _count(queue.pending), processing: _count(queue.processing), dead: _count(queue.dead), lastError },
    // How many, never which: the gemini client uses the list, or the one
    // older single key when the list is empty (utils/gemini-client.js).
    geminiKeys: listKeys || (config.Gemini_API_KEY ? 1 : 0),
  };
}

// ── Activity ─────────────────────────────────────────────────────────────────

// What has happened to the account lately: its records' history and what
// admins did to it, newest first. Sign-ins are left out; they have their own
// list.
function _activity(userId) {
  const documents = invoiceEvents.listForUser(userId, { limit: ACTIVITY_MAX })
    .map(e => ({ at: e.at, kind: 'document', summary: e.summary, by: e.by, recordId: e.recordId }));
  const account = _adminEvents(userId, { keep: e => !SIGN_IN_RESULTS[e.action], want: ACTIVITY_MAX })
    .map(e => ({
      at: e.at, kind: 'account', summary: e.summary,
      by: e.actorEmail || (e.actorId ? 'An account since deleted' : 'System'), recordId: null,
    }));
  return [...documents, ...account]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, ACTIVITY_MAX);
}

// ── Route ────────────────────────────────────────────────────────────────────

router.get('/users/:id/detail', requireAdmin, asyncHandler(async (req, res) => {
  const row = users.findById(req.params.id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  const userId = row.id;
  const now = Date.now();

  // Opens the location databases if they need it, off the main thread, so
  // the lookups below find them open.
  await geoip.ready();
  const storage = await _storageFor(userId, now);

  const { signIns, sessions: sessionList } = _signInsAndSessions(userId, req.user.sid || null, now);
  res.json({
    user: _userView(row),
    sessions: sessionList,
    signIns,
    work: { ..._work(userId), storage },
    activity: _activity(userId),
    attribution: geoip.ATTRIBUTION,
  });
}));

module.exports = router;
module.exports._storageCache = _storage;
