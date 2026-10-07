// Reads back from Xero what became of every document this app posted there.
//
// Nothing used to ask. A bill went to Xero as a draft, was approved, paid,
// part-paid, voided or deleted there, and here it read "Posted" for good —
// with "Re-post" offered on it, although Xero refuses to update a bill once
// it has left DRAFT. This asks Xero for the status, what is still owed, what
// was paid and the day it was paid in full, and stores them on the row
// (invoice-store recordXeroStatus).
//
// Read-only: getInvoices is the only Xero call made here, and nothing is ever
// sent back. For one user, each connected company in turn:
//
//   - Asked by ID, 50 to a call, summaryOnly (no line items, which nothing
//     here needs and which make each answer many times larger).
//   - Rows already read are asked with If-Modified-Since set to the company's
//     last complete read (xero_status_sync), so Xero answers with only the
//     ones that changed; the rest are confirmed unchanged without being sent.
//     Rows never read are asked without it, since an old document unchanged
//     for a year would otherwise never come back at all.
//   - VOIDED and DELETED rows are not asked again: Xero cannot undo either,
//     so asking would spend a call for an answer already known.
//   - Every call goes through withRetry, so a minute limit is waited out and
//     the daily limit fails at once. A daily limit, or any other failure,
//     stops that company for this run and leaves its last complete read where
//     it was; the other companies carry on, since Xero counts its limits per
//     company. A connection Xero refuses stops the run for the user: one
//     connection covers every company, so none of the rest can be read.
//   - A row Xero does not return when asked by its ID is left exactly as it
//     is. It is never taken as deleted: only Xero saying DELETED marks it so.
//
// One run per user at a time: a second call while one is running gets that
// run (the 3-hourly job and the Refresh button can meet).
const { AccountingApi } = require('xero-node');
const db     = require('../db');
const logger = require('../utils/logger');
const {
  withRetry, xeroErrMsg, isReconnectError, getRateLimitBudget, _parseXeroErr, _dailyLimitMsg,
} = require('./xero-utils');

// Xero accepts a long ID list, but each ID is 36 characters of query string,
// and 50 keeps the URL well inside what proxies on the way allow.
const BATCH_SIZE = 50;

const XERO_STATUSES  = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED']);
const FINAL_STATUSES = new Set(['VOIDED', 'DELETED']);

// If-Modified-Since is sent this much earlier than the last read began. The
// timestamp is this server's clock and Xero compares it with its own; a few
// minutes of drift would otherwise skip a change made just before the read.
// Re-reading those minutes costs nothing: they arrive in the same call.
const CLOCK_SLACK_MS = 5 * 60 * 1000;

// Why a correction can no longer be sent, by what Xero says. A bill that has
// left DRAFT is someone else's now: Xero refuses an update to an approved,
// paid, voided or deleted one, and sending a submitted one back as a draft
// would pull it out of whoever is approving it.
const LOCKED_BECAUSE = {
  SUBMITTED:  'Awaiting approval in Xero',
  AUTHORISED: 'Approved in Xero',
  PAID:       'Paid in Xero',
  VOIDED:     'Voided in Xero',
  DELETED:    'Deleted in Xero',
};

/**
 * Why this record can no longer be re-posted from here, or null when it can:
 * not in Xero yet, its Xero status not known yet (the old behaviour), or
 * still a DRAFT there. The UI has the same rule (ui/src/pages/invoices/
 * xero-status.js); the submit route uses this one so a stale page cannot send.
 */
function repostRefusal(inv) {
  if (!inv || !inv.xeroInvoiceId || !inv.xeroStatus || inv.xeroStatus === 'DRAFT') return null;
  const why = inv.xeroStatus === 'AUTHORISED' && Number(inv.xeroAmountPaid) > 0
    ? 'Part-paid in Xero'
    : LOCKED_BECAUSE[inv.xeroStatus];
  return why ? `${why}, so it can no longer be changed from here` : null;
}

function _chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function _amount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The calendar day of a Xero date, as YYYY-MM-DD. Xero sends FullyPaidOnDate
// as "/Date(ms+0000)/", which xero-node turns into a Date at midnight UTC; an
// ISO string is taken as written, since parsing it would read it in the
// server's timezone and could move it a day.
function _xeroDay(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (iso) return iso[1];
    const ms = /^\/Date\((-?\d+)/.exec(value);
    if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * What one invoice from Xero says, as the store keeps it, or null for a
 * status this app does not know (stored as nothing rather than as a guess).
 */
function fromXero(inv) {
  const status = String((inv && inv.status) || '').toUpperCase();
  if (!XERO_STATUSES.has(status)) return null;
  const amountDue = _amount(inv.amountDue);
  let amountPaid  = _amount(inv.amountPaid);
  // In Xero, Total = AmountDue + AmountPaid + AmountCredited. Should a summary
  // answer leave AmountPaid out, it is what the other three leave over.
  const total = _amount(inv.total);
  if (amountPaid === null && amountDue !== null && total !== null) {
    amountPaid = Math.max(0, Math.round((total - amountDue - (_amount(inv.amountCredited) || 0)) * 100) / 100);
  }
  return { status, amountDue, amountPaid, paidOn: status === 'PAID' ? _xeroDay(inv.fullyPaidOnDate) : null };
}

// ── Last complete read, per user and company ────────────────────────────────

function _lastSuccess(userId, tenantId) {
  const row = db.prepare('SELECT last_success_at FROM xero_status_sync WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId);
  const t = row ? Date.parse(row.last_success_at) : NaN;
  return Number.isFinite(t) ? t : null;
}

function _recordSuccess(userId, tenantId, at) {
  db.prepare(`
    INSERT INTO xero_status_sync (user_id, tenant_id, last_success_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id, tenant_id) DO UPDATE SET last_success_at = excluded.last_success_at
  `).run(userId, tenantId, at);
}

// ── Which company each row is in ─────────────────────────────────────────────

// Rows grouped by the company that holds them. A row without one recorded
// (posted before the app kept it) is looked for where processor.js would send
// it: the only company, or the chosen default while it is still connected.
// With several and none chosen there is nowhere sure to look, so it waits; a
// row whose company is no longer connected cannot be asked about at all.
function _groupByTenant(userId, rows, connected) {
  const connectedIds = new Set(connected.map(t => String(t.tenantId)));
  let fallback;
  const fallbackTenant = () => {
    if (fallback === undefined) {
      try {
        const { chooseTenant } = require('../queue/processor');
        const tenants = connected.map(t => ({ tenant_id: t.tenantId, tenant_name: t.tenantName }));
        fallback = String(chooseTenant(userId, {}, tenants).tenant_id);
      } catch (_) {
        fallback = null;
      }
    }
    return fallback;
  };

  const groups = new Map();
  let skipped = 0;
  for (const row of rows) {
    const tenantId = row.xeroTenantId ? String(row.xeroTenantId) : fallbackTenant();
    if (!tenantId || !connectedIds.has(tenantId)) { skipped++; continue; }
    if (!groups.has(tenantId)) groups.set(tenantId, []);
    groups.get(tenantId).push(row);
  }
  return { groups, skipped };
}

// ── Asking Xero ──────────────────────────────────────────────────────────────

// getInvoices(xeroTenantId, ifModifiedSince, where, order, iDs, invoiceNumbers,
//             contactIDs, statuses, page, includeArchived, createdByMyApp,
//             unitdp, summaryOnly)
// Positional, so a reordering in an SDK upgrade would send the IDs or the
// summary flag as something else with no error; status-sync.test.js pins the
// slots against the installed SDK. ifModifiedSince must be a Date: the SDK
// calls toISOString() on it. No page: one call answers up to 50 IDs whole.
async function _fetchBatch(api, tenantId, ids, since) {
  try {
    const res = await withRetry(() => api.getInvoices(
      tenantId, since || undefined, undefined, undefined, ids,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, true,
    ));
    return (res && res.body && res.body.invoices) || [];
  } catch (err) {
    // A conditional request may be answered 304 Not Modified, which axios
    // throws on. That is "nothing changed since", not a failure.
    if (since && _parseXeroErr(err).status === 304) return [];
    throw err;
  }
}

function _dailyLimitHit(tenantId, now) {
  const b = getRateLimitBudget(tenantId);
  if (!b || !b.dayLimitHit || !b.resetAt) return null;
  const resetAt = Date.parse(b.resetAt);
  if (!(resetAt > now)) return null;
  const err = new Error(_dailyLimitMsg(new Date(resetAt), now));
  err.code = 'XERO_DAILY_LIMIT';
  return err;
}

// One company's rows. Adds to counts as it goes, so what was read before a
// failure still counts; throws on the failure that stopped it.
async function _syncTenant(userId, tenantId, rows, counts, now) {
  // Xero already said today's calls are spent and when they come back. Asking
  // again before then would only be refused.
  const spent = _dailyLimitHit(tenantId, now().getTime());
  if (spent) throw spent;

  const store = require('../utils/invoice-store').forUser(userId);
  const token = await require('../utils/token-cache').forUser(userId).getValidToken(tenantId);
  const api   = new AccountingApi();
  api.accessToken = token;

  // Taken before the first call: a change Xero records while this runs is
  // then after it, and the next read picks it up.
  const startedAt = now();
  const last      = _lastSuccess(userId, tenantId);
  const since     = last === null ? null : new Date(last - CLOCK_SLACK_MS);
  const unread    = since ? rows.filter(r => !r.xeroStatus) : rows;
  const known     = since ? rows.filter(r => r.xeroStatus)  : [];
  const plan = [
    ..._chunk(unread, BATCH_SIZE).map(batch => ({ batch, since: null })),
    ..._chunk(known,  BATCH_SIZE).map(batch => ({ batch, since })),
  ];

  for (const step of plan) {
    const invoices = await _fetchBatch(api, tenantId, step.batch.map(r => r.xeroInvoiceId), step.since);
    const syncedAt = now().toISOString();
    const byId = new Map(invoices.filter(i => i && i.invoiceID).map(i => [String(i.invoiceID).toLowerCase(), i]));
    const unchanged = [];
    for (const row of step.batch) {
      const inv = byId.get(String(row.xeroInvoiceId).toLowerCase());
      if (!inv) {
        // Left out of an If-Modified-Since answer: unchanged. Left out of a
        // plain one: not found by its ID, which is not the same as deleted,
        // so the row is left exactly as it is.
        if (step.since) unchanged.push(row.id);
        continue;
      }
      const seen = fromXero(inv);
      if (!seen) {
        logger.warn('Xero answered with a status this app does not know', { userId, tenantId, status: inv.status });
        continue;
      }
      const changed = store.recordXeroStatus(row.id, row.xeroInvoiceId, { ...seen, tenantId }, syncedAt);
      if (changed === null) continue; // the row changed under us; nothing written
      counts.checked++;
      if (changed) counts.updated++;
    }
    counts.checked += store.markXeroChecked(unchanged, syncedAt);
  }

  _recordSuccess(userId, tenantId, startedAt.toISOString());
}

async function _syncUser(userId, { now = () => new Date() } = {}) {
  const counts = { checked: 0, updated: 0, failedTenants: 0 };
  const rows = require('../utils/invoice-store').forUser(userId).listInXero()
    .filter(r => !FINAL_STATUSES.has(r.xeroStatus));
  if (!rows.length) return counts;

  // The companies on file, not a fresh list from Xero: listing them would be
  // a call of its own, and a company removed on Xero's side is dropped from
  // this list by the next reconnect (token-cache pruneTenants).
  const connected = require('../utils/token-cache').getPersistedTenants(userId) || [];
  if (!connected.length) return counts;

  const { groups, skipped } = _groupByTenant(userId, rows, connected);
  if (skipped) logger.info('Xero status check left out rows with no company to ask', { userId, skipped });

  const tenantIds = [...groups.keys()];
  for (let i = 0; i < tenantIds.length; i++) {
    const tenantId = tenantIds[i];
    try {
      await _syncTenant(userId, tenantId, groups.get(tenantId), counts, now);
    } catch (err) {
      counts.failedTenants++;
      let error;
      try { error = xeroErrMsg(err); } catch (_) { error = err && err.message; }
      if (isReconnectError(err)) {
        counts.failedTenants += tenantIds.length - i - 1;
        logger.warn('Xero status check stopped: the connection needs reconnecting', { userId, error });
        break;
      }
      if (err && err.code === 'XERO_DAILY_LIMIT') {
        logger.warn('Xero status check stopped for this company: daily limit reached', { userId, tenantId, error });
      } else {
        logger.warn('Xero status check failed for this company', { userId, tenantId, error });
      }
    }
  }

  logger.info('Xero status check finished', { userId, ...counts });
  return counts;
}

const _running = new Map(); // userId -> Promise

/**
 * Reads back the Xero status of every posted record this user has. Resolves
 * with { checked, updated, failedTenants }: records Xero confirmed (changed or
 * not), records whose stored status or amounts changed, and companies that
 * could not be read this time. A Xero failure never rejects; only something
 * like an unreadable database does.
 */
function syncUser(userId, opts = {}) {
  const key = String(userId);
  if (!_running.has(key)) {
    _running.set(key, _syncUser(key, opts).finally(() => _running.delete(key)));
  }
  return _running.get(key);
}

module.exports = { syncUser, repostRefusal, fromXero, BATCH_SIZE, CLOCK_SLACK_MS, XERO_STATUSES };
