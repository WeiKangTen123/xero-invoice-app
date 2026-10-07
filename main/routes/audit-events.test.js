// The audit trail through the routes: each kind of event written by a real
// request with the right actor, the history and Activity endpoints and who
// may read them, and the admin trail without secrets.
//
// Nothing here reaches Xero, Gemini or Slack. The SDK class and axios are
// replaced, the Xero calls are stubbed at the edge (xero/invoices) as
// invoices-bulk.test.js does, and the connection, the receipt reader and the
// notifier are fakes; the first test checks that each is.
const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { serverFor } = require('../scripts/test-server');

jest.mock('xero-node', () => ({ AccountingApi: jest.fn(() => ({})) }));
jest.mock('axios', () => ({ put: jest.fn(), post: jest.fn(), get: jest.fn(), create: jest.fn() }));
jest.mock('../xero/invoices', () => ({
  createDraftInvoice: jest.fn(),
  updateDraftInvoice: jest.fn(),
}));
jest.mock('../utils/token-cache', () => {
  const mockState = { tenants: [] };
  return {
    forUser: () => ({ getAllTenants: () => mockState.tenants }),
    getPersistedTenants: () => mockState.tenants.map(t => ({ tenantId: t.tenant_id, tenantName: t.tenant_name })),
    _state: mockState,
  };
});
jest.mock('../xero/reconnect', () => ({ reconnectXero: jest.fn(async () => {}) }));
jest.mock('../utils/notify', () => ({
  notifyError: jest.fn(async () => {}), notifyInvoiceCreated: jest.fn(async () => {}), notifyErrorThrottled: jest.fn(async () => {}),
}));
jest.mock('../utils/receipt-parser', () => ({
  parseReceiptImage: jest.fn().mockResolvedValue(null),
  parseReceiptText:  jest.fn().mockResolvedValue(null),
  parseReceiptBatch: jest.fn().mockResolvedValue([]),
}));
jest.mock('../claims/category-account', () => ({ resolveAccountCode: jest.fn().mockResolvedValue(null) }));

describe('audit trail through the routes', () => {
  let app, db, users, jwtSecret, invoiceStore, xero, tokenCache, routes, auditContext;
  let owner, other, admin, store, n = 0;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    db           = require('../db');
    users        = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    invoiceStore = require('../utils/invoice-store');
    auditContext = require('../utils/audit-context');
    xero         = require('../xero/invoices');
    tokenCache   = require('../utils/token-cache');
    routes       = require('./invoices');
    routes.sendPacing.gapMs = 0;

    tokenCache._state.tenants = [{ tenant_id: 't-1', tenant_name: 'Acme Holdings' }];
    let seq = 0;
    xero.createDraftInvoice.mockReset().mockImplementation(async () => ({ invoiceID: `xero-new-${++seq}` }));
    xero.updateDraftInvoice.mockReset().mockImplementation(async (_u, _t, id) => ({ invoiceID: id }));

    const tag = `${Date.now()}-${n++}`;
    owner = await users.createUser(`owner${tag}@test.com`, 'password123', 'user');
    other = await users.createUser(`other${tag}@test.com`, 'password123', 'user');
    admin = await users.createUser(`admin${tag}@test.com`, 'password123', 'admin');
    store = invoiceStore.forUser(owner.id);

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/invoices', routes);
    app.use('/api/admin', require('./admin'));
    app.use('/api/auth', require('./auth'));
    app.use('/api/receipts', require('./receipts'));
  });

  const token = u => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const api = (verb, path, u = owner) => request(serverFor(app))[verb](path).set('Authorization', token(u));
  const add = (id, extra = {}) => store.add({
    id, status: 'pending', invoiceType: 'ACCPAY', source: 'upload', vendorName: `Vendor ${id}`, invoiceNumber: `N-${id}`,
    invoiceDate: '2026-09-01', totalAmount: 10, currency: 'SGD', processedAt: new Date().toISOString(), ...extra,
  });
  const events = id => db.prepare('SELECT * FROM invoice_events WHERE invoice_id = ? ORDER BY id').all(id)
    .map(e => ({ ...e, details: e.details ? JSON.parse(e.details) : null }));
  const adminEvents = () => db.prepare('SELECT * FROM admin_events ORDER BY id').all();

  test('the Xero SDK, axios, the Xero edge, the connection and the reader are test doubles', () => {
    expect(jest.isMockFunction(require('xero-node').AccountingApi)).toBe(true);
    expect(jest.isMockFunction(require('axios').post)).toBe(true);
    expect(jest.isMockFunction(require('axios').put)).toBe(true);
    expect(jest.isMockFunction(xero.createDraftInvoice)).toBe(true);
    expect(jest.isMockFunction(require('../xero/reconnect').reconnectXero)).toBe(true);
    expect(jest.isMockFunction(require('../utils/notify').notifyInvoiceCreated)).toBe(true);
    expect(jest.isMockFunction(require('../utils/receipt-parser').parseReceiptImage)).toBe(true);
  });

  describe('events written by requests', () => {
    test('an edit is the owner\'s, with what changed', async () => {
      add('a');
      await api('patch', '/api/invoices/a').send({ vendorName: 'Vendor a', totalAmount: 12.5, accountCode: '400' }).expect(200);
      const edited = events('a').find(e => e.action === 'edited');
      expect(edited).toMatchObject({ actor_type: 'user', actor_id: String(owner.id), actor_email: owner.email, summary: 'Changed total and account' });
      expect(edited.details.changes).toEqual([
        { field: 'totalAmount', label: 'total', from: '10.00', to: '12.50' },
        { field: 'accountCode', label: 'account', from: null, to: '400' },
      ]);
    });

    test('marked reviewed, reported with its note, then resolved by an admin acting on the owner\'s record', async () => {
      add('a', { status: 'review-needed' });
      await api('patch', '/api/invoices/a/status').send({ status: 'reviewed' }).expect(200);
      await api('post', '/api/invoices/a/report').send({ note: 'Total looks wrong' }).expect(200);
      await api('patch', `/api/admin/reports/${owner.id}/a/resolve`, admin).expect(200);

      const es = events('a');
      expect(es.map(e => [e.action, e.actor_type])).toEqual([
        ['created', 'system'], ['reviewed', 'user'], ['reported', 'user'], ['report.resolved', 'admin'],
      ]);
      expect(es[2].summary).toBe('Reported a problem: Total looks wrong');
      expect(es[3]).toMatchObject({ actor_email: admin.email, user_id: String(owner.id), summary: 'Report resolved; now reviewed' });

      const resolve = adminEvents().find(e => e.action === 'report.resolve');
      expect(resolve).toMatchObject({ actor_id: String(admin.id), target_user_id: String(owner.id), target_email: owner.email });
      expect(JSON.parse(resolve.details)).toMatchObject({ invoiceId: 'a', vendorName: 'Vendor a', invoiceNumber: 'N-a', status: 'reviewed' });
    });

    test('a duplicate confirmed as a different bill', async () => {
      add('a');
      add('b', { status: 'duplicate', duplicateOf: 'a' });
      await api('patch', '/api/invoices/b/status').send({ status: 'reviewed', force: true }).expect(200);
      expect(events('b').pop()).toMatchObject({ action: 'duplicate.cleared', summary: 'Confirmed not a duplicate; now reviewed', actor_type: 'user' });
    });

    test('deleted by its owner; the history is still there, to the owner only', async () => {
      add('a');
      await api('delete', '/api/invoices/a').expect(200);
      const gone = events('a').pop();
      expect(gone).toMatchObject({ action: 'deleted', actor_type: 'user', summary: 'Deleted: Vendor a N-a, SGD 10.00' });
      const res = await api('get', '/api/invoices/a/events').expect(200);
      expect(res.body.events.map(e => e.action)).toEqual(['deleted', 'created']);
      await api('get', '/api/invoices/a/events', other).expect(404);
    });
  });

  test('with the trail unwritable, edits, deletes, sends and admin actions all still go through', async () => {
    add('a'); add('b'); add('c');
    db.exec('DROP TABLE invoice_events; DROP TABLE admin_events;');
    await api('patch', '/api/invoices/a').send({ totalAmount: 12 }).expect(200);
    await api('delete', '/api/invoices/b').expect(200);
    await api('post', '/api/invoices/c/submit').send({}).expect(202);
    // The submit route sends in the background; wait for it to land.
    for (let i = 0; i < 200 && store.getById('c').status !== 'posted'; i++) await new Promise(r => setTimeout(r, 10));
    await api('post', `/api/admin/users/${other.id}/sign-out`, admin).expect(200);
    expect(store.getById('a').totalAmount).toBe(12);
    expect(store.getById('b')).toBeNull();
    expect(store.getById('c')).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-new-1' });
    expect(xero.createDraftInvoice).toHaveBeenCalledTimes(1);
  });

  describe('bulk actions write one event per record', () => {
    test('Mark reviewed on a selection', async () => {
      add('a'); add('b'); add('c', { status: 'duplicate', duplicateOf: 'a' });
      await api('post', '/api/invoices/bulk/review').send({ ids: ['a', 'b', 'c'] }).expect(200);
      for (const id of ['a', 'b']) {
        const reviewed = events(id).filter(e => e.action === 'reviewed');
        expect(reviewed).toHaveLength(1);
        expect(reviewed[0].summary).toBe('Marked reviewed (part of a bulk Mark reviewed)');
        expect(reviewed[0].details.bulk).toBe('review');
      }
      // Refused, so nothing happened to it and nothing is written.
      expect(events('c').map(e => e.action)).toEqual(['created']);
    });

    test('Delete on a selection', async () => {
      add('a'); add('b'); add('kept', { status: 'posted', xeroInvoiceId: 'x-1' });
      await api('post', '/api/invoices/bulk/delete').send({ ids: ['a', 'b', 'kept'] }).expect(200);
      for (const id of ['a', 'b']) {
        const gone = events(id).filter(e => e.action === 'deleted');
        expect(gone).toHaveLength(1);
        expect(gone[0]).toMatchObject({ actor_type: 'user', summary: `Deleted: Vendor ${id} N-${id}, SGD 10.00 (part of a bulk delete)` });
      }
      expect(events('kept').map(e => e.action)).toEqual(['created']);
    });

    test('Send to Xero on a selection: each send says where it went, and that it was one of several', async () => {
      add('a'); add('b');
      await api('post', '/api/invoices/bulk/send').send({ ids: ['a', 'b'] }).expect(200);
      await routes.whenSendsIdle(owner.id);
      for (const id of ['a', 'b']) {
        const sent = events(id).filter(e => e.action === 'xero.sent');
        expect(sent).toHaveLength(1);
        expect(sent[0].actor_type).toBe('user');
        expect(sent[0].summary).toMatch(/^Sent to Xero as a new draft in Acme Holdings \(Xero ID xero-new-\d\) \(part of a bulk Send to Xero\)$/);
        expect(sent[0].details).toMatchObject({ mode: 'create', tenantId: 't-1', tenantName: 'Acme Holdings', bulk: 'send' });
        // The closing patch of the send adds no "edited" of its own.
        expect(events(id).map(e => e.action)).toEqual(['created', 'xero.sent']);
      }
    });
  });

  describe('Xero sends', () => {
    test('a failure records Xero\'s reason; a correction says it updated the draft', async () => {
      add('a');
      xero.createDraftInvoice.mockRejectedValueOnce(new Error('Contact name is required'));
      const { submitInvoiceToXero } = require('../utils/invoice-handler');
      await expect(submitInvoiceToXero(owner.id, 'a')).rejects.toThrow('Contact name is required');
      expect(events('a').pop()).toMatchObject({ action: 'xero.failed', actor_type: 'system', summary: 'Sending to Xero failed: Contact name is required' });

      add('b', { status: 'posted', xeroInvoiceId: 'x-b', xeroTenantId: 't-1' });
      await auditContext.runForRequest({ user: owner }, () => submitInvoiceToXero(owner.id, 'b'));
      expect(events('b').pop()).toMatchObject({ action: 'xero.sent', actor_type: 'user', summary: 'Correction sent to Xero, updating the draft in Acme Holdings' });
    });

    test('a match for a bill already in Xero is marked duplicate, not sent', async () => {
      add('a', { status: 'posted', xeroInvoiceId: 'x-a', vendorName: 'Acme', invoiceNumber: 'INV-1' });
      add('b', { vendorName: 'Acme', invoiceNumber: 'INV-1' });
      const { submitInvoiceToXero } = require('../utils/invoice-handler');
      await submitInvoiceToXero(owner.id, 'b');
      expect(events('b').pop()).toMatchObject({ action: 'duplicate.marked', summary: 'Marked as a duplicate of INV-1 (Acme)' });
      expect(xero.createDraftInvoice).not.toHaveBeenCalled();
    });
  });

  describe('background work is the system', () => {
    test('an emailed bill stored by the intake handler, outside any request', async () => {
      require('../utils/settings-store').forUser(owner.id).set({ autoProcess: false });
      const handler = require('../utils/invoice-handler').createHandler(owner.id);
      const r = await handler.onInvoiceEmail({
        vendorName: 'Mail Co', invoiceNumber: 'M-1', invoiceDate: '2026-09-02', totalAmount: 50, currency: 'SGD',
        source: 'pdf', sourceEmail: 'ap@mail.test', invoiceType: 'ACCPAY',
      });
      expect(events(r.id)[0]).toMatchObject({ action: 'created', actor_type: 'system' });
      expect(events(r.id)[0].summary).toMatch(/^Created from an emailed PDF \(from ap@mail\.test\): Mail Co M-1, SGD 50\.00/);
    });

    test('a receipt uploaded by its owner, then read in the background by the system', async () => {
      require('../utils/receipt-parser').parseReceiptImage.mockResolvedValueOnce({
        receipts: [{ merchant: 'Grab', date: '2026-09-03', total: 18.4, currency: 'SGD' }], split: false,
      });
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01]).toString('base64');
      const res = await api('post', '/api/receipts').send({ mime: 'image/jpeg', data: jpeg }).expect(201);
      await require('./receipts')._drain();
      const es = events(res.body.receipt.id);
      expect(es[0]).toMatchObject({ action: 'created', actor_type: 'user', summary: expect.stringMatching(/^Created from an uploaded receipt: EXP-/) });
      const read = es.find(e => e.action === 'edited');
      expect(read.actor_type).toBe('system');
      expect(read.summary).toMatch(/^Receipt read: changed vendor/);
      expect(read.details.changes).toEqual(expect.arrayContaining([{ field: 'vendorName', label: 'vendor', from: null, to: 'Grab' }]));
    });

    test('a phone capture is the owner\'s, though the link carries no session', async () => {
      const pairing = require('../utils/pairing');
      const link = pairing.create(owner.id);
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x02]).toString('base64');
      const res = await request(serverFor(app)).post(`/api/receipts/capture/${link}`).send({ mime: 'image/jpeg', data: jpeg }).expect(201);
      await require('./receipts')._drain();
      expect(events(res.body.receipt.id)[0]).toMatchObject({
        actor_type: 'user', actor_id: String(owner.id), actor_email: owner.email, summary: expect.stringMatching(/^Created from a phone capture: EXP-/),
      });
    });

    test('a worker kicked from a request runs as the system', () => {
      const real = global.setImmediate;
      let seen = null;
      const spy = jest.spyOn(global, 'setImmediate').mockImplementationOnce(fn => {
        seen = auditContext.actorFor(owner.id).type;
        return real(() => {});
      });
      auditContext.runForRequest({ user: owner }, () => require('../claims/claim-worker').kickWorker(owner.id));
      spy.mockRestore();
      expect(seen).toBe('system');
    });
  });

  describe('GET /api/invoices/:id/events', () => {
    test('requires a session', async () => {
      add('a');
      await request(serverFor(app)).get('/api/invoices/a/events').expect(401);
    });

    test('the owner and an admin may read it; another user gets the same 404 as no record at all', async () => {
      add('a');
      const mine = await api('get', '/api/invoices/a/events').expect(200);
      expect(mine.body.events[0]).toMatchObject({ action: 'created', actorType: 'system', summary: expect.stringMatching(/^Created/) });
      expect(mine.body.nextBefore).toBeNull();
      await api('get', '/api/invoices/a/events', admin).expect(200);
      const theirs = await api('get', '/api/invoices/a/events', other).expect(404);
      const nothing = await api('get', '/api/invoices/nope/events', other).expect(404);
      expect(theirs.body).toEqual(nothing.body);
      await api('get', '/api/invoices/nope/events', admin).expect(404);
    });

    test('a record with no history yet is an empty list, not a 404', async () => {
      add('a');
      db.prepare('DELETE FROM invoice_events').run();
      const res = await api('get', '/api/invoices/a/events').expect(200);
      expect(res.body).toEqual({ events: [], nextBefore: null });
    });

    test('newest first, capped and paged by before', async () => {
      add('a');
      const insert = db.prepare("INSERT INTO invoice_events (user_id, invoice_id, at, actor_type, action, summary) VALUES (?, 'a', ?, 'system', 'edited', ?)");
      for (let i = 0; i < 210; i++) insert.run(String(owner.id), new Date().toISOString(), `e${i}`);
      const first = await api('get', '/api/invoices/a/events').expect(200);
      expect(first.body.events).toHaveLength(200);
      expect(first.body.events[0].summary).toBe('e209');
      const second = await api('get', `/api/invoices/a/events?before=${first.body.nextBefore}`).expect(200);
      expect(second.body.events).toHaveLength(11);   // e9..e0 and "created"
      expect(second.body.nextBefore).toBeNull();
      const small = await api('get', '/api/invoices/a/events?limit=2').expect(200);
      expect(small.body.events.map(e => e.summary)).toEqual(['e209', 'e208']);
      await api('get', '/api/invoices/a/events?before=abc').expect(400);
      await api('get', '/api/invoices/a/events?limit=-1').expect(400);
    });
  });

  describe('admin actions', () => {
    const SECRET = 'Very-Secret-pass-123';

    test('every change is recorded with who and to whom, and no password ever', async () => {
      const created = await api('post', '/api/admin/users', admin).send({ email: `new${n}@test.com`, password: SECRET, role: 'user' }).expect(201);
      const target = created.body.user;
      await api('patch', `/api/admin/users/${target.id}/role`, admin).send({ role: 'admin' }).expect(200);
      await api('patch', `/api/admin/users/${target.id}/password`, admin).send({ password: `${SECRET}-2` }).expect(200);
      await api('post', `/api/admin/users/${target.id}/sign-out`, admin).expect(200);
      await api('patch', `/api/admin/users/${target.id}/disabled`, admin).send({ disabled: true }).expect(200);
      await api('patch', `/api/admin/users/${target.id}/disabled`, admin).send({ disabled: false }).expect(200);
      await api('patch', `/api/admin/users/${target.id}/auto-process`, admin).send({ autoProcess: false }).expect(200);
      await api('post', `/api/admin/users/${target.id}/watcher/stop`, admin).expect(200);
      await api('delete', `/api/admin/users/${target.id}`, admin).expect(200);

      const rows = adminEvents();
      expect(rows.map(r => r.action)).toEqual([
        'user.create', 'user.role', 'user.password_reset', 'user.sign_out', 'user.disable', 'user.enable',
        'user.auto_process_off', 'user.watcher_stop', 'user.delete',
      ]);
      for (const r of rows) {
        expect(r).toMatchObject({ actor_id: String(admin.id), actor_email: admin.email, target_user_id: String(target.id), target_email: target.email });
      }
      expect(JSON.parse(rows[1].details)).toEqual({ from: 'user', to: 'admin' });
      const everything = JSON.stringify(db.prepare('SELECT * FROM admin_events').all());
      expect(everything).not.toContain(SECRET);
      expect(everything).not.toMatch(/\$2[aby]\$/);   // no bcrypt hash either

      // The account is gone; its events still name it.
      const res = await api('get', `/api/admin/events?userId=${target.id}`, admin).expect(200);
      expect(res.body.events).toHaveLength(9);
      expect(res.body.events[0]).toMatchObject({ action: 'user.delete', targetEmail: target.email, summary: `Deleted ${target.email} (an admin)` });
    });

    test('a refused change records nothing', async () => {
      await api('patch', `/api/admin/users/${admin.id}/role`, admin).send({ role: 'user' }).expect(400);
      await api('patch', `/api/admin/users/${owner.id}/role`, owner).send({ role: 'admin' }).expect(403);
      expect(adminEvents()).toEqual([]);
    });

    test('changing your own password is recorded, without the password', async () => {
      await api('post', '/api/auth/change-password').send({ currentPassword: 'password123', newPassword: SECRET }).expect(200);
      const [row] = adminEvents();
      expect(row).toMatchObject({ action: 'password.change', actor_id: String(owner.id), target_user_id: String(owner.id) });
      expect(JSON.stringify(row)).not.toContain(SECRET);
    });

    test('signing in is not recorded', async () => {
      await request(serverFor(app)).post('/api/auth/login').send({ email: owner.email, password: 'password123' }).expect(200);
      await request(serverFor(app)).post('/api/auth/login').send({ email: owner.email, password: 'wrong-password' }).expect(401);
      expect(adminEvents()).toEqual([]);
    });
  });

  describe('GET /api/admin/events', () => {
    const at = iso => db.prepare('UPDATE admin_events SET at = ? WHERE id = (SELECT MAX(id) FROM admin_events)').run(iso);

    test('admins only', async () => {
      await api('get', '/api/admin/events', owner).expect(403);
      await request(serverFor(app)).get('/api/admin/events').expect(401);
    });

    test('filters by account, action and dates, newest first, and pages', async () => {
      await api('post', `/api/admin/users/${owner.id}/sign-out`, admin).expect(200);
      at('2026-09-01T10:00:00.000Z');
      await api('post', `/api/admin/users/${other.id}/sign-out`, admin).expect(200);
      at('2026-09-15T10:00:00.000Z');
      await api('patch', `/api/admin/users/${owner.id}/auto-process`, admin).send({ autoProcess: false }).expect(200);
      at('2026-10-01T10:00:00.000Z');

      const all = await api('get', '/api/admin/events', admin).expect(200);
      expect(all.body.events.map(e => e.action)).toEqual(['user.auto_process_off', 'user.sign_out', 'user.sign_out']);
      expect(all.body.actions['user.sign_out']).toBe('Signed a user out everywhere');

      const forOwner = await api('get', `/api/admin/events?userId=${owner.id}`, admin).expect(200);
      expect(forOwner.body.events.map(e => e.action)).toEqual(['user.auto_process_off', 'user.sign_out']);

      const signOuts = await api('get', '/api/admin/events?action=user.sign_out', admin).expect(200);
      expect(signOuts.body.events.map(e => e.targetEmail)).toEqual([other.email, owner.email]);
      expect(signOuts.body.events[0].summary).toBe(`Signed ${other.email} out everywhere`);

      const sept = await api('get', '/api/admin/events?from=2026-09-01&to=2026-09-30', admin).expect(200);
      expect(sept.body.events.map(e => e.at)).toEqual(['2026-09-15T10:00:00.000Z', '2026-09-01T10:00:00.000Z']);
      const instant = await api('get', `/api/admin/events?from=${encodeURIComponent('2026-09-15T10:00:00.000Z')}`, admin).expect(200);
      expect(instant.body.events).toHaveLength(2);

      const page1 = await api('get', '/api/admin/events?limit=2', admin).expect(200);
      expect(page1.body.events).toHaveLength(2);
      const page2 = await api('get', `/api/admin/events?limit=2&before=${page1.body.nextBefore}`, admin).expect(200);
      expect(page2.body.events.map(e => e.at)).toEqual(['2026-09-01T10:00:00.000Z']);
      expect(page2.body.nextBefore).toBeNull();

      await api('get', '/api/admin/events?action=nope', admin).expect(400);
      await api('get', '/api/admin/events?from=yesterday', admin).expect(400);
    });
  });
});
