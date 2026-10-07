// The audit trail: what happened to each record, and what admins did to
// accounts, kept in invoice_events and admin_events (db/schema.sql).
//
// Recording never gets in the way of the thing being recorded. Every write is
// one INSERT in the same database, made after the action's own write, outside
// any transaction of its own, and a write that fails is a warning in the log:
// the bill is still saved, sent or deleted. An action that went through with
// no event is a gap in the history; an action refused because its history
// could not be written would be an outage.
//
// What goes in: who (the account owner, an admin, or the system), when, a
// short sentence a bookkeeper can read, and the facts behind it as JSON. What
// never goes in: passwords, tokens, keys, file contents, or long free text.
const db     = require('../db');
const logger = require('./logger');
const auditContext = require('./audit-context');

// Two years, the longest anyone has asked to look back. Pruned at boot
// (main/index.js); an indexed range DELETE, so cheap however large the tables.
const RETENTION_DAYS = 730;

// One page of history. The review page shows a record's whole life in one
// page nearly always; the cap is what keeps a pathological record (an import
// edited a thousand times) from being one enormous answer.
const PAGE_MAX = 200;

const SUMMARY_MAX = 300;
const DETAILS_MAX = 4000;

// Statements are prepared on first use rather than at load: in tests the
// database is created after this module is required, and a statement
// prepared against a table that does not exist yet would throw at require.
const _stmts = new Map();
function _stmt(sql) {
  let s = _stmts.get(sql);
  if (!s) { s = db.prepare(sql); _stmts.set(sql, s); }
  return s;
}

function _clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Details as stored. Too large to be a few facts means something long got in
// by mistake; it is dropped rather than kept whole.
function _json(details) {
  if (details === undefined || details === null) return null;
  try {
    const text = JSON.stringify(details);
    return text.length > DETAILS_MAX ? JSON.stringify({ truncated: true }) : text;
  } catch (_) {
    return null;
  }
}

function _parse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

// ── Writing ──────────────────────────────────────────────────────────────────

// One event on one record. `actor` defaults to whoever the current context
// says is acting on this owner's record (audit-context.actorFor). A bulk
// marker, in the context or in the details, is added to both the details and
// the sentence, so each of the records a bulk action touched says so.
// Returns true when written.
function recordInvoiceEvent({ userId, invoiceId, action, summary, details = null, actor = null }) {
  try {
    if (!userId || !invoiceId || !action) return false;
    const who  = actor || auditContext.actorFor(userId);
    const ctx  = auditContext.current();
    const bulk = (details && details.bulk) || (ctx && ctx.bulk) || null;
    let text   = String(summary || action);
    let facts  = details;
    if (bulk) {
      facts = { ...(facts || {}), bulk };
      text  = `${text} (part of ${BULK_LABELS[bulk] || 'a bulk action'})`;
    }
    // What was going on, when the context says ("Receipt read: changed
    // vendor and total"). Not for an event given its own actor: what Xero
    // reports is Xero's, whatever the context was doing.
    if (ctx && ctx.via && !actor && !text.startsWith(ctx.via)) {
      text = `${ctx.via}: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    }
    _stmt(`
      INSERT INTO invoice_events (user_id, invoice_id, at, actor_type, actor_id, actor_email, action, summary, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(userId), String(invoiceId), new Date().toISOString(), who.type, who.id ?? null, who.email ?? null,
      String(action), _clip(text, SUMMARY_MAX), _json(facts));
    return true;
  } catch (err) {
    logger.warn('Audit event not recorded', { userId, invoiceId, action, error: err.message });
    return false;
  }
}

// What an admin did to an account, or a person to their own password. The
// actor and target are copied as text (id and email), so the event still
// says who after either account is deleted.
function recordAdminEvent({ actor, target = null, action, details = null }) {
  try {
    if (!action) return false;
    _stmt(`
      INSERT INTO admin_events (at, actor_id, actor_email, target_user_id, target_email, action, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), actor?.id != null ? String(actor.id) : null, actor?.email || null,
      target?.id != null ? String(target.id) : null, target?.email || null, String(action), _json(details));
    return true;
  } catch (err) {
    logger.warn('Admin audit event not recorded', { action, error: err.message });
    return false;
  }
}

// Runs fn, which describes and records events, so that a mistake in the
// describing is a warning too and never reaches the action that called it.
function safely(fn, what = 'Audit event') {
  try { fn(); } catch (err) { logger.warn(`${what} not recorded`, { error: err.message }); }
}

// ── Reading ──────────────────────────────────────────────────────────────────

function _limit(limit) {
  const n = Number(limit);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, PAGE_MAX) : PAGE_MAX;
}

// One page, newest first, and the cursor for the next: events are paged by
// id, which only ever grows, so a page asked for while new events arrive
// neither repeats nor skips one.
function _page(rows, limit, map) {
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return { events: page.map(map), nextBefore: more ? page[page.length - 1].id : null };
}

function _invoiceEvent(r) {
  return {
    id: r.id, at: r.at, actorType: r.actor_type, actorId: r.actor_id, actorEmail: r.actor_email,
    action: r.action, summary: r.summary, details: _parse(r.details),
  };
}

// One record's history. userId limits it to that owner's events (null: any
// owner, for an admin); invoiceId need not exist any more.
function listInvoiceEvents({ invoiceId, userId = null, before = null, limit = PAGE_MAX }) {
  const n = _limit(limit);
  const where = ['invoice_id = ?'];
  const args  = [String(invoiceId)];
  if (userId !== null && userId !== undefined) { where.push('user_id = ?'); args.push(String(userId)); }
  if (before) { where.push('id < ?'); args.push(Number(before)); }
  const rows = db.prepare(`SELECT * FROM invoice_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...args, n + 1);
  return _page(rows, n, _invoiceEvent);
}

// ── Admin events ─────────────────────────────────────────────────────────────

// Every kind of admin event, with the label the Activity tab filters by.
const ADMIN_ACTIONS = {
  'user.create':           'Created a user',
  'user.delete':           'Deleted a user',
  'user.role':             'Changed a role',
  'user.password_reset':   'Reset a password',
  'user.sign_out':         'Signed a user out everywhere',
  'user.disable':          'Disabled an account',
  'user.enable':           'Enabled an account',
  'user.auto_process_off': 'Turned auto-submit off',
  'user.watcher_stop':     'Stopped a mailbox watcher',
  'report.resolve':        'Resolved a report',
  'password.change':       'Changed own password',
};

// The sentence for one admin event, from its kind and facts. Kept out of the
// table so the wording can improve without rewriting history.
function describeAdminEvent(action, details, targetEmail) {
  const d = details || {};
  const who = targetEmail || 'an account';
  switch (action) {
    case 'user.create':           return `Created ${who}${d.role === 'admin' ? ' as an admin' : ''}`;
    case 'user.delete':           return `Deleted ${who}${d.role === 'admin' ? ' (an admin)' : ''}`;
    case 'user.role':             return `Changed ${who} from ${d.from || '?'} to ${d.to || '?'}`;
    case 'user.password_reset':   return `Reset the password of ${who}`;
    case 'user.sign_out':         return `Signed ${who} out everywhere`;
    case 'user.disable':          return `Disabled ${who}${d.watcherStopped ? ' and stopped its mailbox watcher' : ''}`;
    case 'user.enable':           return `Enabled ${who}`;
    case 'user.auto_process_off': return `Turned auto-submit off for ${who}`;
    case 'user.watcher_stop':     return `Stopped the mailbox watcher of ${who}${d.wasRunning === false ? ' (it was not connected)' : ''}`;
    case 'report.resolve': {
      const what = [d.vendorName, d.invoiceNumber].filter(Boolean).join(' ') || d.invoiceId || 'a record';
      return `Resolved the report on ${what} for ${who}`;
    }
    case 'password.change':       return 'Changed their own password';
    default:                      return ADMIN_ACTIONS[action] || action;
  }
}

function _adminEvent(r) {
  const details = _parse(r.details);
  return {
    id: r.id, at: r.at, actorId: r.actor_id, actorEmail: r.actor_email,
    targetUserId: r.target_user_id, targetEmail: r.target_email, action: r.action,
    summary: describeAdminEvent(r.action, details, r.target_email), details,
  };
}

// Filters: the account acted on, the kind, and a window of time (ISO
// instants, from inclusive, to exclusive). Newest first, paged as above.
function listAdminEvents({ targetUserId = null, action = null, from = null, to = null, before = null, limit = PAGE_MAX } = {}) {
  const n = _limit(limit);
  const where = [];
  const args  = [];
  if (targetUserId) { where.push('target_user_id = ?'); args.push(String(targetUserId)); }
  if (action)       { where.push('action = ?');         args.push(String(action)); }
  if (from)         { where.push('at >= ?');            args.push(from); }
  if (to)           { where.push('at < ?');             args.push(to); }
  if (before)       { where.push('id < ?');             args.push(Number(before)); }
  const sql = `SELECT * FROM admin_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return _page(db.prepare(sql).all(...args, n + 1), n, _adminEvent);
}

// ── Retention ────────────────────────────────────────────────────────────────

// Deletes events older than the retention period from both tables. Returns
// how many went. Never throws: a prune that fails is tried again next boot.
function pruneOldEvents({ days = RETENTION_DAYS, now = Date.now() } = {}) {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const invoices = db.prepare('DELETE FROM invoice_events WHERE at < ?').run(cutoff).changes;
    const admin    = db.prepare('DELETE FROM admin_events WHERE at < ?').run(cutoff).changes;
    if (invoices || admin) logger.info('Old audit events pruned', { invoices, admin, olderThan: cutoff });
    return { invoices, admin };
  } catch (err) {
    logger.warn('Audit events could not be pruned', { error: err.message });
    return { invoices: 0, admin: 0 };
  }
}

// What each bulk marker is called in a sentence (audit-context.withMarker).
const BULK_LABELS = {
  review:        'a bulk Mark reviewed',
  send:          'a bulk Send to Xero',
  delete:        'a bulk delete',
  status:        'a bulk status change',
  'submit-all':  'Submit all',
  'clear-all':   'Clear all',
  'undo-import': 'undoing an import',
};

module.exports = {
  recordInvoiceEvent, recordAdminEvent, safely, listInvoiceEvents, listAdminEvents, describeAdminEvent,
  pruneOldEvents, ADMIN_ACTIONS, BULK_LABELS, RETENTION_DAYS, PAGE_MAX,
};
