const db = require('../db');
const { newId } = require('./ids');

// What a person adds to or changes in the Cash Flow Manager, per Xero
// organisation (xero/cash-manager.js reads it on every build). Three tables:
// entries Xero does not know about, overrides of single projected items, and
// options for each bank account. Nothing here talks to Xero.
//
// The checks live here, beside the writes, so the route answers a bad value
// with a 400 that says what was wrong and nothing can reach the table that the
// projection would then have to second-guess. Money is held in whole cents of
// the organisation's base currency.

const DIRECTIONS  = new Set(['in', 'out']);
// Quarterly is there for GST and BAS returns, which are paid every three months.
const FREQUENCIES = ['once', 'daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];
const MAX_AMOUNT  = 1e9;
const MAX_DESCRIPTION = 120;
// Ceilings, not expectations: a projection with thousands of hand entries is a
// spreadsheet pasted in a loop, and every one of them is read on every build.
const MAX_ENTRIES   = 500;
const MAX_OVERRIDES = 5000;
const MAX_ACCOUNTS  = 200;

// The four kinds of item the projection makes, and nothing else, so an
// override can only ever be stored against something that can match it.
const ID = '[A-Za-z0-9-]{1,64}';
const DAY = '\\d{4}-\\d{2}-\\d{2}';
const KEY_PATTERNS = [
  new RegExp(`^invoice:${ID}$`),
  new RegExp(`^payment:${ID}$`),
  new RegExp(`^repeating:${ID}:(${DAY})$`),
  new RegExp(`^manual:${ID}:(${DAY})$`),
];

class InputError extends Error {
  constructor(message) { super(message); this.name = 'CashManagerInputError'; }
}
const isInputError = err => !!err && err.name === 'CashManagerInputError';

// A real calendar day as YYYY-MM-DD. 2026-02-30 matches the pattern and is not
// a day; it would land on 2 March without a word.
function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1990 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// An amount as typed: a number, or a plain decimal string, to the cent. More
// places than that would be rounded somewhere the person cannot see, so it is
// refused rather than rounded here.
function _cents(value, what, { allowZero = false, allowNegative = false } = {}) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) n = Number(value.trim());
  else throw new InputError(`${what} must be a number`);
  if (!Number.isFinite(n)) throw new InputError(`${what} must be a number`);
  if (!allowNegative && n < 0) throw new InputError(`${what} cannot be negative`);
  if (!allowZero && n === 0) throw new InputError(`${what} must be more than 0`);
  if (Math.abs(n) > MAX_AMOUNT) throw new InputError(`${what} cannot be more than 1,000,000,000`);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) throw new InputError(`${what} can have at most two decimal places`);
  return cents;
}

// Pure. An entry as the route was given it, checked whole: a PATCH is merged
// over the stored entry first, so a change cannot leave an end date before the
// start, or a once-off with an end date.
function validateEntry(input = {}) {
  const direction = input.direction;
  if (!DIRECTIONS.has(direction)) throw new InputError('direction must be in or out');
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!description) throw new InputError('description is required');
  if (description.length > MAX_DESCRIPTION) throw new InputError(`description can be at most ${MAX_DESCRIPTION} characters`);
  const amountCents = _cents(input.amount, 'amount');
  if (!isDay(input.date)) throw new InputError('date must be a date as YYYY-MM-DD');
  const frequency = input.frequency === undefined ? 'once' : input.frequency;
  if (!FREQUENCIES.includes(frequency)) throw new InputError(`frequency must be one of ${FREQUENCIES.join(', ')}`);
  // A once-off happens on its date and nowhere else; an end date on it means
  // nothing, so it is not kept to be misread later.
  const endDate = frequency === 'once' || input.endDate === undefined || input.endDate === null || input.endDate === ''
    ? null : input.endDate;
  if (endDate !== null) {
    if (!isDay(endDate)) throw new InputError('endDate must be a date as YYYY-MM-DD');
    if (endDate < input.date) throw new InputError('endDate cannot be before date');
  }
  return { direction, description, amountCents, date: input.date, frequency, endDate };
}

function validateKey(key) {
  if (typeof key !== 'string' || key.length > 200 || !KEY_PATTERNS.some(re => re.test(key))) {
    throw new InputError('key must be an item key from the cash manager (invoice:…, repeating:…:date, manual:…:date or payment:…)');
  }
  const day = KEY_PATTERNS.map(re => re.exec(key)).find(Boolean)?.[1];
  if (day && !isDay(day)) throw new InputError('key carries a date that does not exist');
  return key;
}

// Pure. One override's fields as given: undefined leaves a field as it was,
// null clears it. Zero is a real amount (the item is expected to settle for
// nothing), unlike an entry, which has to move some money.
function validateOverride(input = {}) {
  const out = {};
  if (input.date !== undefined) {
    if (input.date !== null && !isDay(input.date)) throw new InputError('date must be a date as YYYY-MM-DD, or null');
    out.date = input.date;
  }
  if (input.amount !== undefined) {
    out.amountCents = input.amount === null ? null : _cents(input.amount, 'amount', { allowZero: true });
  }
  if (input.excluded !== undefined) {
    if (typeof input.excluded !== 'boolean') throw new InputError('excluded must be true or false');
    out.excluded = input.excluded;
  }
  return out;
}

// Pure. A bank account's options as given, over what is stored (or the
// defaults). The adjustment may go either way; an overdraft is a limit, so it
// is a positive figure or none.
function validateBankOption(input, current = { included: true, openingAdjustmentCents: 0, overdraftCents: 0 }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('each account must be an object of options');
  const out = { ...current };
  if (input.included !== undefined) {
    if (typeof input.included !== 'boolean') throw new InputError('included must be true or false');
    out.included = input.included;
  }
  if (input.openingAdjustment !== undefined) {
    out.openingAdjustmentCents = input.openingAdjustment === null ? 0
      : _cents(input.openingAdjustment, 'openingAdjustment', { allowZero: true, allowNegative: true });
  }
  if (input.overdraft !== undefined) {
    out.overdraftCents = input.overdraft === null ? 0 : _cents(input.overdraft, 'overdraft', { allowZero: true });
  }
  return out;
}

function validateAccountId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new InputError('account ids must be non-empty text');
  return id;
}

const _entryOut = r => ({
  id: r.id, direction: r.direction, description: r.description,
  amount: r.amount_cents / 100, amountCents: r.amount_cents,
  date: r.date, frequency: r.frequency, endDate: r.end_date || null,
  createdBy: r.created_by_email || null, createdAt: r.created_at, updatedAt: r.updated_at,
});
const _overrideOut = r => ({
  key: r.item_key, date: r.date || null,
  amount: r.amount_cents === null || r.amount_cents === undefined ? null : r.amount_cents / 100,
  amountCents: r.amount_cents === null || r.amount_cents === undefined ? null : r.amount_cents,
  excluded: !!r.excluded, updatedBy: r.updated_by_email || null, updatedAt: r.updated_at,
});
const _bankOut = r => ({
  included: !!r.included,
  openingAdjustment: r.opening_adjustment_cents / 100, openingAdjustmentCents: r.opening_adjustment_cents,
  overdraft: r.overdraft_cents / 100, overdraftCents: r.overdraft_cents,
});

// Everything is read and written for one person and one organisation at a
// time; no statement here takes a user or tenant from anywhere else.
function forTenant(userId, tenantId) {
  if (!userId || !tenantId) throw new Error('cash-manager-store needs a user and a tenant');
  const now = () => new Date().toISOString();

  function listEntries() {
    return db.prepare(`SELECT * FROM cash_manager_entries WHERE user_id = ? AND tenant_id = ?
                       ORDER BY date, created_at, id`).all(userId, tenantId).map(_entryOut);
  }
  function getEntry(id) {
    const r = db.prepare('SELECT * FROM cash_manager_entries WHERE id = ? AND user_id = ? AND tenant_id = ?').get(String(id), userId, tenantId);
    return r ? _entryOut(r) : null;
  }
  function addEntry(input, { email = null } = {}) {
    const e = validateEntry(input);
    const count = db.prepare('SELECT COUNT(*) AS n FROM cash_manager_entries WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId).n;
    if (count >= MAX_ENTRIES) throw new InputError(`An organisation can have at most ${MAX_ENTRIES} entries`);
    const id = newId(), at = now();
    db.prepare(`INSERT INTO cash_manager_entries
      (id, user_id, tenant_id, direction, description, amount_cents, date, frequency, end_date, created_by_email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, tenantId, e.direction, e.description, e.amountCents, e.date, e.frequency, e.endDate, email, at, at);
    return getEntry(id);
  }
  // Merged over the stored entry, in the units the route speaks (amount, not
  // cents), and checked whole. Null when there is no such entry here.
  function updateEntry(id, patch = {}) {
    const cur = getEntry(id);
    if (!cur) return null;
    const merged = {
      direction: cur.direction, description: cur.description, amount: cur.amount,
      date: cur.date, frequency: cur.frequency, endDate: cur.endDate,
    };
    for (const k of Object.keys(merged)) if (patch[k] !== undefined) merged[k] = patch[k];
    const e = validateEntry(merged);
    db.prepare(`UPDATE cash_manager_entries SET direction = ?, description = ?, amount_cents = ?, date = ?, frequency = ?,
                end_date = ?, updated_at = ? WHERE id = ? AND user_id = ? AND tenant_id = ?`)
      .run(e.direction, e.description, e.amountCents, e.date, e.frequency, e.endDate, now(), cur.id, userId, tenantId);
    return getEntry(cur.id);
  }
  // The entry's overrides go with it: they are keyed by its id and could only
  // ever match it.
  function deleteEntry(id) {
    return db.transaction(() => {
      const gone = db.prepare('DELETE FROM cash_manager_entries WHERE id = ? AND user_id = ? AND tenant_id = ?').run(String(id), userId, tenantId).changes > 0;
      if (gone) {
        db.prepare("DELETE FROM cash_manager_overrides WHERE user_id = ? AND tenant_id = ? AND item_key LIKE ? ESCAPE '\\'")
          .run(userId, tenantId, `manual:${String(id).replace(/[\\%_]/g, c => `\\${c}`)}:%`);
      }
      return gone;
    })();
  }

  // As a map by item key, which is how the projection looks them up.
  function overrides() {
    const out = {};
    for (const r of db.prepare('SELECT * FROM cash_manager_overrides WHERE user_id = ? AND tenant_id = ?').all(userId, tenantId)) {
      out[r.item_key] = _overrideOut(r);
    }
    return out;
  }
  function getOverride(key) {
    const r = db.prepare('SELECT * FROM cash_manager_overrides WHERE user_id = ? AND tenant_id = ? AND item_key = ?').get(userId, tenantId, key);
    return r ? _overrideOut(r) : null;
  }
  // Fields left out keep what was stored; an override left with nothing set
  // overrides nothing, so it is removed and null is answered.
  function setOverride(key, input, { email = null } = {}) {
    validateKey(key);
    const fields = validateOverride(input);
    if (!Object.keys(fields).length) throw new InputError('Give a date, an amount or excluded');
    const cur = getOverride(key);
    const next = {
      date: fields.date !== undefined ? fields.date : cur?.date ?? null,
      amountCents: fields.amountCents !== undefined ? fields.amountCents : cur?.amountCents ?? null,
      excluded: fields.excluded !== undefined ? fields.excluded : !!cur?.excluded,
    };
    if (next.date === null && next.amountCents === null && !next.excluded) {
      deleteOverride(key);
      return null;
    }
    if (!cur) {
      const count = db.prepare('SELECT COUNT(*) AS n FROM cash_manager_overrides WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId).n;
      if (count >= MAX_OVERRIDES) throw new InputError(`An organisation can have at most ${MAX_OVERRIDES} changed items`);
    }
    db.prepare(`INSERT INTO cash_manager_overrides (user_id, tenant_id, item_key, date, amount_cents, excluded, updated_by_email, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, tenant_id, item_key) DO UPDATE SET
                  date = excluded.date, amount_cents = excluded.amount_cents, excluded = excluded.excluded,
                  updated_by_email = excluded.updated_by_email, updated_at = excluded.updated_at`)
      .run(userId, tenantId, key, next.date, next.amountCents, next.excluded ? 1 : 0, email, now());
    return getOverride(key);
  }
  function deleteOverride(key) {
    return db.prepare('DELETE FROM cash_manager_overrides WHERE user_id = ? AND tenant_id = ? AND item_key = ?').run(userId, tenantId, String(key)).changes > 0;
  }

  // As a map by account id. An account with no row is on the defaults, and is
  // simply absent here; the projection fills them in.
  function bankOptions() {
    const out = {};
    for (const r of db.prepare('SELECT * FROM cash_manager_bank_options WHERE user_id = ? AND tenant_id = ?').all(userId, tenantId)) {
      out[r.account_id] = _bankOut(r);
    }
    return out;
  }
  // Every account given is checked before any is written, so a bad value
  // halfway through the list leaves nothing half-saved.
  function setBankOptions(accounts) {
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) throw new InputError('accounts must be an object keyed by account id');
    const ids = Object.keys(accounts);
    if (ids.length > MAX_ACCOUNTS) throw new InputError(`At most ${MAX_ACCOUNTS} accounts at once`);
    const stored = bankOptions();
    const rows = ids.map(id => {
      validateAccountId(id);
      const cur = stored[id];
      return [id, validateBankOption(accounts[id], cur
        ? { included: cur.included, openingAdjustmentCents: cur.openingAdjustmentCents, overdraftCents: cur.overdraftCents }
        : undefined)];
    });
    const put = db.prepare(`INSERT INTO cash_manager_bank_options (user_id, tenant_id, account_id, included, opening_adjustment_cents, overdraft_cents)
                            VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT (user_id, tenant_id, account_id) DO UPDATE SET
                              included = excluded.included, opening_adjustment_cents = excluded.opening_adjustment_cents,
                              overdraft_cents = excluded.overdraft_cents`);
    db.transaction(() => {
      for (const [id, o] of rows) put.run(userId, tenantId, id, o.included ? 1 : 0, o.openingAdjustmentCents, o.overdraftCents);
    })();
    return bankOptions();
  }

  return {
    listEntries, getEntry, addEntry, updateEntry, deleteEntry,
    overrides, getOverride, setOverride, deleteOverride,
    bankOptions, setBankOptions,
  };
}

module.exports = {
  forTenant, validateEntry, validateOverride, validateKey, validateBankOption, isDay, isInputError, InputError,
  FREQUENCIES, MAX_ENTRIES, MAX_OVERRIDES, MAX_DESCRIPTION, MAX_AMOUNT,
};
