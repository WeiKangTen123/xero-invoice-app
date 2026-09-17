// The bill model returns { description, quantity, unitPrice, amount }. The
// stored line carries the line total and the quantity in its text; this used
// to be parser.js's own fold (_withQuantity) and is now the shared one.
const { normaliseLineItem } = require('../intake/document');
describe('quantity folded into the line description', () => {
  test('2 × 75.00 appended when the invoice prints quantity and unit price', () => {
    expect(normaliseLineItem({ description: 'Issuance of Notarial Certificate', quantity: 2, unitPrice: 75, amount: 150 }))
      .toMatchObject({ description: 'Issuance of Notarial Certificate — 2 × 75.00', unitAmount: 150 });
  });
  test('a single unit, or no price, leaves the description alone', () => {
    expect(normaliseLineItem({ description: 'Witnessing of Signing', quantity: 1, unitPrice: 40, amount: 40 }).description).toBe('Witnessing of Signing');
    expect(normaliseLineItem({ description: 'Witnessing of Signing', quantity: null, unitPrice: null, amount: 40 }).description).toBe('Witnessing of Signing');
    expect(normaliseLineItem({ description: 'Witnessing of Signing', quantity: 3, unitPrice: 0, amount: 0 }).description).toBe('Witnessing of Signing');
  });
});
