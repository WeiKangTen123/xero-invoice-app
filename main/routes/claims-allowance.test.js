// Mileage and per diem claims: no receipt, typed in, priced on the server from
// the rate in Setup. Nothing in this file reaches Xero — the routes under test
// only write the local store.
const request = require('supertest');
const { serverFor } = require('../scripts/test-server');
const express = require('express');
const jwt     = require('jsonwebtoken');

describe('routes/claims — mileage and per diem', () => {
  let app, users, invoiceStore, jwtSecret, user;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users        = require('../utils/users');
    invoiceStore = require('../utils/invoice-store');
    ({ jwtSecret } = require('../middleware/auth-middleware'));
    app = express();
    app.use(express.json());
    app.use('/api/claims', require('./claims'));
    user = await users.createUser(`al${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.com`, 'password123', 'user');
    setRates({ MILEAGE_RATE: '0.60', PER_DIEM_RATE: '80' });
  });

  function setRates(patch) {
    const { values, errors } = users.checkAllowanceSettings(patch);
    expect(errors).toEqual([]);
    users.saveUserConfig(user.id, values);
  }

  const auth = (u = user) => `Bearer ${jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret())}`;
  const post  = (body, u = user) => request(serverFor(app)).post('/api/claims/allowance').set('Authorization', auth(u)).send(body);
  const patch = (id, body, u = user) => request(serverFor(app)).patch(`/api/claims/allowance/${id}`).set('Authorization', auth(u)).send(body);

  const mileage = (extra = {}) => ({
    kind: 'mileage', date: '2026-10-03', from: 'Office', to: 'Client A', purpose: 'site visit', distanceKm: 42, ...extra,
  });
  const perDiem = (extra = {}) => ({
    kind: 'per_diem', startDate: '2026-10-01', endDate: '2026-10-03', destination: 'Kuala Lumpur', purpose: 'conference', ...extra,
  });

  describe('authentication', () => {
    test('every allowance route refuses a request with no token', async () => {
      const s = serverFor(app);
      await request(s).get('/api/claims/allowance/settings').expect(401);
      await request(s).post('/api/claims/allowance').send(mileage()).expect(401);
      await request(s).patch('/api/claims/allowance/x').send(mileage()).expect(401);
    });

    test('one account cannot edit another account\'s claim', async () => {
      const { body } = await post(mileage()).expect(201);
      const other = await users.createUser(`other${Date.now()}@test.com`, 'password123', 'user');
      await patch(body.claim.id, mileage({ distanceKm: 10 }), other).expect(404);
      expect(invoiceStore.forUser(user.id).getById(body.claim.id).totalAmount).toBe(25.2);
    });

    // index.js treats an unhandled rejection as fatal, so an async handler
    // must go through asyncHandler (scripts/async-routes.test.js checks every
    // route file). These three do no async work and are plain functions,
    // whose throws Express already catches; this pins that they stay so, or
    // are wrapped if they ever become async.
    test('the allowance handlers are synchronous or wrapped in asyncHandler', () => {
      const espree = require('espree');
      const src = require('fs').readFileSync(require('path').join(__dirname, 'claims.js'), 'utf8');
      const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'commonjs' });
      const found = [];
      (function walk(node) {
        if (node && node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
            && node.callee.object.name === 'router' && node.arguments[0]?.type === 'Literal'
            && String(node.arguments[0].value).startsWith('/allowance')) {
          const handlers = node.arguments.slice(1);
          found.push(node.arguments[0].value);
          expect(handlers[0].name).toBe('requireAuth');
          for (const h of handlers.slice(1)) {
            const wrapped = h.type === 'CallExpression' && h.callee.name === 'asyncHandler';
            expect(wrapped || h.async !== true).toBe(true);
          }
        }
        for (const v of Object.values(node || {})) {
          for (const child of Array.isArray(v) ? v : [v]) if (child && typeof child.type === 'string') walk(child);
        }
      })(ast);
      expect(found.sort()).toEqual(['/allowance', '/allowance/:id', '/allowance/settings']);
    });

    test('a failure inside a handler is answered, not thrown at the server', async () => {
      jest.spyOn(users, 'getAllowanceSettings').mockImplementation(() => { throw new Error('database is locked'); });
      const res = await post(mileage()).expect(500);
      expect(res.body.error).toBe('database is locked');
    });
  });

  describe('GET /allowance/settings', () => {
    test('says which kinds are on, at what rate, in which currency, and whether a payee is set', async () => {
      users.saveUserConfig(user.id, { DEFAULT_ACCOUNT_CODE: '420', DEFAULT_CURRENCY: 'MYR' });
      const { body } = await request(serverFor(app)).get('/api/claims/allowance/settings').set('Authorization', auth()).expect(200);
      expect(body).toEqual({
        currency: 'MYR', payeeSet: false,
        mileage:  { enabled: true, rate: 0.6, accountCode: '420', unit: 'km' },
        per_diem: { enabled: true, rate: 80,  accountCode: '420', unit: 'day' },
      });
    });

    test('a blank rate is off', async () => {
      setRates({ PER_DIEM_RATE: '' });
      users.saveUserConfig(user.id, { CLAIM_PAYEE_NAME: 'Jane Tan' });
      const { body } = await request(serverFor(app)).get('/api/claims/allowance/settings').set('Authorization', auth()).expect(200);
      expect(body.per_diem).toMatchObject({ enabled: false, rate: null });
      expect(body.payeeSet).toBe(true);
    });
  });

  describe('a mileage claim', () => {
    test('is stored as an expense claim with no receipt, priced on the server', async () => {
      users.saveUserConfig(user.id, { DEFAULT_CURRENCY: 'SGD' });
      setRates({ MILEAGE_ACCOUNT_CODE: '493' });
      const { body } = await post(mileage()).expect(201);
      const c = invoiceStore.forUser(user.id).getById(body.claim.id);
      expect(c).toMatchObject({
        invoiceType: 'EXPENSE', source: 'form',
        // Where POST /api/invoices/compose starts a typed-in document.
        status: 'review-needed',
        invoiceDate: '2026-10-03', dueDate: '2026-10-03',
        currency: 'SGD', accountCode: '493',
        vendorName: null, receiptFile: null, receiptHash: null,
        totalAmount: 25.2, subTotal: 25.2, taxAmount: 0,
        claimKind: 'mileage', claimQuantity: 42, claimRate: 0.6, claimUnit: 'km',
        claimDetails: { from: 'Office', to: 'Client A', purpose: 'site visit', distanceKm: 42, returnTrip: false },
        errorMsg: null, duplicateOf: null,
      });
      expect(c.invoiceNumber).toMatch(/^EXP-[A-Z0-9]{6}$/);
      expect(c.lineItems).toEqual([{
        description: 'Mileage 2026-10-03: Office → Client A (site visit), 42.0 km × 0.60', unitAmount: 25.2, discountRate: null,
      }]);
      expect(c.description).toBe(c.lineItems[0].description);
    });

    test('an amount the browser sends is ignored', async () => {
      const { body } = await post(mileage({ totalAmount: 999, amount: 999, subTotal: 999, lineItems: [{ description: 'x', unitAmount: 999 }] })).expect(201);
      expect(body.claim.totalAmount).toBe(25.2);
      expect(body.claim.lineItems).toHaveLength(1);
    });

    test('a return trip doubles the distance', async () => {
      const { body } = await post(mileage({ distanceKm: '42.5', returnTrip: true })).expect(201);
      expect(body.claim.claimQuantity).toBe(85);
      expect(body.claim.totalAmount).toBe(51);
      expect(body.claim.lineItems[0].description).toBe('Mileage 2026-10-03: Office → Client A and back (site visit), 85.0 km × 0.60');
      // "false" typed into a form is not a yes.
      const one = await post(mileage({ date: '2026-10-04', returnTrip: 'false' })).expect(201);
      expect(one.body.claim.claimQuantity).toBe(42);
    });

    test('is rounded to the cent, half a cent up, without float drift', async () => {
      setRates({ MILEAGE_RATE: '0.585' });
      // 12.5 x 0.585 = 7.3125 -> 7.31
      expect((await post(mileage({ distanceKm: 12.5 })).expect(201)).body.claim.totalAmount).toBe(7.31);
      setRates({ MILEAGE_RATE: '0.45' });
      // 3.5 x 0.45 = 1.575 exactly; in floats 1.5749999..., which rounded down.
      expect((await post(mileage({ date: '2026-10-05', distanceKm: 3.5 })).expect(201)).body.claim.totalAmount).toBe(1.58);
      setRates({ MILEAGE_RATE: '0.6855' });
      // 0.1 x 0.6855 = 0.06855 -> 0.07
      const r = (await post(mileage({ date: '2026-10-06', distanceKm: 0.1 })).expect(201)).body.claim;
      expect(r.totalAmount).toBe(0.07);
      expect(r.lineItems[0].description).toMatch(/0\.1 km × 0\.6855$/);
    });

    test('bad input is refused with the field named, and nothing is stored', async () => {
      const cases = [
        [{ distanceKm: 0 }, 'distanceKm'], [{ distanceKm: -3 }, 'distanceKm'], [{ distanceKm: 'far' }, 'distanceKm'],
        [{ distanceKm: 4.25 }, 'distanceKm'], [{ distanceKm: 5000.1 }, 'distanceKm'],
        [{ date: '2026-02-30' }, 'date'], [{ date: '03/10/2026' }, 'date'],
        [{ from: '  ' }, 'from'], [{ to: undefined }, 'to'], [{ purpose: '' }, 'purpose'], [{ from: 'x'.repeat(81) }, 'from'],
      ];
      for (const [extra, field] of cases) {
        const res = await post(mileage(extra)).expect(400);
        expect(res.body.errors.map(e => e.field)).toContain(field);
      }
      expect(invoiceStore.forUser(user.id).count()).toBe(0);
    });

    test('is refused while mileage is off in Setup', async () => {
      setRates({ MILEAGE_RATE: '' });
      const res = await post(mileage()).expect(409);
      expect(res.body.error).toMatch(/Setup/);
      await post({ ...mileage(), kind: 'taxi' }).expect(400);
    });
  });

  describe('a per diem claim', () => {
    test('from a start and end date: the days are counted, both ends included', async () => {
      const { body } = await post(perDiem()).expect(201);
      expect(body.claim).toMatchObject({
        claimKind: 'per_diem', claimQuantity: 3, claimRate: 80, claimUnit: 'day', totalAmount: 240, taxAmount: 0,
        invoiceDate: '2026-10-01',
        claimDetails: { destination: 'Kuala Lumpur', purpose: 'conference', endDate: '2026-10-03' },
      });
      expect(body.claim.lineItems[0].description).toBe('Per diem 2026-10-01 to 2026-10-03, Kuala Lumpur (conference), 3 days × 80.00');
    });

    test('half days: fewer days than the dates hold, in half-day steps', async () => {
      const { body } = await post(perDiem({ days: 2.5 })).expect(201);
      expect(body.claim.claimQuantity).toBe(2.5);
      expect(body.claim.totalAmount).toBe(200);
      expect(body.claim.lineItems[0].description).toMatch(/, 2\.5 days × 80\.00$/);
    });

    test('days without an end date: the end date follows', async () => {
      const { body } = await post(perDiem({ endDate: '', days: '0.5' })).expect(201);
      expect(body.claim.claimQuantity).toBe(0.5);
      expect(body.claim.totalAmount).toBe(40);
      expect(body.claim.claimDetails.endDate).toBe('2026-10-01');
      expect(body.claim.lineItems[0].description).toBe('Per diem 2026-10-01, Kuala Lumpur (conference), 0.5 days × 80.00');
      const two = await post(perDiem({ startDate: '2026-10-10', endDate: undefined, days: 1.5 })).expect(201);
      expect(two.body.claim.claimDetails.endDate).toBe('2026-10-11');
      const one = await post(perDiem({ startDate: '2026-10-20', endDate: '2026-10-20' })).expect(201);
      expect(one.body.claim.lineItems[0].description).toMatch(/, 1 day × 80\.00$/);
    });

    test('a rate with cents is priced to the cent', async () => {
      setRates({ PER_DIEM_RATE: '75.55' });
      const { body } = await post(perDiem({ days: 2.5 })).expect(201);
      expect(body.claim.totalAmount).toBe(188.88);   // 188.875 -> 188.88
    });

    test('bad input is refused with the field named', async () => {
      const cases = [
        [{ days: 1.25 }, 'days'], [{ days: 0 }, 'days'], [{ days: 4 }, 'days'],   // the dates hold 3
        [{ endDate: '2026-09-30' }, 'endDate'], [{ endDate: '', days: '' }, 'endDate'],
        [{ startDate: 'tomorrow' }, 'startDate'], [{ destination: '' }, 'destination'], [{ purpose: ' ' }, 'purpose'],
        [{ endDate: '2027-12-31' }, 'endDate'], [{ endDate: '', days: 400 }, 'days'],
      ];
      for (const [extra, field] of cases) {
        const res = await post(perDiem(extra)).expect(400);
        expect(res.body.errors.map(e => e.field)).toContain(field);
      }
      expect(invoiceStore.forUser(user.id).count()).toBe(0);
    });
  });

  describe('the rate is kept on the claim', () => {
    test('a later change in Setup does not reprice it, and an edit prices at the kept rate', async () => {
      const { body } = await post(mileage()).expect(201);
      setRates({ MILEAGE_RATE: '0.90' });
      expect(invoiceStore.forUser(user.id).getById(body.claim.id)).toMatchObject({ claimRate: 0.6, totalAmount: 25.2 });

      const edited = await patch(body.claim.id, mileage({ distanceKm: 50 })).expect(200);
      expect(edited.body.claim).toMatchObject({ claimRate: 0.6, claimQuantity: 50, totalAmount: 30 });
      expect(edited.body.claim.lineItems[0].description).toMatch(/50\.0 km × 0\.60$/);
      // A new claim takes the new rate.
      const fresh = await post(mileage({ date: '2026-10-07' })).expect(201);
      expect(fresh.body.claim).toMatchObject({ claimRate: 0.9, totalAmount: 37.8 });
    });

    test('a claim made with a rate still prices on an edit after the kind is turned off', async () => {
      const { body } = await post(perDiem()).expect(201);
      setRates({ PER_DIEM_RATE: '' });
      const edited = await patch(body.claim.id, perDiem({ days: 1.5 })).expect(200);
      expect(edited.body.claim).toMatchObject({ claimQuantity: 1.5, totalAmount: 120 });
    });
  });

  describe('editing', () => {
    test('changes what was typed; the amount follows and a sent amount is ignored', async () => {
      const { body } = await post(mileage()).expect(201);
      const res = await patch(body.claim.id, { ...mileage({ to: 'Client B', returnTrip: true }), totalAmount: 1, accountCode: '494' }).expect(200);
      expect(res.body.claim).toMatchObject({
        totalAmount: 50.4, subTotal: 50.4, taxAmount: 0, claimQuantity: 84, accountCode: '494',
        claimDetails: { from: 'Office', to: 'Client B', purpose: 'site visit', distanceKm: 42, returnTrip: true },
      });
      expect(res.body.claim.lineItems).toEqual([{
        description: 'Mileage 2026-10-03: Office → Client B and back (site visit), 84.0 km × 0.60', unitAmount: 50.4, discountRate: null,
      }]);
    });

    test('refuses bad input, a receipt claim, and a claim being sent', async () => {
      const { body } = await post(mileage()).expect(201);
      await patch(body.claim.id, mileage({ distanceKm: -1 })).expect(400);
      await patch(body.claim.id, mileage({ accountCode: 'not a code!' })).expect(400);
      await patch('nope', mileage()).expect(404);

      const store = invoiceStore.forUser(user.id);
      const receipt = store.add({ id: `r${Date.now()}`, status: 'review-needed', invoiceType: 'EXPENSE', totalAmount: 5, receiptFile: 'r.jpg' });
      await patch(receipt.id, mileage()).expect(400);

      store.update(body.claim.id, { status: 'submitting' });
      await patch(body.claim.id, mileage({ distanceKm: 1 })).expect(409);
      expect(store.getById(body.claim.id).totalAmount).toBe(25.2);
    });

    test('the generic editor cannot set an amount the quantity does not give', () => {
      return post(mileage()).expect(201).then(({ body }) => {
        const store = invoiceStore.forUser(user.id);
        store.update(body.claim.id, { totalAmount: 999, subTotal: 999, lineItems: [{ description: 'x', unitAmount: 999 }], currency: 'USD', description: 'Drive to Client A' });
        expect(store.getById(body.claim.id)).toMatchObject({ totalAmount: 25.2, subTotal: 25.2, currency: 'SGD', description: 'Drive to Client A' });
        expect(store.getById(body.claim.id).lineItems[0].unitAmount).toBe(25.2);
      });
    });
  });

  describe('the duplicate warning', () => {
    test('the same kind, date, quantity and details is flagged, and still saved', async () => {
      const first = (await post(mileage()).expect(201)).body.claim;
      // Case and punctuation are not a different trip.
      const res = await post(mileage({ from: 'office', to: 'CLIENT A', purpose: 'Site visit.', distanceKm: '42.0' })).expect(201);
      expect(res.body.duplicate).toEqual({ id: first.id, invoiceNumber: first.invoiceNumber });
      const second = invoiceStore.forUser(user.id).getById(res.body.claim.id);
      expect(second.status).toBe('review-needed');            // a warning, not the locked 'duplicate'
      expect(second.duplicateOf).toBe(first.id);
      expect(second.errorMsg).toMatch(new RegExp(`^Possible duplicate of ${first.invoiceNumber} — .*Check before approving\\.$`));
      expect(invoiceStore.forUser(user.id).getById(first.id).duplicateOf).toBeNull();
    });

    test('a different day, distance, route, direction or kind is not a duplicate', async () => {
      await post(mileage()).expect(201);
      for (const extra of [{ date: '2026-10-04' }, { distanceKm: 42.1 }, { to: 'Client B' }, { purpose: 'audit' }]) {
        const res = await post(mileage(extra)).expect(201);
        expect(res.body.duplicate).toBeUndefined();
      }
      // 84 km one way is not 42 km there and back.
      await post(mileage({ date: '2026-10-09', distanceKm: 42, returnTrip: true })).expect(201);
      expect((await post(mileage({ date: '2026-10-09', distanceKm: 84 })).expect(201)).body.duplicate).toBeUndefined();
      await post(perDiem()).expect(201);
      expect((await post(perDiem({ days: 2.5 })).expect(201)).body.duplicate).toBeUndefined();
      expect((await post(perDiem()).expect(201)).body.duplicate).toBeDefined();
    });

    test('a claim marked duplicate, or another account\'s, is not matched', async () => {
      const first = (await post(mileage()).expect(201)).body.claim;
      invoiceStore.forUser(user.id).update(first.id, { status: 'duplicate' });
      expect((await post(mileage()).expect(201)).body.duplicate).toBeUndefined();
      const other = await users.createUser(`dup${Date.now()}@test.com`, 'password123', 'user');
      users.saveUserConfig(other.id, users.checkAllowanceSettings({ MILEAGE_RATE: '0.60' }).values);
      expect((await post(mileage(), other).expect(201)).body.duplicate).toBeUndefined();
    });

    test('an edit that makes it different clears the warning; one that makes it the same sets it', async () => {
      const first  = (await post(mileage()).expect(201)).body.claim;
      const second = (await post(mileage()).expect(201)).body.claim;
      expect(second.duplicateOf).toBe(first.id);

      const moved = await patch(second.id, mileage({ date: '2026-10-08' })).expect(200);
      expect(moved.body.claim).toMatchObject({ duplicateOf: null, errorMsg: null });

      const back = await patch(second.id, mileage()).expect(200);
      expect(back.body.claim.duplicateOf).toBe(first.id);
      // A claim is never its own duplicate.
      const self = await patch(first.id, mileage()).expect(200);
      expect(self.body.claim.duplicateOf).toBe(second.id);
    });
  });
});
