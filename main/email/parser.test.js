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

describe('cleanSubject', () => {
  const { cleanSubject } = require('./parser');

  test('strips single and multiple Fwd/Re prefixes', () => {
    expect(cleanSubject('Fwd: Invoice INV-2024')).toBe('Invoice INV-2024');
    expect(cleanSubject('Fwd: Re: Fw: Invoice #123')).toBe('Invoice #123');
    expect(cleanSubject('RE: [EXTERNAL] Bill for March')).toBe('Bill for March');
  });

  test('strips external/spam tags', () => {
    expect(cleanSubject('[EXTERNAL] Invoice from Acme Corp')).toBe('Invoice from Acme Corp');
    expect(cleanSubject('[SPAM] Notice of Payment')).toBe('Notice of Payment');
  });

  test('preserves clean subjects and trims whitespace', () => {
    expect(cleanSubject('  Invoice #8849  ')).toBe('Invoice #8849');
    expect(cleanSubject('')).toBe('');
    expect(cleanSubject(null)).toBe('');
  });
});

// ── The AR template ─────────────────────────────────────────────────────────
// parseTemplateFormat is the whole AR path — an email that matches this
// template is an invoice, and these regexes are the only thing reading it —
// yet until now nothing tested it against the template itself. The amount
// regex required digits straight after "Amount :" while the template writes
// "Amount : SGD1000", so every AR amount parsed as zero and every stored AR
// invoice had to be corrected by hand. That went unnoticed for months because
// this file only ever exercised the helpers around it.
//
// The sample below is reconstructed from the parser and from seven real AR
// invoices in the production database; the field labels and the SGD prefix
// are exactly as sent.
describe('parseTemplateFormat — the AR template, as actually sent', () => {
  const { parseTemplateFormat } = require('./parser');

  const email = {
    subject: 'PereOcean AR invoice',
    date: '2026-08-17T03:00:00.000Z',
    from: { text: '"PereOcean Demo" <Pereocean_demo@gmail.com>', value: [{ address: 'Pereocean_demo@gmail.com' }] },
  };
  const defaults = { currency: 'USD', accountCode: '200' };

  const oneItem = [
    'Client / Customer : PereOcean Demo',
    'Email : Pereocean_demo@gmail.com',
    'Address : 58 Senoko Road, Singapore 758122',
    'Currency : SGD, Standard',
    'Payment Terms / Payment Date : 30 days',
    'Tax inclusive / exclusive : Exclusive',
    '',
    '1. Description / Details :',
    '*Project*: NDP Provision of Drinks',
    '*Campaign*: 22 July to 9 August',
    '*Project period*: 2 weeks',
    '*Territory*: Singapore',
    '*Scope of work:*',
    '',
    '   - Provision of PereOcean Water Cartons',
    '',
    'Amount : SGD1000',
    'Discount :',
    'Tax (If applicable) :',
  ].join('\n');

  test('the amount is read even though the template writes a currency before it', () => {
    const p = parseTemplateFormat(oneItem, email, defaults);
    expect(p.lineItems).toHaveLength(1);
    expect(p.lineItems[0].unitAmount).toBe(1000);
    expect(p.totalAmount).toBe(1000);
    expect(p.subTotal).toBe(1000);
  });

  test('the amount line is a boundary, not part of the description', () => {
    // Before the fix the failed match ran on, and "Amount : SGD1000" ended up
    // stored inside the line item's description — seen in production rows.
    const p = parseTemplateFormat(oneItem, email, defaults);
    expect(p.lineItems[0].description).toContain('Provision of PereOcean Water Cartons');
    expect(p.lineItems[0].description).not.toMatch(/Amount\s*:/);
    expect(p.lineItems[0].description).not.toMatch(/Discount\s*:/);
  });

  test('every header field lands where it should', () => {
    const p = parseTemplateFormat(oneItem, email, defaults);
    expect(p.contactName).toBe('PereOcean Demo');
    expect(p.vendorName).toBe('PereOcean Demo');
    expect(p.contactEmail).toBe('Pereocean_demo@gmail.com');
    expect(p.contactAddress).toBe('58 Senoko Road, Singapore 758122');
    expect(p.currency).toBe('SGD');            // from the template, not the USD default
    expect(p.brandingThemeName).toBe('Standard');
    expect(p.lineAmountTypes).toBe('Exclusive');
    expect(p.taxAmount).toBe(0);
  });

  test('"30 days" is counted from the invoice date', () => {
    const p = parseTemplateFormat(oneItem, email, defaults);
    expect(p.invoiceDate).toBe('2026-08-17');
    expect(p.dueDate).toBe('2026-09-16');
  });

  test('two items with mixed amount wordings both parse, and the total is their sum', () => {
    const twoItems = oneItem.replace(
      'Tax (If applicable) :',
      [
        'Tax (If applicable) :',
        '',
        '2. Description / Details :',
        'IT fair display',
        'Amount : 2,800.50',
        'Discount : 10%',
        'Tax (If applicable) :',
      ].join('\n'),
    );
    const p = parseTemplateFormat(twoItems, email, defaults);
    expect(p.lineItems).toHaveLength(2);
    expect(p.lineItems[0].unitAmount).toBe(1000);
    expect(p.lineItems[1].unitAmount).toBe(2800.5);
    // Item one's blank "Tax (If applicable) :" used to swallow item two's
    // header line, so nothing must leak across the boundary in either direction.
    expect(p.lineItems[0].description).not.toMatch(/Description\s*\/\s*Details/);
    expect(p.lineItems[1].description).toBe('IT fair display');
    expect(p.lineItems[1].discountRate).toBe(10);
    // 1000 + 2800.50 less 10%
    expect(p.subTotal).toBe(3520.45);
    expect(p.totalAmount).toBe(3520.45);
  });

  test('a stated tax percentage produces a tax amount, a bare label does not', () => {
    const taxed = oneItem.replace('Tax (If applicable) :', 'Tax (If applicable) : GST 9%');
    const p = parseTemplateFormat(taxed, email, defaults);
    expect(p.taxAmount).toBe(90);
    expect(p.totalAmount).toBe(1090);

    const labelled = oneItem.replace('Tax (If applicable) :', 'Tax (If applicable) : GST');
    expect(parseTemplateFormat(labelled, email, defaults).taxAmount).toBe(0);
  });

  test.each([
    ['Amount : SGD1000',      1000],
    ['Amount : SGD 1,250.50', 1250.5],
    ['Amount : S$1000',       1000],
    ['Amount : $1000',        1000],
    ['Amount : US$ 99',       99],
    ['Amount : 1000',         1000],
    ['Amount : £250',         250],
  ])('%s → %s', (line, expected) => {
    const p = parseTemplateFormat(oneItem.replace('Amount : SGD1000', line), email, defaults);
    expect(p.lineItems[0].unitAmount).toBe(expected);
  });
});
