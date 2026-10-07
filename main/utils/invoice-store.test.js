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

  test('add ignores undefined fields, so a parser that read nothing does not null a NOT NULL column', () => {
    const store = invoiceStore.forUser(userId);
    const inv = baseInvoice({ hasPdf: undefined, processedAt: undefined });
    expect(() => store.add(inv)).not.toThrow();
    const row = store.getById(inv.id);
    expect(row.hasPdf).toBe(false);
    expect(row.processedAt).toBeTruthy();
  });

  test('update leaves a field alone when the patch has it as undefined; null clears it', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice({ accountCode: '429', invoiceDate: '2026-09-14' });
    store.add(inv);
    // A reader that could not make out a value passes undefined for it. That
    // must mean "nothing new here", never "erase what was there" — a receipt
    // with an unreadable date was losing the upload date it already had.
    const kept = store.update(inv.id, { accountCode: undefined, invoiceDate: undefined, vendorName: 'Grab' });
    expect(kept.accountCode).toBe('429');
    expect(kept.invoiceDate).toBe('2026-09-14');
    expect(kept.vendorName).toBe('Grab');
    expect(store.update(inv.id, { accountCode: null }).accountCode).toBeNull();
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

  test('no silent cap: a 505th invoice does not evict the first (posted rows were being deleted)', () => {
    // The JSON-era 500-row cap deleted the oldest rows by rowid whatever their
    // status — including posted ones, whose xero_invoice_id is the only guard
    // against posting the same invoice twice — and orphaned their files.
    const store = invoiceStore.forUser(userId);
    for (let i = 0; i < 505; i++) store.add(baseInvoice({ id: `bulk-${i}` }));
    expect(store.count()).toBe(505);
    expect(store.getById('bulk-0')).not.toBeNull();
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

  // A row holding a Xero invoice ID is in Xero whatever its status says. A
  // report, an admin resolution or a failed correction used to move a posted
  // row off 'posted'; findPosted looked only at 'posted' and findStored skipped
  // 'error', so the row went invisible and a re-scanned email posted the bill
  // a second time.
  describe('a row in Xero stays recognisable', () => {
    test('reporting a posted row keeps it posted, records the report, and lists it as flagged', () => {
      const store = invoiceStore.forUser(userId);
      const inv   = baseInvoice({ status: 'posted', xeroInvoiceId: 'xero-r1' });
      store.add(inv);
      store.addReport(inv.id, { userEmail: 'x@test.com', note: 'wrong account' });
      const row = store.getById(inv.id);
      expect(row.status).toBe('posted');
      expect(row.reports.map(r => r.note)).toEqual(['wrong account']);
      expect(store.getFlagged().map(i => i.id)).toEqual([inv.id]);
      expect(store.findPosted('Acme Corp', 'INV-001', '2026-01-01', 100).id).toBe(inv.id);
      expect(store.findStored('Acme Corp', 'INV-001', '2026-01-01', 100).id).toBe(inv.id);
    });

    test('a resolved report drops off the flagged list; a newer report puts it back', async () => {
      const store = invoiceStore.forUser(userId);
      const inv   = baseInvoice({ status: 'posted', xeroInvoiceId: 'xero-r2' });
      store.add(inv);
      store.addReport(inv.id, { userEmail: 'x@test.com', note: 'first' });
      await new Promise(r => setTimeout(r, 5));
      store.update(inv.id, { resolvedBy: 'admin@test.com', resolvedAt: new Date().toISOString() });
      expect(store.getFlagged()).toEqual([]);
      await new Promise(r => setTimeout(r, 5));
      store.addReport(inv.id, { userEmail: 'x@test.com', note: 'second' });
      expect(store.getFlagged().map(i => i.id)).toEqual([inv.id]);
    });

    test.each(['reported', 'reviewed', 'error'])('a row with a Xero ID in status %s is still found by every duplicate check', status => {
      const store = invoiceStore.forUser(userId);
      const inv   = baseInvoice({ status, xeroInvoiceId: `xero-${status}`, receiptHash: `hash-${status}` });
      store.add(inv);
      expect(store.findPosted('Acme Corp', 'INV-001', '2026-01-01', 100)?.id).toBe(inv.id);
      expect(store.findStored('Acme Corp', 'INV-001', '2026-01-01', 100)?.id).toBe(inv.id);
      expect(store.findByReceiptHash(`hash-${status}`)?.id).toBe(inv.id);
    });

    test('an error row with no Xero ID is still ignored, so a genuine re-import is not blocked', () => {
      const store = invoiceStore.forUser(userId);
      store.add(baseInvoice({ status: 'error', receiptHash: 'h-err' }));
      expect(store.findPosted('Acme Corp', 'INV-001', '2026-01-01', 100)).toBeNull();
      expect(store.findStored('Acme Corp', 'INV-001', '2026-01-01', 100)).toBeNull();
      expect(store.findByReceiptHash('h-err')).toBeNull();
    });

    test('findPosted never returns the row it is asked to leave out', () => {
      const store = invoiceStore.forUser(userId);
      const inv   = baseInvoice({ status: 'posted', xeroInvoiceId: 'xero-self' });
      store.add(inv);
      expect(store.findPosted('Acme Corp', 'INV-001', '2026-01-01', 100, inv.id)).toBeNull();
    });
  });

  // A restart mid-send left the row in 'submitting', which claimForSubmit
  // refuses, so nothing could ever send it again.
  describe('releaseInterrupted', () => {
    const MSG = 'Sending was interrupted by a restart. Check Xero for this document before sending it again.';

    test("a 'submitting' row becomes review-needed with the message, and can be claimed again", () => {
      const store = invoiceStore.forUser(userId);
      const inv   = baseInvoice({ status: 'submitting' });
      store.add(inv);
      expect(store.claimForSubmit(inv.id)).toEqual({ claimed: false, reason: 'already submitting' });
      expect(store.releaseInterrupted(MSG)).toBe(1);
      const row = store.getById(inv.id);
      expect(row.status).toBe('review-needed');
      expect(row.errorMsg).toBe(MSG);
      expect(store.claimForSubmit(inv.id)).toEqual({ claimed: true });
    });

    test('a correction to a posted row that was cut off stays posted, with the message', () => {
      const store = invoiceStore.forUser(userId);
      const inv   = baseInvoice({ status: 'submitting', xeroInvoiceId: 'xero-int' });
      store.add(inv);
      store.releaseInterrupted(MSG);
      expect(store.getById(inv.id)).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-int', errorMsg: MSG });
    });

    test('rows in any other status are left alone', () => {
      const store = invoiceStore.forUser(userId);
      store.add(baseInvoice({ id: 'p1', status: 'pending' }));
      store.add(baseInvoice({ id: 'p2', status: 'posted', xeroInvoiceId: 'xero-p2' }));
      expect(store.releaseInterrupted(MSG)).toBe(0);
      expect(store.getById('p1')).toMatchObject({ status: 'pending', errorMsg: null });
      expect(store.getById('p2')).toMatchObject({ status: 'posted', errorMsg: null });
    });
  });

  // "Clear all" deleted posted rows too, and with them the only record that
  // the bill was already in Xero.
  test('clear removes only rows with no Xero ID that are not mid-send, and reports what it kept', () => {
    const store = invoiceStore.forUser(userId);
    store.add(baseInvoice({ id: 'c-pending', status: 'pending', receiptFile: 'a.jpg' }));
    store.add(baseInvoice({ id: 'c-error', status: 'error' }));
    store.add(baseInvoice({ id: 'c-posted', status: 'posted', xeroInvoiceId: 'xero-c1' }));
    store.add(baseInvoice({ id: 'c-reported', status: 'reported', xeroInvoiceId: 'xero-c2' }));
    store.add(baseInvoice({ id: 'c-sending', status: 'submitting' }));
    const { removed, kept } = store.clear();
    expect(removed.map(r => r.id).sort()).toEqual(['c-error', 'c-pending']);
    expect(removed.find(r => r.id === 'c-pending').receiptFile).toBe('a.jpg');
    expect(kept).toBe(3);
    expect(store.getAll().map(r => r.id).sort()).toEqual(['c-posted', 'c-reported', 'c-sending']);
  });

  test('xeroTenantId is stored and read back', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice();
    store.add(inv);
    expect(store.update(inv.id, { status: 'posted', xeroInvoiceId: 'xero-t', xeroTenantId: 'tenant-1' }))
      .toMatchObject({ xeroInvoiceId: 'xero-t', xeroTenantId: 'tenant-1' });
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

  // What the dashboard's status poll needs, every few seconds.
  describe('countByStatus', () => {
    test('one number per status, matching what getAll would count, for this user only', async () => {
      add('a'); add('b');
      add('c', { status: 'posted', xeroInvoiceId: 'x-c' });
      add('d', { status: 'error' });
      const other = await require('./users').createUser(`nr3${Date.now()}@test.com`, 'password123', 'user');
      store.forUser(other.id).add({ id: 'o', status: 'posted', processedAt: new Date().toISOString() });

      const counts = s.countByStatus();
      expect(counts).toEqual({ pending: 2, posted: 1, error: 1 });
      for (const [status, n] of Object.entries(counts)) {
        expect(s.getAll().filter(i => i.status === status)).toHaveLength(n);
      }
      expect(store.forUser(`nobody-${Date.now()}`).countByStatus()).toEqual({});
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

describe('normalizeInvoiceNumber', () => {
  const { normalizeInvoiceNumber } = require('./invoice-store');

  test('strips leading # and colons', () => {
    expect(normalizeInvoiceNumber('#INV-12345')).toBe('INV-12345');
    expect(normalizeInvoiceNumber(':# 9988')).toBe('9988');
    expect(normalizeInvoiceNumber('# 2024-001')).toBe('2024-001');
  });

  test('strips trailing punctuation and whitespace', () => {
    expect(normalizeInvoiceNumber('INV-9900:')).toBe('INV-9900');
    expect(normalizeInvoiceNumber('INV-9900. ')).toBe('INV-9900');
    expect(normalizeInvoiceNumber('  #INV-8877;  ')).toBe('INV-8877');
  });

  test('returns null for empty or invalid values', () => {
    expect(normalizeInvoiceNumber('')).toBeNull();
    expect(normalizeInvoiceNumber(null)).toBeNull();
    expect(normalizeInvoiceNumber('   ')).toBeNull();
    expect(normalizeInvoiceNumber(undefined)).toBeNull();
  });
});

// Read from the document and dropped at the store, so every row went to Xero
// tax-exclusive and without its theme; and a claim's exchange rate.
describe('invoice-store — what posting needs survives the store', () => {
  let store;
  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    const u = await require('./users').createUser(`post${Date.now()}${Math.random()}@test.com`, 'password123', 'user');
    store = require('./invoice-store').forUser(u.id);
  });
  const row = (extra = {}) => ({
    id: `p-${Math.random().toString(36).slice(2, 8)}`, status: 'pending', vendorName: 'Acme',
    invoiceNumber: 'N-1', invoiceDate: '2026-09-01', totalAmount: 109, processedAt: new Date().toISOString(), ...extra,
  });

  test('lineAmountTypes, brandingThemeName and currencyRate round-trip through add and update', () => {
    const r = store.add(row({ lineAmountTypes: 'Inclusive', brandingThemeName: 'Special Projects', currencyRate: 0.740741 }));
    expect(r).toMatchObject({ lineAmountTypes: 'Inclusive', brandingThemeName: 'Special Projects', currencyRate: 0.740741 });
    expect(store.update(r.id, { lineAmountTypes: 'Exclusive', currencyRate: null }))
      .toMatchObject({ lineAmountTypes: 'Exclusive', brandingThemeName: 'Special Projects', currencyRate: null });
  });

  test('changing the currency drops a rate that was given for the old one', () => {
    const r = store.add(row({ currency: 'USD', currencyRate: 0.74 }));
    expect(store.update(r.id, { currency: 'USD', description: 'x' }).currencyRate).toBe(0.74);
    expect(store.update(r.id, { currency: 'EUR' }).currencyRate).toBeNull();
    expect(store.update(r.id, { currency: 'USD', currencyRate: 0.75 }).currencyRate).toBe(0.75);
  });

  // The handler's closing patch after a successful send sets errorMsg: null.
  // A note recorded during that send must survive it, or nobody sees it.
  test('a note recorded mid-send survives the send\'s closing errorMsg: null, and the row is posted', () => {
    const r = store.add(row());
    store.claimForSubmit(r.id);
    store.addPostingNote(r.id, 'Sent to Xero, but the attachment failed: x.');
    store.addPostingNote(r.id, 'Second note.');
    expect(store.getById(r.id).errorMsg).toBeNull();          // not shown until the send ends
    const done = store.update(r.id, { status: 'posted', xeroInvoiceId: 'xero-n1', errorMsg: null });
    expect(done.status).toBe('posted');
    expect(done.errorMsg).toBe('Sent to Xero, but the attachment failed: x. Second note.');

    // Later edits behave as before: a person can clear it.
    expect(store.update(r.id, { errorMsg: null }).errorMsg).toBeNull();
  });

  test('a send that fails keeps its own message, and the next send starts clean', () => {
    const r = store.add(row());
    store.claimForSubmit(r.id);
    store.addPostingNote(r.id, 'stale note');
    expect(store.update(r.id, { status: 'error', errorMsg: 'Xero refused it' }).errorMsg).toBe('Xero refused it');
    store.claimForSubmit(r.id);
    expect(store.update(r.id, { status: 'posted', xeroInvoiceId: 'xero-n2', errorMsg: null }).errorMsg).toBeNull();
  });

  test('a note on a row that is not mid-send is shown at once', () => {
    const r = store.add(row({ status: 'posted', xeroInvoiceId: 'xero-n3' }));
    expect(store.addPostingNote(r.id, 'Check the total.').errorMsg).toBe('Check the total.');
  });
});
