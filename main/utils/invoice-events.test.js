// listForUser: one account's latest record events across all its records, for
// the admin's account page. Written through the real store, as the routes and
// the background readers write them.
describe('invoice-events listForUser', () => {
  let db, users, invoiceStore, auditLog, auditContext, events, owner, other, admin, store, seq = 0;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db           = require('../db');
    users        = require('./users');
    invoiceStore = require('./invoice-store');
    auditLog     = require('./audit-log');
    auditContext = require('./audit-context');
    events       = require('./invoice-events');
    owner = await users.createUser(`owner${++seq}@test.com`, 'password123', 'user');
    other = await users.createUser(`other${seq}@test.com`, 'password123', 'user');
    admin = await users.createUser(`admin${seq}@test.com`, 'password123', 'admin');
    store = invoiceStore.forUser(owner.id);
  });

  const asUser = (user, fn) => auditContext.runForRequest({ user }, fn);
  const bill = (s, id, extra = {}) => s.add({
    id, status: 'pending', invoiceType: 'ACCPAY', source: 'pdf', sourceEmail: 'billing@acme.test',
    vendorName: 'Acme Ltd', invoiceNumber: `INV-${id}`, invoiceDate: '2026-09-01', totalAmount: 120, subTotal: 110,
    taxAmount: 10, currency: 'SGD', accountCode: '400', lineItems: [{ description: 'Widgets', unitAmount: 110 }],
    processedAt: new Date().toISOString(), ...extra,
  });

  test("the account's events, newest first, with the sentence and who acted as History names them", async () => {
    bill(store, 'a');                                                   // background work: the system
    await asUser(owner, () => store.update('a', { status: 'reviewed' }));   // the owner
    await asUser(admin, () => store.update('a', { vendorName: 'Acme Pte' })); // an admin
    bill(invoiceStore.forUser(other.id), 'b');                          // someone else's record

    const list = events.listForUser(owner.id);
    expect(list.map(e => [e.action, e.by])).toEqual([
      ['edited', `Admin ${admin.email}`],
      ['reviewed', owner.email],
      ['created', 'System'],
    ]);
    expect(list[2]).toEqual({
      at: expect.any(String), recordId: 'a', action: 'created', by: 'System',
      summary: 'Created from an emailed PDF (from billing@acme.test): Acme Ltd INV-a, SGD 120.00',
    });
    // The same sentence the record's own History shows.
    const history = auditLog.listInvoiceEvents({ invoiceId: 'a', userId: owner.id }).events;
    expect(list.map(e => e.summary)).toEqual(history.map(e => e.summary));
  });

  test('a deleted record keeps its events', async () => {
    bill(store, 'gone');
    await store.remove('gone');
    expect(events.listForUser(owner.id).map(e => [e.recordId, e.action])).toEqual([['gone', 'deleted'], ['gone', 'created']]);
  });

  test('limit: 50 by default, as asked within 1-200', () => {
    for (let i = 0; i < 60; i++) bill(store, `r${i}`);
    expect(events.listForUser(owner.id)).toHaveLength(50);
    expect(events.listForUser(owner.id, { limit: 5 }).map(e => e.recordId)).toEqual(['r59', 'r58', 'r57', 'r56', 'r55']);
    expect(events.listForUser(owner.id, { limit: 0 })).toHaveLength(50);
    expect(events.listForUser(owner.id, { limit: 1000 })).toHaveLength(60);
  });

  test('an account with none has none', () => {
    expect(events.listForUser(other.id)).toEqual([]);
    expect(events.listForUser('no-such-account')).toEqual([]);
  });

  test("finds the account's rows by the record index, not by reading every event", () => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT invoice_id, at, actor_type, actor_email, action, summary FROM invoice_events WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all('x', 50).map(r => r.detail).join('\n');
    expect(plan).toMatch(/USING INDEX idx_invoice_events_record \(user_id=\?\)/);
  });
});
