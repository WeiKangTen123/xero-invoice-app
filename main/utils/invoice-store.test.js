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

  test('claimForSubmit rejects an already-posted invoice', () => {
    const store = invoiceStore.forUser(userId);
    const inv   = baseInvoice({ status: 'posted', xeroInvoiceId: 'xero-9' });
    store.add(inv);
    expect(store.claimForSubmit(inv.id)).toEqual({ claimed: false, reason: 'already posted', xeroInvoiceId: 'xero-9' });
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
});
