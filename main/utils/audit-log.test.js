// The audit trail at the store: what each change to a record writes, who it
// says acted, and that it never stands in the way of the change itself.
// Nothing here reaches Xero: the status read-back is fed to the store
// directly, as xero/status-sync.js would after asking Xero.
describe('audit trail (store, context, retention)', () => {
  let db, users, invoiceStore, auditLog, auditContext, owner, other, admin, store, seq = 0;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db           = require('../db');
    users        = require('./users');
    invoiceStore = require('./invoice-store');
    auditLog     = require('./audit-log');
    auditContext = require('./audit-context');
    owner = await users.createUser(`owner${++seq}-${Date.now()}@test.com`, 'password123', 'user');
    other = await users.createUser(`other${seq}-${Date.now()}@test.com`, 'password123', 'user');
    admin = await users.createUser(`admin${seq}-${Date.now()}@test.com`, 'password123', 'admin');
    store = invoiceStore.forUser(owner.id);
  });

  const events = id => db.prepare('SELECT * FROM invoice_events WHERE invoice_id = ? ORDER BY id').all(id)
    .map(e => ({ ...e, details: e.details ? JSON.parse(e.details) : null }));
  const actions = id => events(id).map(e => e.action);
  // As requireAuth would run a request from this user.
  const asUser = (user, fn) => auditContext.runForRequest({ user }, fn);
  const bill = (id, extra = {}) => store.add({
    id, status: 'pending', invoiceType: 'ACCPAY', source: 'pdf', sourceEmail: 'billing@acme.test',
    vendorName: 'Acme Ltd', invoiceNumber: `INV-${id}`, invoiceDate: '2026-09-01', totalAmount: 120, subTotal: 110,
    taxAmount: 10, currency: 'SGD', accountCode: '400', lineItems: [{ description: 'Widgets', unitAmount: 110 }],
    processedAt: new Date().toISOString(), ...extra,
  });

  describe('the tables', () => {
    test('exist, with the indexes the history and the retention prune read by', () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('invoice_events', 'admin_events')").all().map(r => r.name);
      expect(indexes).toEqual(expect.arrayContaining([
        'idx_invoice_events_record', 'idx_invoice_events_at', 'idx_admin_events_at', 'idx_admin_events_target',
      ]));
    });

    test('have no foreign keys, so nothing cascades into them', () => {
      expect(db.prepare('PRAGMA foreign_key_list(invoice_events)').all()).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_list(admin_events)').all()).toEqual([]);
    });
  });

  describe('who acted', () => {
    test('background work with no context is the system', () => {
      bill('a');
      const [created] = events('a');
      expect(created).toMatchObject({ action: 'created', actor_type: 'system', actor_id: null, actor_email: null, user_id: String(owner.id) });
    });

    test('the owner acting on their own record is the user, with their email', () => {
      asUser(owner, () => bill('a'));
      expect(events('a')[0]).toMatchObject({ actor_type: 'user', actor_id: String(owner.id), actor_email: owner.email });
    });

    test('an admin acting on someone else\'s record is the admin; the record stays the owner\'s', () => {
      bill('a', { status: 'reported' });
      asUser(admin, () => store.update('a', { resolvedBy: admin.email, resolvedAt: new Date().toISOString(), status: 'reviewed' }));
      const resolved = events('a').find(e => e.action === 'report.resolved');
      expect(resolved).toMatchObject({ actor_type: 'admin', actor_id: String(admin.id), actor_email: admin.email, user_id: String(owner.id) });
      expect(resolved.summary).toBe('Report resolved; now reviewed');
    });

    test('runAsSystem cuts work loose from the request that started it', async () => {
      await asUser(owner, () => new Promise(resolve => {
        auditContext.runAsSystem(() => setTimeout(() => { bill('a'); resolve(); }, 0), { via: 'Receipt read' });
      }));
      expect(events('a')[0].actor_type).toBe('system');
    });

    test('a timer started in a request keeps that request\'s person', async () => {
      await asUser(owner, () => new Promise(resolve => setTimeout(() => { bill('a'); resolve(); }, 0)));
      expect(events('a')[0].actor_type).toBe('user');
    });
  });

  describe('created', () => {
    test('says how, from whom, and what it was', () => {
      bill('a');
      const [e] = events('a');
      expect(e.summary).toBe('Created from an emailed PDF (from billing@acme.test): Acme Ltd INV-a, SGD 120.00');
      expect(e.details).toMatchObject({ source: 'pdf', vendorName: 'Acme Ltd', invoiceNumber: 'INV-a', totalAmount: 120, currency: 'SGD' });
    });

    test('notes what supplier memory prefilled, and from which bill', () => {
      bill('a', { prefilledFrom: { accountCode: { fromId: 'old', fromNumber: 'INV-9', fromDate: '2026-08-01' }, currency: { fromId: 'old', fromNumber: 'INV-9' } } });
      const [e] = events('a');
      expect(e.summary).toContain('Prefilled from the last bill (INV-9): account and currency');
      expect(e.details.prefilledFrom.accountCode.fromId).toBe('old');
    });

    test('mileage and per diem claims, and a split, say so', () => {
      store.add({ id: 'm', status: 'review-needed', invoiceType: 'EXPENSE', source: 'form', claimKind: 'mileage', claimQuantity: 42, claimUnit: 'km', totalAmount: 25.2, currency: 'SGD' });
      store.add({ id: 'p', status: 'review-needed', invoiceType: 'EXPENSE', source: 'form', claimKind: 'per_diem', claimQuantity: 3, claimUnit: 'day', totalAmount: 240, currency: 'SGD' });
      store.add({ id: 's', status: 'review-needed', invoiceType: 'EXPENSE', source: 'upload', receiptPage: 2 }, { how: 'split' });
      expect(events('m')[0].summary).toBe('Mileage claim added: 42 km, SGD 25.20');
      expect(events('p')[0].summary).toBe('Per diem claim added: 3 days, SGD 240.00');
      expect(events('s')[0].summary).toBe('Created by splitting an upload into separate receipts (page 2)');
    });
  });

  describe('edits', () => {
    test('only changed business fields, before and after', () => {
      bill('a');
      asUser(owner, () => store.update('a', {
        vendorName: 'Acme Ltd', invoiceNumber: 'INV-a', totalAmount: 132, accountCode: '410', currency: 'SGD',
        description: 'long free text that is not tracked', lineItems: [{ description: 'Widgets', unitAmount: 110 }, { description: 'Freight', unitAmount: 10 }],
      }));
      const edited = events('a').filter(e => e.action === 'edited');
      expect(edited).toHaveLength(1);
      expect(edited[0].actor_type).toBe('user');
      expect(edited[0].summary).toBe('Changed total, account and lines');
      expect(edited[0].details.changes).toEqual([
        { field: 'totalAmount', label: 'total', from: '120.00', to: '132.00' },
        { field: 'accountCode', label: 'account', from: '400', to: '410' },
        { field: 'lineItems', label: 'lines', from: '1 line, 110.00', to: '2 lines, 120.00' },
      ]);
    });

    test('the whole form saved unchanged writes nothing', () => {
      bill('a');
      store.update('a', { vendorName: ' Acme Ltd ', totalAmount: '120.00', currency: 'SGD', lineItems: [{ description: 'Renamed', unitAmount: 110 }], description: 'x' });
      expect(actions('a')).toEqual(['created']);
    });

    test('bookkeeping writes (parsed time, notes, a region) write nothing', () => {
      bill('a');
      store.update('a', { parsedAt: new Date().toISOString(), confidence: 'high', receiptBox: '[1,2,3,4]' });
      expect(actions('a')).toEqual(['created']);
    });

    test('the patch that closes a send adds nothing of its own (the handler says how it went)', () => {
      bill('a');
      store.claimForSubmit('a');
      store.update('a', { status: 'posted', xeroInvoiceId: 'x-1', xeroTenantId: 't-1', submittedAt: new Date().toISOString(), errorMsg: null });
      expect(actions('a')).toEqual(['created']);
    });
  });

  describe('status', () => {
    test('reviewed, held, released, reported, duplicate marked and cleared', () => {
      bill('a');
      store.update('a', { status: 'review-needed', errorMsg: "Bank details differ from this supplier's last bill: this one says \"1\", the last one said \"2\"" });
      asUser(owner, () => store.update('a', { status: 'reviewed' }));
      bill('b', { status: 'review-needed', source: 'upload' });
      store.update('b', { status: 'review-needed', errorMsg: 'Please check: the lines do not add up' });
      store.addReport('b', { userEmail: owner.email, note: 'Wrong supplier' });
      bill('c');
      store.update('c', { status: 'duplicate', duplicateOf: 'a' });
      store.update('c', { status: 'pending', duplicateOf: null });

      const a = events('a');
      expect(a.map(e => e.summary)).toEqual([
        expect.stringMatching(/^Created/),
        "Held: bank details differ from the supplier's last bill",
        'Marked reviewed, releasing the hold',
      ]);
      expect(a.map(e => e.action)).toEqual(['created', 'hold', 'hold.released']);
      expect(events('b').map(e => e.summary).slice(1)).toEqual(['Held for review: the lines do not add up', 'Reported a problem: Wrong supplier']);
      expect(events('c').map(e => e.summary).slice(1)).toEqual(['Marked as a duplicate of INV-a (Acme Ltd)', 'Confirmed not a duplicate; now pending']);
    });

    test('a restart cutting off a send places a hold, as the system', () => {
      bill('a');
      store.claimForSubmit('a');
      auditContext.runAs(owner, () => store.releaseInterrupted('interrupted'));
      const hold = events('a').find(e => e.action === 'hold');
      expect(hold).toMatchObject({ actor_type: 'system' });
      expect(hold.summary).toMatch(/interrupted by a restart/);
    });
  });

  describe('deleted', () => {
    test('says what it was, and the history outlives the record', () => {
      asUser(owner, () => { bill('a'); store.remove('a'); });
      expect(store.getById('a')).toBeNull();
      const gone = events('a').find(e => e.action === 'deleted');
      expect(gone).toMatchObject({ actor_type: 'user', summary: 'Deleted: Acme Ltd INV-a, SGD 120.00' });
      expect(gone.details).toMatchObject({ vendorName: 'Acme Ltd', invoiceNumber: 'INV-a', totalAmount: 120 });
    });

    test('Clear all writes one event per record, each saying it was part of Clear all', () => {
      bill('a'); bill('b'); bill('kept', { xeroInvoiceId: 'x-1', status: 'posted' });
      store.clear();
      for (const id of ['a', 'b']) {
        const gone = events(id).filter(e => e.action === 'deleted');
        expect(gone).toHaveLength(1);
        expect(gone[0].summary).toMatch(/\(part of Clear all\)$/);
        expect(gone[0].details.bulk).toBe('clear-all');
      }
      expect(actions('kept')).toEqual(['created']);
    });

    test('the history outlives the account', () => {
      bill('a');
      users.deleteUser(owner.id);
      expect(db.prepare('SELECT 1 FROM invoices WHERE id = ?').get('a')).toBeUndefined();
      expect(actions('a')).toEqual(['created']);
      expect(auditLog.listInvoiceEvents({ invoiceId: 'a' }).events).toHaveLength(1);
    });
  });

  describe('Xero status read back', () => {
    const posted = id => bill(id, { status: 'posted', xeroInvoiceId: `x-${id}` });
    const read = (id, fields) => store.recordXeroStatus(id, `x-${id}`, { amountDue: 120, amountPaid: 0, ...fields });

    test('writes only when something changed, and never for the first look at a draft', () => {
      posted('a');
      read('a', { status: 'DRAFT' });
      read('a', { status: 'DRAFT' });
      read('a', { status: 'AUTHORISED' });
      read('a', { status: 'AUTHORISED' });
      read('a', { status: 'AUTHORISED', amountDue: 70, amountPaid: 50 });
      read('a', { status: 'PAID', amountDue: 0, amountPaid: 120, paidOn: '2026-09-30' });
      read('a', { status: 'PAID', amountDue: 0, amountPaid: 120, paidOn: '2026-09-30' });
      const xs = events('a').filter(e => e.action === 'xero.status');
      expect(xs.map(e => e.summary)).toEqual([
        'Approved in Xero',
        'Part-paid in Xero: SGD 50.00 paid, SGD 70.00 still due',
        'Paid in Xero on 2026-09-30',
      ]);
      expect(xs.every(e => e.actor_type === 'system')).toBe(true);
      expect(xs[2].details.to).toEqual({ status: 'PAID', amountDue: 0, amountPaid: 120, paidOn: '2026-09-30' });
    });

    test('voided and deleted in Xero; a manual refresh is still Xero\'s doing', () => {
      posted('a'); posted('b');
      asUser(owner, () => { read('a', { status: 'VOIDED' }); read('b', { status: 'DELETED' }); });
      expect(events('a').pop()).toMatchObject({ summary: 'Voided in Xero', actor_type: 'system' });
      expect(events('b').pop()).toMatchObject({ summary: 'Deleted in Xero', actor_type: 'system' });
    });
  });

  describe('never in the way', () => {
    test('a failed history write is a warning, and the edit, add and delete still happen', () => {
      bill('a');
      db.exec('DROP TABLE invoice_events');
      const logger = require('./logger');
      const warn = jest.spyOn(logger, 'warn');
      expect(store.update('a', { totalAmount: 99 }).totalAmount).toBe(99);
      expect(bill('b')).not.toBeNull();
      expect(store.remove('b')).toBe(true);
      expect(warn).toHaveBeenCalledWith('Audit event not recorded', expect.objectContaining({ invoiceId: 'a', action: 'edited' }));
      warn.mockRestore();
    });

    test('a mistake in describing a change is a warning too', () => {
      bill('a');
      const events = require('./invoice-events');
      const spy = jest.spyOn(events, 'updated').mockImplementation(() => { throw new Error('boom'); });
      expect(store.update('a', { totalAmount: 99 }).totalAmount).toBe(99);
      spy.mockRestore();
    });
  });

  describe('reading', () => {
    const many = (id, n) => {
      const insert = db.prepare("INSERT INTO invoice_events (user_id, invoice_id, at, actor_type, action, summary) VALUES (?, ?, ?, 'system', 'edited', ?)");
      for (let i = 0; i < n; i++) insert.run(String(owner.id), id, new Date(Date.now() + i).toISOString(), `e${i}`);
    };

    test('newest first, at most 200 a page, paged by before', () => {
      many('a', 205);
      const first = auditLog.listInvoiceEvents({ invoiceId: 'a', userId: owner.id });
      expect(first.events).toHaveLength(200);
      expect(first.events[0].summary).toBe('e204');
      expect(first.nextBefore).toBe(first.events[199].id);
      const second = auditLog.listInvoiceEvents({ invoiceId: 'a', userId: owner.id, before: first.nextBefore });
      expect(second.events.map(e => e.summary)).toEqual(['e4', 'e3', 'e2', 'e1', 'e0']);
      expect(second.nextBefore).toBeNull();
      expect(auditLog.listInvoiceEvents({ invoiceId: 'a', userId: owner.id, limit: 1000 }).events).toHaveLength(200);
    });

    test('another owner\'s events are not returned for the same id', () => {
      many('a', 2);
      expect(auditLog.listInvoiceEvents({ invoiceId: 'a', userId: other.id }).events).toEqual([]);
    });
  });

  describe('retention', () => {
    test('prunes events older than two years from both tables, and keeps the rest', () => {
      const old = new Date(Date.now() - 731 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date(Date.now() - 700 * 24 * 60 * 60 * 1000).toISOString();
      const ins = db.prepare("INSERT INTO invoice_events (user_id, invoice_id, at, actor_type, action, summary) VALUES ('u', 'i', ?, 'system', 'edited', ?)");
      ins.run(old, 'old'); ins.run(recent, 'recent');
      const adm = db.prepare("INSERT INTO admin_events (at, action) VALUES (?, 'user.sign_out')");
      adm.run(old); adm.run(recent);
      expect(auditLog.pruneOldEvents()).toEqual({ invoices: 1, admin: 1 });
      expect(db.prepare('SELECT summary FROM invoice_events').all().map(r => r.summary)).toEqual(['recent']);
      expect(db.prepare('SELECT COUNT(*) AS n FROM admin_events').get().n).toBe(1);
    });

    test('a prune that cannot run is a warning, not a crash', () => {
      db.exec('DROP TABLE admin_events');
      expect(auditLog.pruneOldEvents()).toEqual({ invoices: 0, admin: 0 });
    });
  });
});
