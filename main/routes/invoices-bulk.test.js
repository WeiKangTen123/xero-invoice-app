const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

// Mark reviewed, Send to Xero and Delete on a selection: one request per
// action, one answer per id.
//
// Nothing here can reach Xero. The Xero calls are stubbed at the edge
// (xero/invoices) as invoice-handler.test.js does, and the connection is a
// fake one. Everything between the route and that edge runs for real:
// submitInvoiceToXero with its duplicate check and claimForSubmit, the
// processor's choice of company, and the store. submitInvoiceToXero is
// wrapped in a spy that calls the real one, so the tests can also see that
// the bulk send went through it and not round it.
jest.mock('../xero/invoices', () => ({
  createDraftInvoice: jest.fn(),
  updateDraftInvoice: jest.fn(),
}));
jest.mock('../utils/token-cache', () => {
  const mockState = { tenants: [] };
  return { forUser: () => ({ getAllTenants: () => mockState.tenants }), getPersistedTenants: () => [], _state: mockState };
});
jest.mock('../xero/reconnect', () => ({ reconnectXero: jest.fn(async () => {}) }));
jest.mock('../utils/notify', () => ({ notifyError: jest.fn(async () => {}), notifyInvoiceCreated: jest.fn(async () => {}) }));
jest.mock('../utils/invoice-handler', () => {
  const actual = jest.requireActual('../utils/invoice-handler');
  return { ...actual, submitInvoiceToXero: jest.fn(actual.submitInvoiceToXero) };
});

describe('bulk actions on a selection', () => {
  let app, routes, users, jwtSecret, testUser, store, handler, xero, tokenCache, n = 0;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users        = require('../utils/users');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    handler      = require('../utils/invoice-handler');
    xero         = require('../xero/invoices');
    tokenCache   = require('../utils/token-cache');
    routes       = require('./invoices');
    // A real gap would make each queued send here wait 1.5 s.
    routes.sendPacing.gapMs = 0;

    tokenCache._state.tenants = [{ tenant_id: 't-1', tenant_name: 'One' }];
    let seq = 0;
    xero.createDraftInvoice.mockReset().mockImplementation(async () => ({ invoiceID: `xero-new-${++seq}` }));
    xero.updateDraftInvoice.mockReset().mockImplementation(async (_u, _t, id) => ({ invoiceID: id }));

    testUser = await users.createUser(`bulk${Date.now()}-${n++}@test.com`, 'password123', 'user');
    store    = require('../utils/invoice-store').forUser(testUser.id);

    app = express();
    app.use(express.json());
    app.use('/api/invoices', routes);
  });

  const auth = () => `Bearer ${jwt.sign({ id: testUser.id, email: testUser.email, role: testUser.role }, jwtSecret())}`;
  const post = (action, body) => request(serverFor(app)).post(`/api/invoices/bulk/${action}`).set('Authorization', auth()).send(body);
  const add = (id, extra = {}) => store.add({
    id, status: 'pending', invoiceType: 'ACCPAY', vendorName: `Vendor ${id}`, invoiceNumber: `N-${id}`,
    invoiceDate: '2026-09-01', totalAmount: 10, processedAt: new Date().toISOString(), ...extra,
  });
  const byId = res => Object.fromEntries(res.body.results.map(r => [r.id, r]));
  const sentIds = () => handler.submitInvoiceToXero.mock.calls.map(([, id]) => id);

  describe('the request', () => {
    test.each(['review', 'send', 'delete'])('%s: ids must be a non-empty list of strings', async action => {
      add('a');
      for (const body of [{}, { ids: [] }, { ids: 'a' }, { ids: [1] }, { ids: [''] }, { ids: null }]) {
        await post(action, body).expect(400);
      }
      expect(store.getById('a').status).toBe('pending');
      expect(handler.submitInvoiceToXero).not.toHaveBeenCalled();
    });

    test.each(['review', 'send', 'delete'])('%s: at most 200 ids; 201 is refused whole', async action => {
      add('a');
      const ids = ['a', ...Array.from({ length: 200 }, (_, i) => `missing-${i}`)];
      const res = await post(action, { ids }).expect(400);
      expect(res.body.error).toMatch(/At most 200/);
      expect(store.getById('a')).not.toBeNull();
      expect(store.getById('a').status).toBe('pending');
      expect(handler.submitInvoiceToXero).not.toHaveBeenCalled();
    });

    test('200 is accepted, and a repeated id is answered once', async () => {
      add('a');
      const ids = ['a', 'a', ...Array.from({ length: 198 }, (_, i) => `missing-${i}`)];
      const res = await post('review', { ids }).expect(200);
      expect(res.body.results).toHaveLength(199);
      expect(res.body.results[0]).toEqual({ id: 'a', ok: true, skipped: false, outcome: 'Marked reviewed', message: '' });
      expect(res.body.summary).toEqual({ done: 1, skipped: 0, failed: 198 });
    });

    test('another account\'s record is not found, and is left alone', async () => {
      const other = await users.createUser(`other${Date.now()}-${n++}@test.com`, 'password123', 'user');
      const theirs = require('../utils/invoice-store').forUser(other.id);
      theirs.add({ id: 'theirs', status: 'pending', vendorName: 'B', totalAmount: 5, processedAt: new Date().toISOString() });
      for (const action of ['review', 'send', 'delete']) {
        const res = await post(action, { ids: ['theirs'] }).expect(200);
        expect(res.body.results[0].outcome).toMatch(/Not found|Already deleted/);
      }
      expect(theirs.getById('theirs').status).toBe('pending');
      await routes.whenSendsIdle(testUser.id);
      expect(handler.submitInvoiceToXero).not.toHaveBeenCalled();
    });
  });

  describe('Mark reviewed', () => {
    test('answers each row on its own, in the order asked', async () => {
      add('pend');
      add('err', { status: 'error', errorMsg: 'Xero was down' });
      add('held', { status: 'review-needed' });
      add('done', { status: 'reviewed' });
      add('inx', { status: 'posted', xeroInvoiceId: 'x-1' });
      add('dup', { status: 'duplicate', duplicateOf: 'inx' });
      add('zero', { totalAmount: 0 });
      add('busy', { status: 'submitting' });

      const res = await post('review', { ids: ['pend', 'err', 'held', 'done', 'inx', 'dup', 'zero', 'busy', 'gone'] }).expect(200);
      expect(res.body.action).toBe('review');
      expect(res.body.results.map(r => [r.id, r.ok, r.skipped, r.outcome])).toEqual([
        ['pend', true,  false, 'Marked reviewed'],
        ['err',  true,  false, 'Marked reviewed'],
        ['held', true,  false, 'Marked reviewed'],
        ['done', true,  true,  'Already reviewed'],
        ['inx',  true,  true,  'Already in Xero'],
        ['dup',  false, false, 'Marked as a duplicate'],
        ['zero', false, false, 'Needs review first'],
        ['busy', true,  true,  'Being sent to Xero right now'],
        ['gone', false, false, 'Not found'],
      ]);
      expect(res.body.summary).toEqual({ done: 3, skipped: 3, failed: 3 });
      for (const id of ['pend', 'err', 'held', 'done']) expect(store.getById(id).status).toBe('reviewed');
      expect(store.getById('inx').status).toBe('posted');
      expect(store.getById('dup').status).toBe('duplicate');
      expect(store.getById('zero').status).toBe('pending');
      expect(store.getById('busy').status).toBe('submitting');
    });

    // The fraud hold: a supplier's bank account changed since their last
    // bill. A person must read that before the bill is one click from Xero.
    test('a bill whose bank details changed is not marked reviewed from a list', async () => {
      add('last', { vendorName: 'Acme Supplies', status: 'posted', xeroInvoiceId: 'x-last', paymentReference: 'Account 123-456-789' });
      add('new',  { vendorName: 'Acme Supplies', status: 'review-needed', paymentReference: 'Account 987-654-321' });
      const res = await post('review', { ids: ['new'] }).expect(200);
      expect(res.body.results[0]).toMatchObject({ ok: false, outcome: 'Needs review first' });
      expect(res.body.results[0].message).toMatch(/Bank details differ/);
      expect(store.getById('new').status).toBe('review-needed');
    });
  });

  describe('Send to Xero', () => {
    test('queues what may go, says why the rest did not, and sends through the one shared path', async () => {
      add('pend');
      add('rev',  { status: 'reviewed' });
      add('err',  { status: 'error', errorMsg: 'Xero was down' });
      add('held', { status: 'review-needed', errorMsg: 'Could not read an invoice number from the PDF' });
      add('draft', { status: 'posted', xeroInvoiceId: 'x-draft' });
      add('appr',  { status: 'posted', xeroInvoiceId: 'x-appr' });
      // What Xero said when last asked (xero/status-sync.js writes it this way).
      store.recordXeroStatus('draft', 'x-draft', { status: 'DRAFT', amountDue: 10, amountPaid: 0 });
      store.recordXeroStatus('appr',  'x-appr',  { status: 'AUTHORISED', amountDue: 10, amountPaid: 0 });
      add('orig',  { status: 'posted', xeroInvoiceId: 'x-orig', vendorName: 'Same Co', invoiceNumber: 'S-1' });
      add('copy',  { vendorName: 'Same Co', invoiceNumber: 'S-1' });
      add('zero',  { totalAmount: 0 });
      add('rep',   { status: 'reported' });
      add('dupe',  { status: 'duplicate', duplicateOf: 'orig' });

      const ids = ['pend', 'rev', 'err', 'held', 'draft', 'appr', 'copy', 'zero', 'rep', 'dupe', 'gone'];
      const res = await post('send', { ids }).expect(200);
      const r = byId(res);
      expect(res.body.action).toBe('send');
      expect(res.body.results.map(x => x.id)).toEqual(ids);

      for (const id of ['pend', 'rev', 'err']) expect(r[id]).toMatchObject({ ok: true, skipped: false, outcome: 'Queued for Xero' });
      expect(r.held).toEqual({ id: 'held', ok: false, skipped: false, outcome: 'Needs review first', message: 'Could not read an invoice number from the PDF' });
      expect(r.draft).toMatchObject({ ok: true, skipped: true, outcome: 'Already in Xero' });
      expect(r.appr).toMatchObject({ ok: true, skipped: true, outcome: 'Approved in Xero, so it can no longer be changed from here' });
      expect(r.copy).toMatchObject({ ok: false, outcome: 'Matches a bill already in Xero' });
      expect(r.copy.message).toMatch(/Same Co S-1/);
      expect(r.zero).toMatchObject({ ok: false, outcome: 'Needs review first' });
      expect(r.rep).toMatchObject({ ok: false, outcome: 'Reported as a problem' });
      expect(r.dupe).toMatchObject({ ok: false, outcome: 'Marked as a duplicate' });
      expect(r.gone).toMatchObject({ ok: false, outcome: 'Not found' });
      expect(res.body.summary).toEqual({ done: 3, skipped: 2, failed: 6 });

      await routes.whenSendsIdle(testUser.id);
      // Only the queued three, in order, each through submitInvoiceToXero
      // with no permission to send a duplicate.
      expect(handler.submitInvoiceToXero.mock.calls).toEqual([
        [testUser.id, 'pend'], [testUser.id, 'rev'], [testUser.id, 'err'],
      ]);
      expect(xero.createDraftInvoice).toHaveBeenCalledTimes(3);
      // A row already in Xero is never re-posted from a list.
      expect(xero.updateDraftInvoice).not.toHaveBeenCalled();
      for (const id of ['pend', 'rev', 'err']) {
        expect(store.getById(id)).toMatchObject({ status: 'posted', xeroTenantId: 't-1' });
        expect(store.getById(id).xeroInvoiceId).toMatch(/^xero-new-/);
      }
      expect(store.getById('held').status).toBe('review-needed');
      expect(store.getById('copy').status).toBe('pending');
    });

    test('one at a time: never two sends in flight, with the gap between them', async () => {
      routes.sendPacing.gapMs = 60;
      let inFlight = 0, most = 0;
      const spans = [];
      xero.createDraftInvoice.mockImplementation(async (_u, _t, data) => {
        inFlight++; most = Math.max(most, inFlight);
        const start = Date.now();
        await new Promise(r => setTimeout(r, 15));
        inFlight--;
        spans.push([start, Date.now()]);
        return { invoiceID: `xero-${data._invoiceStoreId}` };
      });
      for (const id of ['a', 'b', 'c', 'd']) add(id);
      await post('send', { ids: ['a', 'b'] }).expect(200);
      // A second selection sent while the first is still going joins the same
      // queue rather than starting a second one beside it.
      await post('send', { ids: ['c', 'd'] }).expect(200);
      await routes.whenSendsIdle(testUser.id);

      expect(most).toBe(1);
      expect(sentIds()).toEqual(['a', 'b', 'c', 'd']);
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i][0] - spans[i - 1][1]).toBeGreaterThanOrEqual(55); // timers may fire a few ms early
      }
    });

    // Xero says on every answer how many calls the company has left this
    // minute. Nearly none left: the next send waits for the minute to turn
    // over instead of walking into a 429.
    test('waits for the minute to turn over when Xero says few calls are left', async () => {
      const spans = [];
      xero.createDraftInvoice.mockImplementation(async (_u, _t, data) => {
        const start = Date.now();
        await new Promise(r => setTimeout(r, 5));
        spans.push([start, Date.now()]);
        return { invoiceID: `xero-${data._invoiceStoreId}` };
      });
      // Three calls left, as Xero reported 59 s ago: the minute turns over in
      // about a second.
      require('../xero/xero-utils')._recordRateLimit('t-1', { 'x-minlimit-remaining': '3' }, Date.now() - 59_000);
      add('a'); add('b');
      await post('send', { ids: ['a', 'b'] }).expect(200);
      await routes.whenSendsIdle(testUser.id);
      expect(sentIds()).toEqual(['a', 'b']);
      expect(spans[1][0] - spans[0][1]).toBeGreaterThanOrEqual(600);
    });

    test('Submit all shares the queue with Send to Xero', async () => {
      routes.sendPacing.gapMs = 40;
      let inFlight = 0, most = 0;
      xero.createDraftInvoice.mockImplementation(async (_u, _t, data) => {
        inFlight++; most = Math.max(most, inFlight);
        await new Promise(r => setTimeout(r, 10));
        inFlight--;
        return { invoiceID: `xero-${data._invoiceStoreId}` };
      });
      for (const id of ['a', 'b', 'c']) add(id);
      await post('send', { ids: ['a', 'b'] }).expect(200);
      await request(serverFor(app)).post('/api/invoices/submit-all').set('Authorization', auth()).send({ ids: ['c'] }).expect(200);
      await routes.whenSendsIdle(testUser.id);
      expect(most).toBe(1);
      expect(sentIds()).toEqual(['a', 'b', 'c']);
    });

    test('a row already waiting in the queue is not queued twice', async () => {
      routes.sendPacing.gapMs = 200;
      add('a'); add('b');
      await post('send', { ids: ['a', 'b'] }).expect(200);
      const again = await post('send', { ids: ['b'] }).expect(200);
      expect(again.body.results[0]).toMatchObject({ ok: true, skipped: true, outcome: 'Already queued for Xero' });
      await routes.whenSendsIdle(testUser.id);
      expect(sentIds()).toEqual(['a', 'b']);
    });

    // claimForSubmit is the lock every sender takes. A row someone else has
    // claimed is not sent again, whether the claim came first or while the
    // row waited its turn.
    test('a row claimed by another send is left to it', async () => {
      routes.sendPacing.gapMs = 150;
      add('claimed'); add('first'); add('later');
      store.claimForSubmit('claimed');
      const res = await post('send', { ids: ['claimed', 'first', 'later'] }).expect(200);
      expect(byId(res).claimed).toMatchObject({ ok: true, skipped: true, outcome: 'Already being sent to Xero' });

      // 'later' is claimed elsewhere (the Submit button, the boot retry) while
      // it waits behind 'first'.
      store.claimForSubmit('later');
      await routes.whenSendsIdle(testUser.id);
      expect(sentIds()).toEqual(['first']);
      expect(xero.createDraftInvoice).toHaveBeenCalledTimes(1);
      expect(store.getById('later').status).toBe('submitting');
    });

    test('checked again at its turn: edited back to review or deleted meanwhile', async () => {
      routes.sendPacing.gapMs = 150;
      add('first'); add('reheld'); add('deleted'); add('fine');
      await post('send', { ids: ['first', 'reheld', 'deleted', 'fine'] }).expect(200);
      store.update('reheld', { status: 'review-needed' });
      store.remove('deleted');
      await routes.whenSendsIdle(testUser.id);
      expect(sentIds()).toEqual(['first', 'fine']);
      expect(store.getById('reheld').status).toBe('review-needed');
    });

    test('an account disabled while its rows wait sends nothing more', async () => {
      // The first send is still on its way when the account is disabled; the
      // one behind it must not follow.
      xero.createDraftInvoice.mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 200));
        return { invoiceID: 'xero-slow' };
      });
      add('slow'); add('x');
      await post('send', { ids: ['slow', 'x'] }).expect(200);
      users.setDisabled(testUser.id, true);
      await routes.whenSendsIdle(testUser.id);
      expect(sentIds()).toEqual(['slow']);
      expect(store.getById('x').status).toBe('pending');
    });

    // Two copies of one bill in the same selection both pass the check when
    // asked, the first still on its way to Xero. The second is caught at its
    // turn by submitInvoiceToXero, which marks it a duplicate where it can be
    // seen.
    test('two copies of one bill in one selection: one goes, the other is marked a duplicate', async () => {
      xero.createDraftInvoice.mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 150));
        return { invoiceID: 'xero-twin' };
      });
      add('one', { vendorName: 'Twin Co', invoiceNumber: 'T-1' });
      add('two', { vendorName: 'Twin Co', invoiceNumber: 'T-1' });
      const res = await post('send', { ids: ['one', 'two'] }).expect(200);
      expect(res.body.summary.done).toBe(2);
      await routes.whenSendsIdle(testUser.id);
      expect(xero.createDraftInvoice).toHaveBeenCalledTimes(1);
      expect(store.getById('one').status).toBe('posted');
      expect(store.getById('two')).toMatchObject({ status: 'duplicate', duplicateOf: 'one' });
    });

    test('a failed send is written on its row and the queue carries on', async () => {
      xero.createDraftInvoice
        .mockImplementationOnce(async () => { throw new Error('Xero refused the contact'); })
        .mockImplementationOnce(async () => ({ invoiceID: 'xero-ok' }));
      add('bad'); add('good');
      await post('send', { ids: ['bad', 'good'] }).expect(200);
      await routes.whenSendsIdle(testUser.id);
      expect(store.getById('bad')).toMatchObject({ status: 'error', errorMsg: expect.stringMatching(/refused the contact/) });
      expect(store.getById('good')).toMatchObject({ status: 'posted', xeroInvoiceId: 'xero-ok' });
    });
  });

  describe('Delete', () => {
    test('deletes what exists only here and keeps what is in Xero or mid-send, saying why', async () => {
      const pdfs = require('../utils/pdf-store').forUser(testUser.id);
      add('local', { hasPdf: true });
      pdfs.save('local', Buffer.from('%PDF-1.4 a'));
      add('inx', { status: 'posted', xeroInvoiceId: 'x-1', hasPdf: true });
      pdfs.save('inx', Buffer.from('%PDF-1.4 b'));
      add('errx', { status: 'error', xeroInvoiceId: 'x-2' });
      add('busy', { status: 'submitting' });

      const res = await post('delete', { ids: ['local', 'inx', 'errx', 'busy', 'gone'] }).expect(200);
      expect(res.body.results.map(r => [r.id, r.ok, r.skipped, r.outcome])).toEqual([
        ['local', true,  false, 'Deleted'],
        ['inx',   false, false, 'Kept: already in Xero'],
        ['errx',  false, false, 'Kept: already in Xero'],
        ['busy',  false, false, 'Kept: being sent to Xero right now'],
        ['gone',  true,  true,  'Already deleted'],
      ]);
      expect(byId(res).inx.message).toBe('Void or delete it in Xero first.');
      expect(res.body.summary).toEqual({ done: 1, skipped: 1, failed: 3 });
      expect(store.getById('local')).toBeNull();
      expect(pdfs.exists('local')).toBe(false);
      for (const id of ['inx', 'errx', 'busy']) expect(store.getById(id)).not.toBeNull();
      expect(pdfs.exists('inx')).toBe(true);
    });

    test('split siblings share one receipt photo; it goes with the last of them', async () => {
      const receipts = require('../utils/receipt-store').forUser(testUser.id);
      const file = receipts.save('s1', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg');
      add('s1', { invoiceType: 'EXPENSE', receiptFile: file, receiptGroup: 'g' });
      add('s2', { invoiceType: 'EXPENSE', receiptFile: file, receiptGroup: 'g' });
      add('s3', { invoiceType: 'EXPENSE', receiptFile: file, receiptGroup: 'g' });

      await post('delete', { ids: ['s1', 's2'] }).expect(200);
      expect(receipts.exists(file)).toBe(true);
      await post('delete', { ids: ['s3'] }).expect(200);
      expect(receipts.exists(file)).toBe(false);
    });
  });
});
