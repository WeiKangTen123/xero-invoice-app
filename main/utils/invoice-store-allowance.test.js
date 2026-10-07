// The store's side of mileage and per diem claims: the fields round-trip, an
// amount cannot be edited away from quantity x rate, and the duplicate lookup
// matches the same claim however it was typed.
describe('invoice-store — mileage and per diem', () => {
  let users, invoiceStore, store, userId;

  beforeEach(async () => {
    jest.resetModules();
    require('../db/migrate').run();
    users        = require('./users');
    invoiceStore = require('./invoice-store');
    const u = await users.createUser(`st${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.com`, 'password123', 'user');
    userId = u.id;
    store  = invoiceStore.forUser(userId);
  });

  let n = 0;
  const mileage = (extra = {}) => store.add({
    id: `m${Date.now()}${n++}`, status: 'review-needed', invoiceType: 'EXPENSE', source: 'form',
    invoiceDate: '2026-10-03', currency: 'SGD', totalAmount: 25.2, subTotal: 25.2, taxAmount: 0,
    lineItems: [{ description: 'Mileage 2026-10-03: Office → Client A (site visit), 42.0 km × 0.60', unitAmount: 25.2 }],
    claimKind: 'mileage', claimQuantity: 42, claimRate: 0.6, claimUnit: 'km',
    claimDetails: { from: 'Office', to: 'Client A', purpose: 'site visit', distanceKm: 42, returnTrip: false },
    ...extra,
  });

  test('the claim fields round-trip, details as an object', () => {
    const r = mileage();
    expect(r).toMatchObject({ claimKind: 'mileage', claimQuantity: 42, claimRate: 0.6, claimUnit: 'km' });
    expect(r.claimDetails).toEqual({ from: 'Office', to: 'Client A', purpose: 'site visit', distanceKm: 42, returnTrip: false });
    expect(store.getAll()[0].claimDetails).toEqual(r.claimDetails);
  });

  test('a claim with no kind recorded is a receipt claim; a bill has no kind', () => {
    const receipt = store.add({ id: 'r1', status: 'review-needed', invoiceType: 'EXPENSE', receiptFile: 'r1.jpg' });
    const bill    = store.add({ id: 'b1', status: 'pending', invoiceType: 'ACCPAY' });
    expect(receipt).toMatchObject({ claimKind: 'receipt', claimQuantity: null, claimRate: null, claimUnit: null, claimDetails: null });
    expect(bill.claimKind).toBeNull();
  });

  test('unreadable details read as none rather than throwing', () => {
    const r = mileage();
    require('../db').prepare('UPDATE invoices SET claim_details = ? WHERE id = ?').run('{not json', r.id);
    expect(store.getById(r.id).claimDetails).toBeNull();
  });

  test('an edit without a quantity cannot change the amount, its lines or its currency', () => {
    const r = mileage();
    const after = store.update(r.id, {
      totalAmount: 1, subTotal: 1, taxAmount: 0.5, currency: 'USD',
      lineItems: [{ description: 'free text', unitAmount: 1 }], accountCode: '494', status: 'reviewed',
    });
    expect(after).toMatchObject({ totalAmount: 25.2, subTotal: 25.2, taxAmount: 0, currency: 'SGD', accountCode: '494', status: 'reviewed' });
    expect(after.lineItems).toHaveLength(1);
    expect(after.lineItems[0].unitAmount).toBe(25.2);

    // With the quantity (the claim routes' repricing), it does.
    const repriced = store.update(r.id, { claimQuantity: 50, totalAmount: 30, subTotal: 30, lineItems: [{ description: 'x', unitAmount: 30 }] });
    expect(repriced).toMatchObject({ claimQuantity: 50, totalAmount: 30 });

    // A receipt claim's amount is edited as before.
    const receipt = store.add({ id: 'r2', status: 'review-needed', invoiceType: 'EXPENSE', totalAmount: 10 });
    expect(store.update(receipt.id, { totalAmount: 12 }).totalAmount).toBe(12);
  });

  describe('findAllowanceDuplicate', () => {
    const ask = (extra = {}) => store.findAllowanceDuplicate({
      kind: 'mileage', date: '2026-10-03', quantity: 42,
      details: { from: 'Office', to: 'Client A', purpose: 'site visit', distanceKm: 42, returnTrip: false }, ...extra,
    });

    test('finds the same kind, day, quantity and details, ignoring case and punctuation', () => {
      const r = mileage();
      expect(ask().id).toBe(r.id);
      expect(ask({ details: { from: ' OFFICE', to: 'client-a', purpose: 'Site visit!', distanceKm: 42, returnTrip: false } }).id).toBe(r.id);
    });

    test('not a different day, quantity, detail or kind, nor the claim itself', () => {
      const r = mileage();
      expect(ask({ date: '2026-10-04' })).toBeNull();
      expect(ask({ quantity: 42.1 })).toBeNull();
      expect(ask({ details: { from: 'Office', to: 'Client B', purpose: 'site visit', distanceKm: 42, returnTrip: false } })).toBeNull();
      expect(ask({ kind: 'per_diem' })).toBeNull();
      expect(ask({ excludeId: r.id })).toBeNull();
      expect(ask({ kind: 'receipt' })).toBeNull();
    });

    test('a row marked duplicate or failed is left out, unless it is in Xero', () => {
      const r = mileage({ status: 'duplicate' });
      expect(ask()).toBeNull();
      store.update(r.id, { status: 'error' });
      expect(ask()).toBeNull();
      store.update(r.id, { xeroInvoiceId: 'x-1' });
      expect(ask().id).toBe(r.id);
    });

    test('another account\'s claim is not this account\'s duplicate', async () => {
      mileage();
      const other = await users.createUser(`o${Date.now()}@test.com`, 'password123', 'user');
      expect(invoiceStore.forUser(other.id).findAllowanceDuplicate({
        kind: 'mileage', date: '2026-10-03', quantity: 42,
        details: { from: 'Office', to: 'Client A', purpose: 'site visit', distanceKm: 42, returnTrip: false },
      })).toBeNull();
    });
  });
});
