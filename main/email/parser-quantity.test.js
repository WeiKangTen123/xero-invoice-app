const { _withQuantity } = require('./parser');
describe('quantity folded into the line description', () => {
  test('2 × 75.00 appended when the invoice prints quantity and unit price', () => {
    expect(_withQuantity('Issuance of Notarial Certificate', 2, 75)).toBe('Issuance of Notarial Certificate — 2 × 75.00');
  });
  test('a single unit, or no price, leaves the description alone', () => {
    expect(_withQuantity('Witnessing of Signing', 1, 40)).toBe('Witnessing of Signing');
    expect(_withQuantity('Witnessing of Signing', null, null)).toBe('Witnessing of Signing');
    expect(_withQuantity('Witnessing of Signing', 3, 0)).toBe('Witnessing of Signing');
  });
});
