// Notices when something changed in Xero, so the reports on screen can be
// refreshed without anyone pressing Refresh, and without re-reading every
// report on a timer to find out that nothing happened.
//
// Xero has no change feed. What it has is the Journals endpoint: every
// transaction posts a journal, journals are numbered in order and never
// altered (a correction posts a new, reversing journal with a higher
// number), and `offset` asks for the journals numbered after one. So one
// small read per look — anything numbered past the last one seen? — says
// whether the books moved, and If-Modified-Since on top keeps the answer
// tiny, which matters since Xero bills on the volume read. Budgets post no
// journal, so the budget list's UpdatedDateUTC is read beside it.
//
// On a change the company's report cache is dropped (report-cache.js
// clearTenant), so the next request for any report reads Xero again, and
// the time of the change is recorded for GET /api/xero-reports/version,
// which the page polls to know when to ask again. Nothing here changes
// anything in Xero: getJournals and getBudgets are the only calls made.
//
// When it does not run, it says why (`live` false, `liveReason`):
//   - the journals scope was not granted. The Web app (OAuth) consent is the
//     only place it is asked for (xero-utils OAUTH_SCOPES), so a connection
//     made before it was added must be reconnected once, and a Custom
//     Connection cannot have it at all (see JOURNALS_SCOPE in xero-utils.js).
//   - the connection needs reconnecting: no call can succeed until a person
//     acts, so none is made.
//   - the company's daily allowance is nearly spent: the last calls of the
//     day are for the people using the app, not for a poll.
// A look that fails leaves the cursor as it was, so nothing is skipped over,
// and the company is left alone for a while rather than tried every minute.
//
// How often a company is looked at is decided here (due) and done by the
// job (jobs/xero-change-detector.js): one someone had a report of on screen
// in the last ten minutes every two minutes, any other every fifteen.
const { AccountingApi } = require('xero-node');
const db     = require('../db');
const logger = require('../utils/logger');
const {
  withRetry, xeroErrMsg, isScopeError, getRateLimitBudget, _parseXeroErr, JOURNALS_SCOPE,
} = require('./xero-utils');
const { clearTenant } = require('./report-cache');

// Xero answers 100 journals to a call. More than that since the last look
// is read page by page, up to a cap: ten pages is a thousand journals, and
// past that the answer — the books changed — is known whatever follows. The
// next look carries on from where this one stopped.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

// If-Modified-Since is sent this much earlier than the last look began. The
// time is this server's clock against Xero's; the offset already keeps a
// journal from being counted twice, so the slack costs a few bytes at most.
const CLOCK_SLACK_MS = 5 * 60 * 1000;

const WATCHED_EVERY_MS = 2 * 60 * 1000;
const IDLE_EVERY_MS    = 15 * 60 * 1000;
const VIEWED_WITHIN_MS = 10 * 60 * 1000;

// Below this many calls left for the day the poll stands aside.
const DAY_RESERVE = 50;

// A company that could not be read is not tried again before this: a
// failure that lasts would otherwise cost a call a minute all day. One that
// was skipped (no scope, Custom Connection, allowance) is looked at again
// sooner, so a reconnect is noticed within a couple of minutes. Both in
// memory: a restart simply tries again.
const FAIL_BACKOFF_MS = IDLE_EVERY_MS;
const SKIP_BACKOFF_MS = WATCHED_EVERY_MS;
const _notBefore = new Map(); // `${userId}:${tenantId}` -> ms

const REASONS = Object.freeze({
  pending:       'Not checked yet',
  notConnected:  'Xero is not connected',
  custom:        'Live updates need a Xero Web app connection: a Custom Connection cannot be granted the journals scope',
  scopesUnknown: 'Xero has not said yet which scopes this connection has; checked again after its next token refresh',
  scope:         'Reconnect Xero in Setup to grant accounting.journals.read',
  allowance:     'daily allowance low',
});

const _key = (userId, tenantId) => `${userId}:${tenantId}`;

// ── The cursor row ──────────────────────────────────────────────────────────

function _row(userId, tenantId) {
  return db.prepare('SELECT * FROM xero_change_cursor WHERE user_id = ? AND tenant_id = ?')
    .get(String(userId), String(tenantId)) || null;
}

// One statement whatever is being written: the columns named are set and the
// rest keep their values, so noting a view never loses the cursor and a poll
// never loses the view. The column names come from this file, never from a
// request.
function _upsert(userId, tenantId, fields) {
  const cols = Object.keys(fields);
  db.prepare(`
    INSERT INTO xero_change_cursor (user_id, tenant_id, ${cols.join(', ')})
    VALUES (?, ?, ${cols.map(() => '?').join(', ')})
    ON CONFLICT(user_id, tenant_id) DO UPDATE SET ${cols.map(c => `${c} = excluded.${c}`).join(', ')}
  `).run(String(userId), String(tenantId), ...cols.map(c => fields[c]));
}

/**
 * Someone asked for a report of this company: it is looked at more often
 * for the next ten minutes. One UPSERT, called on every report request.
 */
function noteViewed(userId, tenantId, now = new Date()) {
  _upsert(userId, tenantId, { last_viewed_at: new Date(now).toISOString() });
}

// Written only when it differs from what is stored: a company that cannot
// be polled is looked at every couple of minutes, and that must not be a
// write each time.
function _notLive(userId, tenantId, row, reason) {
  if (!row || row.live !== 0 || row.live_reason !== reason) _upsert(userId, tenantId, { live: 0, live_reason: reason });
  return { live: false, liveReason: reason, changed: false, reason: null, calls: 0 };
}

// ── Whether a look can be taken at all ──────────────────────────────────────

function _allowanceLow(budget, now) {
  if (budget.dayLimitHit) {
    // Xero said when the day comes back; after that, a call is what tells.
    return !(budget.resetAt && Date.parse(budget.resetAt) <= now);
  }
  return budget.dayRemaining !== null && budget.dayRemaining !== undefined && budget.dayRemaining < DAY_RESERVE;
}

// Why no call should be made for this company, in words for the person, or
// null when one can be. The connection's state is read from what is on file
// (reconnect.js getConnectionStatus never calls Xero); the scopes come from
// the health record, since getConnectionStatus reports none missing while
// they are not known yet, and unknown must not be taken as granted.
function _whyNotLive(userId, tenantId, now) {
  const status = require('./reconnect').getConnectionStatus(userId);
  if (!status.method) return REASONS.notConnected;
  if (status.method !== 'oauth') return REASONS.custom;
  if (status.needsReconnect) return status.reason || 'The Xero connection needs reconnecting';
  const granted = (require('../utils/token-cache').getHealth(userId) || {}).grantedScopes;
  if (!Array.isArray(granted)) return REASONS.scopesUnknown;
  if (!granted.includes(JOURNALS_SCOPE)) return REASONS.scope;
  const budget = getRateLimitBudget(tenantId);
  if (budget && _allowanceLow(budget, now)) return REASONS.allowance;
  return null;
}

// ── Asking Xero ─────────────────────────────────────────────────────────────

// getJournals(xeroTenantId, ifModifiedSince, offset, paymentsOnly). Positional,
// so sdk-contract.test.js pins the slots against the installed SDK.
// ifModifiedSince must be a Date: the SDK serialises it itself. A conditional
// read may be answered 304 Not Modified, which axios throws on; that is
// "nothing since", not a failure.
async function _journalsAfter(api, tenantId, since, offset) {
  try {
    const res = await withRetry(() => api.getJournals(tenantId, since, offset));
    return (res && res.body && res.body.journals) || [];
  } catch (err) {
    if (_parseXeroErr(err).status === 304) return [];
    throw err;
  }
}

// A Xero time as milliseconds, whether the SDK handed back a Date, an ISO
// string or Xero's own "/Date(ms+0000)/"; NaN for anything else.
function _time(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const ms = /^\/Date\((-?\d+)/.exec(value);
    if (ms) return Number(ms[1]);
  }
  return new Date(value).getTime();
}

// The newest UpdatedDateUTC across the company's budgets, as ISO, or null
// when it has none. The list without a budget ID carries no lines, so this
// is one small read.
async function _budgetsUpdated(api, tenantId) {
  const res = await withRetry(() => api.getBudgets(tenantId));
  let latest = null;
  for (const b of (res && res.body && res.body.budgets) || []) {
    const t = _time(b && b.updatedDateUTC);
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

async function _poll(userId, tenantId, row, now) {
  const token = await require('../utils/token-cache').forUser(userId).getValidToken(tenantId);
  const api   = new AccountingApi();
  api.accessToken = token;

  // Taken before the first call: a journal Xero posts while this runs is
  // after it, and the next look picks it up.
  const startedAt = now();
  const lastPoll  = row && row.last_poll_at ? Date.parse(row.last_poll_at) : NaN;
  const firstLook = !Number.isFinite(lastPoll);
  const since     = new Date((firstLook ? startedAt.getTime() : lastPoll) - CLOCK_SLACK_MS);
  const baseline  = row && Number.isInteger(row.last_journal_number) ? row.last_journal_number : null;

  // The first look sets the baseline: whatever it finds is what the reports
  // already show, not a change. After that a journal numbered past the
  // baseline is new; with no baseline yet (the first look found nothing),
  // anything at all is.
  let newest = baseline, fresh = 0, calls = 0;
  let offset = baseline === null ? undefined : baseline;
  for (let page = 0; page < MAX_PAGES; page++) {
    const journals = await _journalsAfter(api, tenantId, since, offset);
    calls++;
    for (const j of journals) {
      const n = Number(j && j.journalNumber);
      if (!Number.isInteger(n)) continue;
      if (!firstLook && (baseline === null || n > baseline)) fresh++;
      if (newest === null || n > newest) newest = n;
    }
    if (journals.length < PAGE_SIZE || newest === null) break;
    offset = newest;
  }

  const budgetUpdated = await _budgetsUpdated(api, tenantId);
  calls++;
  const budgetBefore  = row && row.last_budget_updated ? row.last_budget_updated : null;

  const reasons = [];
  if (fresh) reasons.push(`${fresh} new journal${fresh === 1 ? '' : 's'}`);
  if (!firstLook && budgetUpdated !== budgetBefore) reasons.push('budget edited');

  const fields = {
    last_journal_number: newest,
    last_budget_updated: budgetUpdated,
    last_poll_at:        startedAt.toISOString(),
    live:                1,
    live_reason:         null,
  };
  const changed = reasons.length > 0;
  if (changed) {
    fields.changed_at    = now().toISOString();
    fields.change_reason = reasons.join(', ');
    // Dropped before the row is written, so a report request arriving
    // between the two cannot cache the old figures against the new version.
    clearTenant(userId, tenantId);
    logger.info('Xero change detected', { userId, tenantId, reason: fields.change_reason });
  }
  _upsert(userId, tenantId, fields);
  return { live: true, liveReason: null, changed, reason: changed ? fields.change_reason : null, calls };
}

/**
 * One look at one company. Resolves with { live, liveReason, changed, reason,
 * calls }; never rejects. A Xero failure is a warning, leaves the cursor as
 * it was, and keeps the company out of the next looks for a while.
 */
async function pollTenant(userId, tenantId, { now = () => new Date() } = {}) {
  const at  = now().getTime();
  const row = _row(userId, tenantId);
  try {
    const why = _whyNotLive(userId, tenantId, at);
    if (why) {
      _notBefore.set(_key(userId, tenantId), at + SKIP_BACKOFF_MS);
      return _notLive(userId, tenantId, row, why);
    }
    const result = await _poll(userId, tenantId, row, now);
    _notBefore.delete(_key(userId, tenantId));
    return result;
  } catch (err) {
    let error;
    try { error = xeroErrMsg(err); } catch (_) { error = (err && err.message) || String(err); }
    _notBefore.set(_key(userId, tenantId), at + FAIL_BACKOFF_MS);
    logger.warn('Xero change check failed; the cursor is left as it was', { userId, tenantId, error });
    // The health record said the scope was granted and Xero says it was not:
    // Xero's word is the one that counts.
    return _notLive(userId, tenantId, row, isScopeError(err) ? REASONS.scope : `Could not check Xero: ${error}`);
  }
}

/**
 * Whether this company should be looked at now: never looked at, or looked
 * at more than two minutes ago while someone had a report of it on screen
 * in the last ten, or more than fifteen minutes ago otherwise. Not while a
 * failure or a skip is being left alone.
 */
function due(userId, tenantId, now = Date.now()) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const until = _notBefore.get(_key(userId, tenantId));
  if (until && at < until) return false;
  const row  = _row(userId, tenantId);
  const last = row && row.last_poll_at ? Date.parse(row.last_poll_at) : NaN;
  if (!Number.isFinite(last)) return true;
  const viewed  = row.last_viewed_at ? Date.parse(row.last_viewed_at) : NaN;
  const watched = Number.isFinite(viewed) && at - viewed <= VIEWED_WITHIN_MS;
  return at - last >= (watched ? WATCHED_EVERY_MS : IDLE_EVERY_MS);
}

/**
 * What the page polls: { changedAt, changeReason, checkedAt, live,
 * liveReason }. One read, no Xero call.
 */
function version(userId, tenantId) {
  const row = _row(userId, tenantId);
  const live = !!(row && row.live);
  return {
    changedAt:    (row && row.changed_at)    || null,
    changeReason: (row && row.change_reason) || null,
    checkedAt:    (row && row.last_poll_at)  || null,
    live,
    liveReason:   live ? null : ((row && row.live_reason) || REASONS.pending),
  };
}

module.exports = {
  noteViewed, pollTenant, due, version,
  PAGE_SIZE, MAX_PAGES, CLOCK_SLACK_MS, WATCHED_EVERY_MS, IDLE_EVERY_MS, VIEWED_WITHIN_MS,
  DAY_RESERVE, FAIL_BACKOFF_MS, SKIP_BACKOFF_MS, REASONS,
};
