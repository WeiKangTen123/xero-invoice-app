// The Cash Flow Manager's own rows: entries, overrides and bank options, kept
// per person and organisation, checked before they are written. The real
// store against the test database; nothing here touches Xero.
const db = require('../db');
require('../db/migrate').run();
const users = require('./users');
const store = require('./cash-manager-store');

let userId, other, n = 0;
beforeEach(async () => {
  const u = await users.createUser(`cms${Date.now()}-${n++}@test.com`, 'password123', 'user');
  const o = await users.createUser(`cms-other${Date.now()}-${n++}@test.com`, 'password123', 'user');
  userId = u.id; other = o.id;
});

const ENTRY = { direction: 'out', description: 'Office rent', amount: 2500, date: '2026-11-01', frequency: 'monthly' };
const refused = (fn, re) => {
  let err;
  try { fn(); } catch (e) { err = e; }
  expect(store.isInputError(err)).toBe(true);
  expect(err.message).toMatch(re);
};

describe('entries', () => {
  test('added, listed, changed and deleted, in cents underneath', () => {
    const s = store.forTenant(userId, 't1');
    const e = s.addEntry(ENTRY, { email: 'me@test.com' });
    expect(e).toMatchObject({ direction: 'out', description: 'Office rent', amount: 2500, amountCents: 250000, date: '2026-11-01', frequency: 'monthly', endDate: null, createdBy: 'me@test.com' });
    expect(s.listEntries()).toEqual([e]);

    const changed = s.updateEntry(e.id, { amount: '99.95', endDate: '2027-03-01' });
    expect(changed).toMatchObject({ amount: 99.95, amountCents: 9995, endDate: '2027-03-01', description: 'Office rent' });
    expect(s.updateEntry('nope', { amount: 1 })).toBeNull();

    expect(s.deleteEntry(e.id)).toBe(true);
    expect(s.deleteEntry(e.id)).toBe(false);
    expect(s.listEntries()).toEqual([]);
  });

  test('each person and organisation sees only its own', () => {
    const e = store.forTenant(userId, 't1').addEntry(ENTRY);
    expect(store.forTenant(userId, 't2').listEntries()).toEqual([]);
    expect(store.forTenant(other, 't1').listEntries()).toEqual([]);
    expect(store.forTenant(other, 't1').getEntry(e.id)).toBeNull();
    expect(store.forTenant(other, 't1').deleteEntry(e.id)).toBe(false);
    expect(store.forTenant(other, 't1').updateEntry(e.id, { amount: 1 })).toBeNull();
    expect(store.forTenant(userId, 't1').getEntry(e.id)).not.toBeNull();
  });

  test.each([
    [{ direction: 'sideways' },             /direction must be in or out/],
    [{ description: '   ' },                /description is required/],
    [{ description: 'x'.repeat(121) },      /at most 120 characters/],
    [{ amount: 0 },                         /more than 0/],
    [{ amount: -5 },                        /cannot be negative/],
    [{ amount: 1e9 + 1 },                   /cannot be more than 1,000,000,000/],
    [{ amount: 10.005 },                    /at most two decimal places/],
    [{ amount: 'ten' },                     /must be a number/],
    [{ amount: Infinity },                  /must be a number/],
    [{ date: '2026-02-30' },                /date must be a date/],
    [{ date: '01/11/2026' },                /date must be a date/],
    [{ frequency: 'hourly' },               /frequency must be one of once, daily, weekly, fortnightly, monthly, yearly/],
    [{ endDate: '2026-10-01' },             /endDate cannot be before date/],
    [{ endDate: 'soon' },                   /endDate must be a date/],
  ])('%o is refused', (bad, re) => {
    refused(() => store.forTenant(userId, 't1').addEntry({ ...ENTRY, ...bad }), re);
    expect(store.forTenant(userId, 't1').listEntries()).toEqual([]);
  });

  test('a once-off keeps no end date; 120 characters, 1e9 and two places are allowed', () => {
    const e = store.forTenant(userId, 't1').addEntry({ ...ENTRY, frequency: 'once', endDate: '2025-01-01', description: 'x'.repeat(120), amount: 1e9 });
    expect(e).toMatchObject({ endDate: null, amount: 1e9 });
    // 0.1 + 0.2 is 0.30000000000000004: still 30 cents, not a third decimal place.
    expect(store.validateEntry({ ...ENTRY, amount: 0.1 + 0.2 }).amountCents).toBe(30);
  });

  test('a change is checked whole, against what is stored', () => {
    const s = store.forTenant(userId, 't1');
    const e = s.addEntry({ ...ENTRY, endDate: '2027-01-01' });
    refused(() => s.updateEntry(e.id, { date: '2027-02-01' }), /endDate cannot be before date/);
    expect(s.getEntry(e.id).date).toBe('2026-11-01');
  });

  test('deleting an entry takes its overrides with it, and only its own', () => {
    const s = store.forTenant(userId, 't1');
    const a = s.addEntry(ENTRY), b = s.addEntry(ENTRY);
    s.setOverride(`manual:${a.id}:2026-11-01`, { excluded: true });
    s.setOverride(`manual:${b.id}:2026-11-01`, { excluded: true });
    s.deleteEntry(a.id);
    expect(Object.keys(s.overrides())).toEqual([`manual:${b.id}:2026-11-01`]);
  });

  test('a ceiling on how many', () => {
    const s = store.forTenant(userId, 't-many');
    const insert = db.prepare(`INSERT INTO cash_manager_entries (id, user_id, tenant_id, direction, description, amount_cents, date, frequency, created_at, updated_at)
                               VALUES (?, ?, 't-many', 'in', 'x', 100, '2026-11-01', 'once', 'now', 'now')`);
    db.transaction(() => { for (let i = 0; i < store.MAX_ENTRIES; i++) insert.run(`bulk-${userId}-${i}`, userId); })();
    refused(() => s.addEntry(ENTRY), /at most 500 entries/);
  });
});

describe('overrides', () => {
  test('set, merged field by field, cleared with null, and removed when nothing is left', () => {
    const s = store.forTenant(userId, 't1');
    expect(s.setOverride('invoice:abc-123', { date: '2026-12-01' }, { email: 'me@test.com' }))
      .toMatchObject({ key: 'invoice:abc-123', date: '2026-12-01', amount: null, excluded: false, updatedBy: 'me@test.com' });
    expect(s.setOverride('invoice:abc-123', { amount: 12.5 })).toMatchObject({ date: '2026-12-01', amount: 12.5, amountCents: 1250 });
    expect(s.setOverride('invoice:abc-123', { date: null })).toMatchObject({ date: null, amount: 12.5 });
    expect(s.setOverride('invoice:abc-123', { amount: 0 })).toMatchObject({ amount: 0, amountCents: 0 });
    expect(s.setOverride('invoice:abc-123', { amount: null })).toBeNull();
    expect(s.overrides()).toEqual({});
  });

  test('every item key the projection makes, and nothing else', () => {
    const s = store.forTenant(userId, 't1');
    for (const key of ['invoice:0b1c-2d', 'payment:P1', 'repeating:r-1:2026-11-30', 'manual:1760000000000abcdefgh:2027-02-28']) {
      expect(s.setOverride(key, { excluded: true })).toMatchObject({ key, excluded: true });
    }
    for (const key of ['bill:1', 'invoice:', 'invoice:a b', 'repeating:r1', 'manual:e1:2026-02-30', 'payment:x;drop', 42, undefined]) {
      refused(() => s.setOverride(key, { excluded: true }), /key/);
    }
  });

  test.each([
    [{ date: '2026-13-01' },  /date must be a date/],
    [{ amount: -1 },          /cannot be negative/],
    [{ amount: 1.234 },       /two decimal places/],
    [{ excluded: 'yes' },     /excluded must be true or false/],
    [{},                      /Give a date, an amount or excluded/],
  ])('%o is refused', (bad, re) => {
    refused(() => store.forTenant(userId, 't1').setOverride('invoice:abc', bad), re);
  });

  test('deleted by key, per person and organisation', () => {
    store.forTenant(userId, 't1').setOverride('invoice:abc', { excluded: true });
    expect(store.forTenant(other, 't1').deleteOverride('invoice:abc')).toBe(false);
    expect(store.forTenant(userId, 't2').deleteOverride('invoice:abc')).toBe(false);
    expect(store.forTenant(userId, 't1').deleteOverride('invoice:abc')).toBe(true);
  });
});

describe('bank options', () => {
  test('defaults until set, merged per field, an adjustment either way and an overdraft never negative', () => {
    const s = store.forTenant(userId, 't1');
    expect(s.bankOptions()).toEqual({});
    s.setBankOptions({ 'a-op': { openingAdjustment: -120.5 } });
    expect(s.bankOptions()['a-op']).toEqual({ included: true, openingAdjustment: -120.5, openingAdjustmentCents: -12050, overdraft: 0, overdraftCents: 0 });
    s.setBankOptions({ 'a-op': { overdraft: 5000 }, 'name:Petty Cash': { included: false } });
    expect(s.bankOptions()).toMatchObject({
      'a-op': { included: true, openingAdjustment: -120.5, overdraft: 5000 },
      'name:Petty Cash': { included: false, openingAdjustment: 0, overdraft: 0 },
    });
  });

  test('a bad value anywhere in the list saves nothing', () => {
    const s = store.forTenant(userId, 't1');
    refused(() => s.setBankOptions({ 'a-op': { overdraft: 10 }, 'a-sav': { overdraft: -1 } }), /cannot be negative/);
    refused(() => s.setBankOptions({ 'a-op': { included: 'no' } }), /included must be true or false/);
    refused(() => s.setBankOptions({ 'a-op': 5 }), /object of options/);
    refused(() => s.setBankOptions([]), /accounts must be an object/);
    refused(() => s.setBankOptions(null), /accounts must be an object/);
    expect(s.bankOptions()).toEqual({});
  });
});

test('a deleted account takes all its rows with it', async () => {
  const s = store.forTenant(userId, 't1');
  s.addEntry(ENTRY);
  s.setOverride('invoice:abc', { excluded: true });
  s.setBankOptions({ 'a-op': { included: false } });
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  for (const t of ['cash_manager_entries', 'cash_manager_overrides', 'cash_manager_bank_options']) {
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(userId).n).toBe(0);
  }
});
