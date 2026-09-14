const { normalise } = require('./receipt-parser');
// The So Good Bakery receipt of 10 Sep 2026: 6 × Mini Chicken Pie at 1.60 is
// a 9.60 line, and "Sub Total 16.10 / GST 1.33" is GST-inclusive.
describe('receipt line items carry the line total, not the unit price', () => {
  const r = normalise({ merchant: 'SO GOOD BAKERY', date: '2026-09-10', currency: 'SGD', total: 16.10, tax: 1.33, subTotal: 16.10,
    lineItems: [
      { description: 'Luncheon & Egg Bun', unitAmount: 2.50, quantity: 1 },
      { description: 'Mini Chicken Pie', unitAmount: 1.60, quantity: 6, lineTotal: 9.60 },
      { description: 'Hot Milk Tea ( A no sugar )', unitAmount: 4.00, quantity: 1 },
    ] });
  test('the 6-pack is 9.60 and says so', () => {
    expect(r.lineItems[1]).toEqual({ description: 'Mini Chicken Pie — 6 × 1.60', unitAmount: 9.60, discountRate: 0 });
    expect(r.lineItems.reduce((s, li) => s + li.unitAmount, 0)).toBeCloseTo(16.10, 2);
  });
  test('single units are untouched', () => {
    expect(r.lineItems[0]).toEqual({ description: 'Luncheon & Egg Bun', unitAmount: 2.50, discountRate: 0 });
  });
  test('quantity × unit is computed when the model gives no line total', () => {
    const x = normalise({ total: 9.60, lineItems: [{ description: 'Pie', unitAmount: 1.60, quantity: 6 }] });
    expect(x.lineItems[0].unitAmount).toBe(9.60);
  });
  test('a subtotal equal to the total with GST beside it is GST-inclusive', () => {
    expect(r.subTotal).toBe(14.77);
    expect(r.tax).toBe(1.33);
    expect(r.total).toBe(16.10);
  });
  test('a genuine pre-tax subtotal is kept', () => {
    expect(normalise({ total: 109, tax: 9, subTotal: 100 }).subTotal).toBe(100);
  });
});
