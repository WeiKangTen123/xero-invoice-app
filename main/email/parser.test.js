const { _ensureSubtotalTax, _parseTaxPercent, _detectCurrency } = require('./parser');

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

  test('derives taxAmount from totalAmount - subTotal when only subtotal is known', () => {
    // Now reachable since the LLM prompt extracts subTotal independently of taxAmount —
    // it can find one without the other. Xero's actual tax-rate resolution (xero/invoices.js)
    // depends on both being consistent, so this must not silently leave taxAmount at 0.
    const parsed = { totalAmount: 1090, subTotal: 1000 };
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

  test('clamps a negative derived taxAmount to 0 rather than posting a negative tax line', () => {
    // e.g. bad extraction where subTotal > totalAmount
    const parsed = { totalAmount: 100, subTotal: 150 };
    const result = _ensureSubtotalTax(parsed);
    expect(result.taxAmount).toBe(0);
  });

  test('missing totalAmount defaults to 0 rather than throwing', () => {
    const parsed = {};
    const result = _ensureSubtotalTax(parsed);
    expect(result.subTotal).toBe(0);
    expect(result.taxAmount).toBe(0);
  });

  test('a non-numeric subTotal/taxAmount (bad LLM extraction) does not propagate NaN', () => {
    const parsed = { totalAmount: 500, subTotal: 'N/A', taxAmount: 'N/A' };
    const result = _ensureSubtotalTax(parsed);
    expect(Number.isFinite(result.subTotal)).toBe(true);
    expect(Number.isFinite(result.taxAmount)).toBe(true);
  });
});

describe('_parseTaxPercent', () => {
  test('extracts a plain percentage', () => {
    expect(_parseTaxPercent('9%')).toBe(9);
  });

  test('extracts a percentage embedded in a label', () => {
    expect(_parseTaxPercent('GST 9%')).toBe(9);
    expect(_parseTaxPercent('VAT (20%)')).toBe(20);
  });

  test('handles a decimal percentage', () => {
    expect(_parseTaxPercent('7.7%')).toBe(7.7);
  });

  test('returns null for a label with no computable number', () => {
    expect(_parseTaxPercent('GST')).toBeNull();
    expect(_parseTaxPercent('-')).toBeNull();
    expect(_parseTaxPercent('NONE')).toBeNull();
    expect(_parseTaxPercent('')).toBeNull();
    expect(_parseTaxPercent(null)).toBeNull();
  });
});

describe('_detectCurrency', () => {
  test('reads an explicit "Currency: XXX" label', () => {
    expect(_detectCurrency('Currency: AUD\nSome other text')).toBe('AUD');
  });

  test('reads a 3-letter code adjacent to an amount', () => {
    expect(_detectCurrency('Total Due: SGD 1,090.00')).toBe('SGD');
    expect(_detectCurrency('Amount: GBP 500')).toBe('GBP');
  });

  test('recognises currency-specific symbols', () => {
    expect(_detectCurrency('Total: S$500.00')).toBe('SGD');
    expect(_detectCurrency('Total: A$500.00')).toBe('AUD');
    expect(_detectCurrency('Total: £500.00')).toBe('GBP');
    expect(_detectCurrency('Total: €500.00')).toBe('EUR');
    expect(_detectCurrency('Total: ¥50000')).toBe('JPY');
    expect(_detectCurrency('Total: RM500.00')).toBe('MYR');
  });

  test('a bare "$" with no other signal is ambiguous — returns null rather than guessing', () => {
    // This is the exact bug being fixed: previously any bare "$" invoice with no
    // "PayNow"/"SGD" keyword was silently forced to USD regardless of its real currency.
    expect(_detectCurrency('Total: $500.00')).toBeNull();
  });

  test('no currency signal anywhere returns null', () => {
    expect(_detectCurrency('Total: 500.00')).toBeNull();
  });
});
