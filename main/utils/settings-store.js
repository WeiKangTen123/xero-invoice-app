const db = require('../db');

// Off by default — see db/migrate-autoprocess-default.js. Posting to someone's
// books is not something an account should inherit without asking.
//
// defaultTenantId is the Xero company a new document goes to when more than
// one is connected (queue/processor.js). Null until someone picks one.
//
// recurringAccounts and notRecurringAccounts are revenue account labels the
// person has marked recurring or not recurring on the Revenue tab, overriding
// the guess the reports make from the account's name (xero/reports.js
// _recurringFor). Two lists, because a mark goes either way: a single list of
// recurring accounts could not say "this one is not", short of becoming the
// whole answer for every account, including ones in another connected
// organisation that the person never looked at.
const DEFAULTS = { autoProcess: false, defaultTenantId: null, recurringAccounts: [], notRecurringAccounts: [] };

function _toRow(userId) {
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 0)').run(userId);
  const row = db.prepare('SELECT auto_process, default_tenant_id FROM user_settings WHERE user_id = ?').get(userId);
  return { ...DEFAULTS, autoProcess: !!row.auto_process, defaultTenantId: row.default_tenant_id || null, ..._readMarks(userId) };
}

// Stored in user_settings.recurring_accounts as a JSON array of
// { label, recurring } — one entry per marked account. A plain array of labels
// is read as all recurring, so a value written in that simpler shape is not
// lost.
const _labelKey = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

function _marksFrom(raw) {
  const out = { recurringAccounts: [], notRecurringAccounts: [] };
  let list;
  try { list = raw ? JSON.parse(raw) : []; } catch { return out; }
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    const entry = typeof e === 'string' ? { label: e, recurring: true } : e;
    const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
    if (!label) continue;
    out[entry.recurring === false ? 'notRecurringAccounts' : 'recurringAccounts'].push(label);
  }
  return out;
}

// The column is added by a migration (db/migrate.js). On a database that has
// not run it yet there is simply nothing marked, rather than a settings page
// or a report that fails.
const _noColumn = err => /no such column/i.test(String(err?.message || ''));

function _readMarks(userId) {
  try {
    const row = db.prepare('SELECT recurring_accounts FROM user_settings WHERE user_id = ?').get(userId);
    return _marksFrom(row?.recurring_accounts);
  } catch (err) {
    if (_noColumn(err)) return { recurringAccounts: [], notRecurringAccounts: [] };
    throw err;
  }
}

// Trimmed, empties dropped, one copy of each label (case and spacing ignored,
// as the reports match them).
function _cleanLabels(list) {
  const seen = new Set(), out = [];
  for (const v of list || []) {
    const label = String(v || '').trim();
    if (!label || seen.has(_labelKey(label))) continue;
    seen.add(_labelKey(label));
    out.push(label);
  }
  return out;
}

// Raised when the marks cannot be saved because the column is not there yet.
class RecurringUnavailableError extends Error {
  constructor() {
    super('Recurring account marks cannot be saved until the database is migrated');
    this.name = 'RecurringUnavailableError';
  }
}

function forUser(userId) {
  function read() { return _toRow(userId); }

  function get(key) { const s = read(); return key ? s[key] : s; }

  // One transaction, so a patch that cannot be saved in full (the marks
  // without their column) changes nothing at all.
  const _write = db.transaction(patch => {
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 0)').run(userId);
    if ('autoProcess' in patch) {
      db.prepare('UPDATE user_settings SET auto_process = ? WHERE user_id = ?')
        .run(patch.autoProcess ? 1 : 0, userId);
    }
    // Whether the id is a company this account actually has connected is the
    // route's question (routes/process.js); here an empty value clears it.
    if ('defaultTenantId' in patch) {
      db.prepare('UPDATE user_settings SET default_tenant_id = ? WHERE user_id = ?')
        .run(patch.defaultTenantId ? String(patch.defaultTenantId) : null, userId);
    }
    // Whether each list is a list of strings is the route's question. A list
    // given here replaces the stored one; a label it names comes off the
    // other, stored, list, so marking an account one way undoes a mark the
    // other way rather than leaving it on both.
    if ('recurringAccounts' in patch || 'notRecurringAccounts' in patch) {
      const cur = _readMarks(userId);
      let rec = 'recurringAccounts' in patch ? _cleanLabels(patch.recurringAccounts) : cur.recurringAccounts;
      let not = 'notRecurringAccounts' in patch ? _cleanLabels(patch.notRecurringAccounts) : cur.notRecurringAccounts;
      const keys = list => new Set(list.map(_labelKey));
      if (!('notRecurringAccounts' in patch)) { const k = keys(rec); not = not.filter(l => !k.has(_labelKey(l))); }
      if (!('recurringAccounts' in patch))    { const k = keys(not); rec = rec.filter(l => !k.has(_labelKey(l))); }
      const entries = [...rec.map(label => ({ label, recurring: true })), ...not.map(label => ({ label, recurring: false }))];
      try {
        db.prepare('UPDATE user_settings SET recurring_accounts = ? WHERE user_id = ?')
          .run(entries.length ? JSON.stringify(entries) : null, userId);
      } catch (err) {
        if (_noColumn(err)) throw new RecurringUnavailableError();
        throw err;
      }
    }
  });

  function set(patch) {
    _write(patch || {});
    return read();
  }

  // The recurring marks alone, read without creating a settings row: the
  // reports ask on every load, and a read should not write.
  function recurringOverrides() { return _readMarks(userId); }

  // Whether this account wants its mailbox watched. Kept apart from get() and
  // set(): it is not a preference edited on the settings page but the
  // Start/Stop state, written by routes/process.js and email/watcher-registry.js
  // and read at boot so a restart puts every mailbox back the way its owner
  // left it.
  function watcherEnabled() {
    const row = db.prepare('SELECT watcher_enabled FROM user_settings WHERE user_id = ?').get(userId);
    return !!(row && row.watcher_enabled);
  }

  function setWatcherEnabled(on) {
    // Clearing never inserts: a stop for an account being deleted must not
    // recreate its row.
    if (on) db.prepare('INSERT OR IGNORE INTO user_settings (user_id, auto_process) VALUES (?, 0)').run(userId);
    db.prepare('UPDATE user_settings SET watcher_enabled = ? WHERE user_id = ?').run(on ? 1 : 0, userId);
  }

  return { get, set, recurringOverrides, watcherEnabled, setWatcherEnabled };
}

// Every account whose owner left the mailbox watcher switched on, oldest row
// first so a resume at boot goes in a stable order.
function watcherEnabledUserIds() {
  return db.prepare('SELECT user_id FROM user_settings WHERE watcher_enabled = 1 ORDER BY rowid').all().map(r => r.user_id);
}

module.exports = { forUser, watcherEnabledUserIds, RecurringUnavailableError };
