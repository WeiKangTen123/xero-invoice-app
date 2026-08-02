const { _ensureSubtotalTax } = require('./parser');

describe('_ensureSubtotalTax', () => {
  test('LLM/template output with neither subTotal nor taxAmount set gets a sane fallback', () => {
    // This is the exact shape parsePDFWithLLM and parseTemplateFormat used to return —
    // no subTotal/taxAmount at all, which silently hid the breakdown in the review UI.
    const parsed = { totalAmount: 400 };
    const result = _ensureSubtotalTax(parsed);
    expect(result.subTotal).toBe(400);
    expect(result.taxAmount).toBe(0);
  });

  test('derives subTotal from totalAmount - taxAmount when only tax is known', () => {
    const parsed = { totalAmount: 1090, taxAmount: 90 };
    const result = _ensureSubtotalTax(parsed);
    expect(result.subTotal).toBe(1000);
    expect(result.taxAmount).toBe(90);
  });

  test('leaves an explicitly-set subTotal/taxAmount untouched (parseGenericFormat path)', () => {
    const parsed = { totalAmount: 1090, subTotal: 1000, taxAmount: 90 };
    const result = _ensureSubtotalTax(parsed);
    expect(result.subTotal).toBe(1000);
    expect(result.taxAmount).toBe(90);
  });

  test('falls back to totalAmount when the derived subTotal would be zero/negative', () => {
    // e.g. bad extraction where taxAmount > totalAmount — avoid a nonsensical negative line item
    const parsed = { totalAmount: 100, taxAmount: 150 };
    const result = _ensureSubtotalTax(parsed);
    expect(result.subTotal).toBe(100);
  });

  test('missing totalAmount defaults to 0 rather than throwing', () => {
    const parsed = {};
    const result = _ensureSubtotalTax(parsed);
    expect(result.subTotal).toBe(0);
    expect(result.taxAmount).toBe(0);
  });
});
