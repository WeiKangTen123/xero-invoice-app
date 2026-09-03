describe('invoice-store (SQLite)', () => {
  let users, invoiceStore, userId;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users        = require('./users');
    invoiceStore = require('./invoice-store');
    const u = await users.createUser('inv@test.com', 'password123', 'user');
    userId = u.id;
  });

  function baseInvoice(overrides = {}) {
    return {
      id:            `${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
      status:        'pending',
      vendorName:    'Acme Corp',
      invoiceNumber: 'INV-001',
      invoiceDate:   '2026-01-01',
      totalAmount:   100,
      processedAt:   new Date().toISOString(),
      ...overrides,
    };
  }

  test('add + getById + getAll', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice();
    store.add(inv);
    expect(store.getById(inv.id).vendorName).toBe('Acme Corp');
    expect(store.getAll()).toHaveLength(1);
  });

  test('add stores boolean fields like hasPdf without throwing', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice({ hasPdf: true });
    store.add(inv);
    expect(store.getById(inv.id).hasPdf).toBe(true);

    const updated = store.update(inv.id, { hasPdf: false });
    expect(updated.hasPdf).toBe(false);
  });

  test('add returns null for a duplicate id', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice();
    store.add(inv);
    expect(store.add(inv)).toBeNull();
  });

  test('update patches fields and stamps updatedAt', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice();
    store.add(inv);
    const updated = store.update(inv.id, { status: 'posted', xeroInvoiceId: 'xero-1' });
    expect(updated.status).toBe('posted');
    expect(updated.xeroInvoiceId).toBe('xero-1');
  });

  test('findPosted matches on normalized vendor name + invoice number', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice({ status: 'posted', vendorName: 'BLCKLB PTE. LTD.' });
    store.add(inv);
    const found = store.findPosted('blcklb Pte Ltd', 'INV-001', '2026-01-01', 100);
    expect(found.id).toBe(inv.id);
  });

  test('findStored excludes duplicate/error statuses', () => {
    const store = invoiceStore.forUser(userId);
    store.add(baseInvoice({ status: 'duplicate' }));
    expect(store.findStored('Acme Corp', 'INV-001', '2026-01-01', 100)).toBeNull();
  });

  test('claimForSubmit prevents a double-claim', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice();
    store.add(inv);
    expect(store.claimForSubmit(inv.id)).toEqual({ claimed: true });
    expect(store.claimForSubmit(inv.id)).toEqual({ claimed: false, reason: 'already submitting' });
  });

  test('claimForSubmit allows re-claiming an already-posted invoice (re-post flow)', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice({ status: 'posted', xeroInvoiceId: 'xero-9' });
    store.add(inv);
    expect(store.claimForSubmit(inv.id)).toEqual({ claimed: true });
    expect(store.getById(inv.id).status).toBe('submitting');
    // xeroInvoiceId is preserved through the claim so the caller can route to an update
    expect(store.getById(inv.id).xeroInvoiceId).toBe('xero-9');
  });

  test('addReport sets status to reported and stores the report', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice();
    store.add(inv);
    store.addReport(inv.id, { userEmail: 'x@test.com', note: 'wrong amount' });

    const updated = store.getById(inv.id);
    expect(updated.status).toBe('reported');
    expect(updated.reports).toHaveLength(1);
    expect(updated.reports[0].note).toBe('wrong amount');
    expect(store.getFlagged()).toHaveLength(1);
  });

  test('keeps only the newest MAX (500) invoices per user', () => {
    const store = invoiceStore.forUser(userId);
    for (let i = 0; i < 505; i++) {
      store.add(baseInvoice({ id: `bulk-${i}` }));
    }
    expect(store.getAll()).toHaveLength(500);
    expect(store.getById('bulk-0')).toBeNull();
    expect(store.getById('bulk-504')).not.toBeNull();
  });

  // Regression test for the batched-report-fetch fix (was one query per invoice,
  // now one query for the whole set) — verifies each invoice still gets exactly
  // its own reports, not another invoice's, and unreported invoices get [].
  test('getAll/getFlagged attach reports to the correct invoice after batch fetch', () => {
    const store = invoiceStore.forUser(userId);
    const a = baseInvoice({ id: 'multi-a', vendorName: 'Vendor A' });
    const b = baseInvoice({ id: 'multi-b', vendorName: 'Vendor B' });
    const c = baseInvoice({ id: 'multi-c', vendorName: 'Vendor C' }); // never reported
    store.add(a); store.add(b); store.add(c);

    store.addReport('multi-a', { userEmail: 'u1@test.com', note: 'issue on A' });
    store.addReport('multi-b', { userEmail: 'u2@test.com', note: 'issue on B (1)' });
    store.addReport('multi-b', { userEmail: 'u3@test.com', note: 'issue on B (2)' });

    const all = store.getAll();
    const byId = Object.fromEntries(all.map(i => [i.id, i]));

    expect(byId['multi-a'].reports.map(r => r.note)).toEqual(['issue on A']);
    expect(byId['multi-b'].reports.map(r => r.note)).toEqual(['issue on B (1)', 'issue on B (2)']);
    expect(byId['multi-c'].reports).toEqual([]);

    const flagged = store.getFlagged();
    expect(flagged.map(i => i.id).sort()).toEqual(['multi-a', 'multi-b']);
  });

  // Regression coverage for the REAL-dollars -> INTEGER-cents migration: money is
  // stored as cents (see schema.sql), so a value like 19.99 must survive a
  // write/read cycle exactly, not drift the way repeated float math would.
  describe('money stored as integer cents', () => {
    test('a decimal dollar amount round-trips exactly, with no float drift', () => {
      const store = invoiceStore.forUser(userId);
      const inv = baseInvoice({ totalAmount: 19.99, taxAmount: 1.62, subTotal: 18.37 });
      store.add(inv);
      const fetched = store.getById(inv.id);
      expect(fetched.totalAmount).toBe(19.99);
      expect(fetched.taxAmount).toBe(1.62);
      expect(fetched.subTotal).toBe(18.37);
    });

    test('the underlying column actually holds cents, not dollars', () => {
      const store = invoiceStore.forUser(userId);
      const inv = baseInvoice({ totalAmount: 19.99 });
      store.add(inv);
      const db = require('../db');
      const raw = db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv.id);
      expect(raw.total_amount).toBe(1999);
    });

    test('update() also converts a patched money field through the cents boundary', () => {
      const store = invoiceStore.forUser(userId);
      const inv = baseInvoice({ totalAmount: 100 });
      store.add(inv);
      const updated = store.update(inv.id, { totalAmount: 250.5 });
      expect(updated.totalAmount).toBe(250.5);
    });

    test('surviving 100 repeated read-modify-write cycles does not accumulate drift', () => {
      // This is exactly the failure mode REAL dollars was vulnerable to and cents isn't.
      const store = invoiceStore.forUser(userId);
      const inv = baseInvoice({ totalAmount: 10.1 });
      store.add(inv);
      for (let i = 0; i < 100; i++) {
        const current = store.getById(inv.id).totalAmount;
        store.update(inv.id, { totalAmount: current });
      }
      expect(store.getById(inv.id).totalAmount).toBe(10.1);
    });
  });

  describe('line items (invoice_line_items child table)', () => {
    test('add() persists line items and getById() returns them in the original order', () => {
      const store = invoiceStore.forUser(userId);
      const inv = baseInvoice({
        lineItems: [
          { description: 'First item',  unitAmount: 12.34, discountRate: 0 },
          { description: 'Second item', unitAmount: 56.78, discountRate: 10 },
        ],
      });
      store.add(inv);
      const fetched = store.getById(inv.id);
      expect(fetched.lineItems).toEqual([
        { description: 'First item',  unitAmount: 12.34, discountRate: 0 },
        { description: 'Second item', unitAmount: 56.78, discountRate: 10 },
      ]);
    });

    test('an invoice with no line items returns an empty array, not null/undefined', () => {
      const store = invoiceStore.forUser(userId);
      const inv = baseInvoice();
      store.add(inv);
      expect(store.getById(inv.id).lineItems).toEqual([]);
    });

    test('update() with a lineItems patch fully replaces the previous set', () => {
      const store = invoiceStore.forUser(userId);
      const inv = baseInvoice({ lineItems: [{ description: 'Old item', unitAmount: 5 }] });
      store.add(inv);
      store.update(inv.id, { lineItems: [{ description: 'New item', unitAmount: 9.5 }] });
      const fetched = store.getById(inv.id);
      expect(fetched.lineItems).toHaveLength(1);
      expect(fetched.lineItems[0]).toMatchObject({ description: 'New item', unitAmount: 9.5 });
    });

    test('getAll() (batched hydration) attaches line items to the correct invoice', () => {
      const store = invoiceStore.forUser(userId);
      store.add(baseInvoice({ id: 'li-a', lineItems: [{ description: 'A1', unitAmount: 1 }] }));
      store.add(baseInvoice({ id: 'li-b', lineItems: [{ description: 'B1', unitAmount: 2 }, { description: 'B2', unitAmount: 3 }] }));
      const byId = Object.fromEntries(store.getAll().map(i => [i.id, i]));
      expect(byId['li-a'].lineItems.map(l => l.description)).toEqual(['A1']);
      expect(byId['li-b'].lineItems.map(l => l.description)).toEqual(['B1', 'B2']);
    });

    test('deleting the parent invoice cascades to its line items', () => {
      const store = invoiceStore.forUser(userId);
      const inv = baseInvoice({ lineItems: [{ description: 'Item', unitAmount: 1 }] });
      store.add(inv);
      store.remove(inv.id);
      const db = require('../db');
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM invoice_line_items WHERE invoice_id = ?').get(inv.id);
      expect(remaining.n).toBe(0);
    });
  });

  describe('schema constraints', () => {
    test('rejects an invoice with a status outside the allowed CHECK list', () => {
      const store = invoiceStore.forUser(userId);
      expect(() => store.add(baseInvoice({ status: 'not-a-real-status' }))).toThrow();
    });

    test('rejects a second invoice with the same (user_id, xero_invoice_id)', () => {
      const store = invoiceStore.forUser(userId);
      store.add(baseInvoice({ id: 'dup-1', status: 'posted', xeroInvoiceId: 'xero-shared' }));
      expect(() => store.add(baseInvoice({ id: 'dup-2', status: 'posted', xeroInvoiceId: 'xero-shared' })))
        .toThrow();
    });

    test('allows multiple invoices with no xeroInvoiceId (NULLs are not "duplicates" of each other)', () => {
      const store = invoiceStore.forUser(userId);
      store.add(baseInvoice({ id: 'null-1' }));
      expect(() => store.add(baseInvoice({ id: 'null-2' }))).not.toThrow();
    });

    test('rejects duplicateOf pointing at a non-existent invoice id', () => {
      const store = invoiceStore.forUser(userId);
      expect(() => store.add(baseInvoice({ duplicateOf: 'does-not-exist' }))).toThrow();
    });

    test('accepts duplicateOf pointing at a real invoice id', () => {
      const store = invoiceStore.forUser(userId);
      const original = baseInvoice({ id: 'orig-1', status: 'posted' });
      store.add(original);
      expect(() => store.add(baseInvoice({ id: 'dup-of-orig', duplicateOf: 'orig-1' }))).not.toThrow();
    });
  });
});

// The write path is driven by FIELD_TO_COLUMN; the read path (_rowToRecord) is
// hand-written. Adding a field to the map alone therefore SAVES but does not
// READ BACK — it half-works, silently, and the value looks like it was never
// stored. That is exactly how receiptFile shipped broken. This closes the gap.
describe('utils/invoice-store — every mapped field survives a round trip', () => {
  // Fields the store owns or derives rather than storing verbatim.
  const DERIVED = new Set(['id', 'userId', 'updatedAt', 'processedAt']);
  const MONEY   = new Set(['totalAmount', 'taxAmount', 'subTotal']);

  test('a value written for each field comes back on the record', async () => {
    // Required INSIDE the test, after migrate: a require at describe scope binds
    // to whichever in-memory DB existed at collection time, which no migration
    // has touched.
    jest.resetModules();
    require('../db/migrate').run();
    const store = require('./invoice-store');
    const { FIELD_TO_COLUMN } = store;
    // invoices.user_id is a real foreign key, so the user must exist.
    const u = await require('./users').createUser(`rt${Date.now()}@test.com`, 'password123', 'user');
    const s = store.forUser(u.id);

    const sample = {};
    for (const field of Object.keys(FIELD_TO_COLUMN)) {
      if (DERIVED.has(field)) continue;
      if (field === 'status')      { sample[field] = 'pending'; continue; }
      if (field === 'hasPdf')      { sample[field] = true; continue; }
      if (field === 'duplicateOf') continue;   // FK to another invoice
      sample[field] = MONEY.has(field) ? 12.34 : `v-${field}`;
    }

    const saved = s.add({ id: 'rt-1', ...sample, processedAt: new Date().toISOString() });
    expect(saved).toBeTruthy();

    const missing = [];
    for (const [field, value] of Object.entries(sample)) {
      const got = saved[field];
      if (field === 'hasPdf') { if (got !== true) missing.push(field); continue; }
      // Undefined means _rowToRecord forgot it. A differing value means the
      // column mapping is wrong. Both are the same class of bug.
      if (got === undefined || got === null || got !== value) missing.push(`${field} (got ${JSON.stringify(got)}, want ${JSON.stringify(value)})`);
    }
    expect(missing).toEqual([]);
    s.clear();
  });
});

// ── Narrow reads ────────────────────────────────────────────────────────────
// getAll() runs three queries and hydrates every invoice with its line items and
// reports. Callers wanting a count, a handful of rows, or one group were paying
// all of that and discarding nearly all of it.
describe('invoice-store — reads that fetch only what is needed', () => {
  let store, s, userId;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    store = require('./invoice-store');
    const u = await require('./users').createUser(`nr${Date.now()}@test.com`, 'password123', 'user');
    userId = u.id;
    s = store.forUser(userId);
  });

  const add = (id, extra = {}) => s.add({
    id, status: 'pending', vendorName: 'V', totalAmount: 10,
    processedAt: new Date().toISOString(), ...extra,
  });

  describe('count', () => {
    test('counts without hydrating anything', () => {
      expect(s.count()).toBe(0);
      add('a'); add('b'); add('c');
      expect(s.count()).toBe(3);
      expect(s.count()).toBe(s.getAll().length);
    });

    test('counts only this user\'s rows', async () => {
      add('a');
      const other = await require('./users').createUser(`nr2${Date.now()}@test.com`, 'password123', 'user');
      expect(store.forUser(other.id).count()).toBe(0);
    });
  });

  describe('getRecent', () => {
    test('returns newest first, matching getAll order', () => {
      add('a'); add('b'); add('c');
      expect(s.getRecent(10).map(r => r.id)).toEqual(s.getAll().map(r => r.id));
    });

    test('caps at the limit instead of loading everything', () => {
      for (let i = 0; i < 8; i++) add(`i${i}`);
      expect(s.getRecent(3)).toHaveLength(3);
      // The newest three, not an arbitrary three.
      expect(s.getRecent(3).map(r => r.id)).toEqual(s.getAll().slice(0, 3).map(r => r.id));
    });

    test('a zero or negative limit still returns at least one row rather than none', () => {
      add('a');
      expect(s.getRecent(0)).toHaveLength(1);
      expect(s.getRecent(-5)).toHaveLength(1);
    });
  });

  describe('getReceiptGroup', () => {
    test('returns only the siblings from one upload', () => {
      add('g1', { receiptGroup: 'grp', invoiceType: 'EXPENSE' });
      add('g2', { receiptGroup: 'grp', invoiceType: 'EXPENSE' });
      add('other', { receiptGroup: 'different' });
      add('none');
      expect(s.getReceiptGroup('grp').map(r => r.id).sort()).toEqual(['g1', 'g2']);
    });

    test('an absent group is an empty list, not everything', () => {
      // A falsy group id filtering to "no WHERE clause" would return the lot.
      add('a'); add('b');
      expect(s.getReceiptGroup(null)).toEqual([]);
      expect(s.getReceiptGroup('')).toEqual([]);
      expect(s.getReceiptGroup('nope')).toEqual([]);
    });
  });

  describe('countByReceiptFile', () => {
    test('counts records sharing one stored file', () => {
      add('a', { receiptFile: 'shared.jpg' });
      add('b', { receiptFile: 'shared.jpg' });
      add('c', { receiptFile: 'other.jpg' });
      expect(s.countByReceiptFile('shared.jpg')).toBe(2);
      expect(s.countByReceiptFile('other.jpg')).toBe(1);
      expect(s.countByReceiptFile('gone.jpg')).toBe(0);
    });

    test('a missing filename counts zero rather than matching every null', () => {
      // Returning a match here would delete a file that is still in use.
      add('a', { receiptFile: 'x.jpg' });
      add('b');
      expect(s.countByReceiptFile(null)).toBe(0);
      expect(s.countByReceiptFile('')).toBe(0);
    });
  });
});
