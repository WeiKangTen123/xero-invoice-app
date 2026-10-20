// The model reader is stubbed for the Indian GST tests at the end; nothing
// above them calls it.
jest.mock('./llm-parser', () => ({ extractWithRetry: jest.fn() }));
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

  test('Invoice Number and Invoice Date are read when the template carries them', () => {
    const withBoth = oneItem.replace('Client / Customer : PereOcean Demo',
      'Invoice Number : PO-2026-014\nInvoice Date : 10/08/2026\nClient / Customer : PereOcean Demo');
    const p = parseTemplateFormat(withBoth, email, defaults);
    expect(p.invoiceNumber).toBe('PO-2026-014');
    expect(p.invoiceDate).toBe('2026-08-10');          // DD/MM/YYYY, the document's date, not the email's
    expect(p.dueDate).toBe('2026-09-09');              // and "30 days" counts from it
  });

  test('without them, the fallbacks are unchanged: email date and a generated number', () => {
    const p = parseTemplateFormat(oneItem, email, defaults);
    expect(p.invoiceDate).toBe('2026-08-17');
    expect(p.invoiceNumber).toMatch(/^INV-\d{12,}$/);
  });

  test('an Invoice Date with no digits in it falls back to the email date rather than today', () => {
    const p = parseTemplateFormat(oneItem.replace('Client / Customer', 'Invoice Date : TBC\nClient / Customer'), email, defaults);
    expect(p.invoiceDate).toBe('2026-08-17');
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

// "Tax inclusive / exclusive : Inclusive" means each Amount already contains
// its tax. The parser added the tax on top anyway, so a 1,090 line at 9%
// became a 1,188.10 invoice — the row then disagreed with the total Xero
// computed from the Inclusive lines once it was posted.
describe('parseTemplateFormat — tax-inclusive and tax-exclusive amounts', () => {
  const { parseTemplateFormat } = require('./parser');
  const email = { subject: 'AR invoice', date: '2026-08-17T03:00:00.000Z', from: { text: 'x@y.com', value: [{ address: 'x@y.com' }] } };
  const defaults = { currency: 'SGD', accountCode: '200' };
  const template = (setting, items) => [
    'Client / Customer : PereOcean Demo',
    'Currency : SGD, Standard',
    'Payment Terms / Payment Date : 30 days',
    `Tax inclusive / exclusive : ${setting}`,
    '',
    ...items.flatMap(([desc, amount, discount, tax], i) => [
      `${i + 1}. Description / Details :`, desc, '',
      `Amount : SGD${amount}`, `Discount : ${discount}`, `Tax (If applicable) : ${tax}`, '',
    ]),
  ].join('\n');

  test('inclusive: the total is the lines, and the tax is the part of them that is tax', () => {
    const p = parseTemplateFormat(template('Inclusive', [['Water cartons', '1090', '', 'GST 9%']]), email, defaults);
    expect(p.lineAmountTypes).toBe('Inclusive');
    expect(p).toMatchObject({ totalAmount: 1090, taxAmount: 90, subTotal: 1000 });
    expect(p.lineItems[0].unitAmount).toBe(1090);   // the line is stated as sent; Xero is told it is Inclusive
  });

  test('inclusive with a discount and two lines: subtotal plus tax is the total to the cent', () => {
    const p = parseTemplateFormat(template('Inclusive', [['Cartons', '1,090', '10', '9%'], ['Delivery', '218', '', '9%']]), email, defaults);
    // 981 + 218 = 1,199 inclusive; tax = 1,199 × 9/109 = 99.00
    expect(p.totalAmount).toBe(1199);
    expect(p.taxAmount).toBe(99);
    expect(p.subTotal).toBe(1100);
    expect(Math.round((p.subTotal + p.taxAmount) * 100) / 100).toBe(p.totalAmount);
  });

  test('exclusive is unchanged: the tax is added on top of the lines', () => {
    const p = parseTemplateFormat(template('Exclusive', [['Water cartons', '1000', '', 'GST 9%']]), email, defaults);
    expect(p.lineAmountTypes).toBe('Exclusive');
    expect(p).toMatchObject({ totalAmount: 1090, taxAmount: 90, subTotal: 1000 });
  });

  test('inclusive with no tax percentage: the lines are the total and there is no tax', () => {
    const p = parseTemplateFormat(template('Inclusive', [['Water cartons', '500', '', '']]), email, defaults);
    expect(p).toMatchObject({ lineAmountTypes: 'Inclusive', totalAmount: 500, taxAmount: 0, subTotal: 500 });
  });
});

// ── Indian GST bills ────────────────────────────────────────────────────────
// J. Sagar Associates, Bengaluru. BLR/26-27/2078 was read with the taxable
// value as the total (held, by the subtotal check). BLR/26-27/2056 was read
// twice: once like that, once with no tax at all, which added up and sat
// ready to post with the GST missing. The PDF's own text is now checked: GST
// printed but none read, or an amount in words that is not the total, holds
// the bill. The figures are never changed. The text around the figures is
// invented; the figures are the production ones.
describe('Indian GST bills: the reading is checked against the PDF text', () => {
  const { extractWithRetry } = require('./llm-parser');
  const { parsePDFWithLLM, _gstCharged, _amountsInWords } = require('./parser');
  const EMAIL    = { subject: 'Invoice', date: '2026-10-05T04:00:00Z', from: { text: 'accounts@jsa.example', value: [{ address: 'accounts@jsa.example' }] } };
  const DEFAULTS = { currency: 'SGD', accountCode: '310' };
  const GST_HOLD = 'the PDF shows GST (CGST/SGST/IGST) but no tax was read; check the tax and the total';

  // Intra-state (Karnataka to Karnataka): CGST + SGST.
  const BILL_2078 = [
    'TAX INVOICE',
    'J. SAGAR ASSOCIATES',
    'Advocates & Solicitors, Bengaluru',
    'GSTIN: 29AAAFJ0000A1Z5',
    'Invoice No: BLR/26-27/2078        Date: 02/10/2026',
    'Professional fees   998212   1,01,316.00',
    'Taxable Value                1,01,316.00',
    'CGST @ 9%                      9,118.44',
    'SGST @ 9%                      9,118.44',
    'Round Off                          0.12',
    'Total Invoice Value          1,19,553.00',
    'Amount in words: Rupees One Lakh Nineteen Thousand Five Hundred Fifty Three Only',
  ].join('\n');
  // Inter-state: IGST.
  const BILL_2056 = [
    'TAX INVOICE',
    'J. SAGAR ASSOCIATES',
    'Invoice No: BLR/26-27/2056        Date: 28/09/2026',
    'Professional fees   998212   95,959.00',
    'Taxable Value                95,959.00',
    'IGST @ 18%                   17,272.62',
    'Round Off                         0.38',
    'Grand Total                1,13,232.00',
    'Rupees One Lakh Thirteen Thousand Two Hundred Thirty Two Only',
  ].join('\n');
  const noWords = t => t.split('\n').filter(l => !/Only$/.test(l)).join('\n');

  const reading = (over = {}) => ({
    vendorName: 'J. Sagar Associates', invoiceNumber: 'BLR/26-27/2078', invoiceDate: '2026-10-02', currency: 'INR',
    documentType: 'invoice', confidence: 'high',
    lineItems: [{ description: 'Professional fees', amount: 101316 }],
    subTotal: 101316, taxAmount: 18237, totalAmount: 119553, ...over,
  });
  const read = async (text, over) => {
    extractWithRetry.mockResolvedValue(reading(over));
    return parsePDFWithLLM(text, EMAIL, 'BLR-26-27-2078.pdf', 'u1', DEFAULTS);
  };

  beforeEach(() => extractWithRetry.mockReset());

  test('a correct reading of the CGST + SGST bill is not held', async () => {
    const r = await read(BILL_2078);
    expect(r.reviewReason).toBeNull();
    expect(r.confidence).toBe('high');
  });

  test('CGST + SGST printed but no tax read: held, the figures kept as read', async () => {
    const r = await read(noWords(BILL_2078), { subTotal: 101316, taxAmount: 0, totalAmount: 101316 });
    expect(r.reviewReason).toBe(GST_HOLD);
    expect(r).toMatchObject({ subTotal: 101316, taxAmount: 0, totalAmount: 101316 });
    expect(r.confidence).toBe('low');
  });

  test('IGST printed but no tax read (null): held', async () => {
    const r = await read(noWords(BILL_2056), { lineItems: [{ description: 'Professional fees', amount: 95959 }], subTotal: 95959, taxAmount: null, totalAmount: 95959 });
    expect(r.reviewReason).toBe(GST_HOLD);
  });

  test('the second reading of BLR/26-27/2056 (no tax, taxable value as total) is now held twice over', async () => {
    const r = await read(BILL_2056, { invoiceNumber: 'BLR/26-27/2056', lineItems: [{ description: 'Professional fees', amount: 95959 }], subTotal: 95959, taxAmount: 0, totalAmount: 95959 });
    expect(r.reviewReason).toBe(`${GST_HOLD}; the amount in words on the PDF is INR 113,232.00, but the total read is INR 95,959.00`);
    expect(r).toMatchObject({ subTotal: 95959, taxAmount: 0, totalAmount: 95959 });
  });

  test('the reading of BLR/26-27/2078 (taxable value as the total) also says what the words say', async () => {
    const r = await read(BILL_2078, { subTotal: 101316, taxAmount: 18237, totalAmount: 101316 });
    expect(r.reviewReason).toMatch(/plus tax INR 18,237\.00 comes to INR 119,553\.00, but the total is INR 101,316\.00/);
    expect(r.reviewReason).toMatch(/the amount in words on the PDF is INR 119,553\.00, but the total read is INR 101,316\.00/);
    expect(r.totalAmount).toBe(101316);
  });

  test('a total that matches the words is not held for them', async () => {
    const r = await read(BILL_2056, { lineItems: [{ description: 'Professional fees', amount: 95959 }], subTotal: 95959, taxAmount: 17273, totalAmount: 113232 });
    expect(r.reviewReason).toBeNull();
  });

  test('the tax in words (Tally prints it under the total) is not taken for the total', async () => {
    const tally = [
      'CGST 9,118.44', 'SGST 9,118.44', 'Total 1,19,553.00',
      'Amount Chargeable (in words)', 'INR One Lakh Nineteen Thousand Five Hundred Fifty Three Only',
      'Tax Amount (in words) : INR Eighteen Thousand Two Hundred Thirty Seven Only',
    ].join('\n');
    expect(_amountsInWords(tally)).toEqual([119553]);
    expect((await read(tally)).reviewReason).toBeNull();
  });

  test('a "GST @ 18%" line with an amount counts as GST printed', async () => {
    const text = 'Taxable Value 1,01,316.00\nGST @ 18% 18,236.88\nTotal 1,19,552.88';
    const r = await read(text, { subTotal: 101316, taxAmount: 0, totalAmount: 101316 });
    expect(r.reviewReason).toBe(GST_HOLD);
  });

  test.each([
    ['CGST and SGST on their own lines',      'CGST @ 9% 9,118.44\nSGST @ 9% 9,118.44', true],
    ['IGST',                                   'IGST (18%) : 17,272.62', true],
    ['UTGST',                                  'CGST 9% 900.00\nUTGST 9% 900.00', true],
    ['cells run together by the PDF reader',   'Taxable Value 1,01,316.00CGST@9%9,118.44', true],
    ['the amount on the line under the label', 'CGST @ 9%\n9,118.44', true],
    ['GST 9% (Singapore)',                     'GST 9% 90.00', true],
    ['IGST at 0% on an export',                'IGST @ 0% on 1,01,316.00 0.00', false],
    ['GST amounts of zero',                    'CGST 0.00\nSGST 0.00', false],
    ['the GSTIN only',                         'GSTIN: 29AAAFJ0000A1Z5\nTotal 1,000.00', false],
    ['IGST named without an amount',           'Supply without payment of IGST under LUT\nTotal 1,01,316.00', false],
    ['no GST at all',                          'Total 1,000.00', false],
  ])('GST charged: %s → %s', (_, text, expected) => {
    expect(_gstCharged(text)).toBe(expected);
  });

  test('no GST printed and no tax read is not held', async () => {
    const r = await read('Professional fees 1,000.00\nTotal 1,000.00', { lineItems: [{ description: 'Fees', amount: 1000 }], subTotal: 1000, taxAmount: 0, totalAmount: 1000 });
    expect(r.reviewReason).toBeNull();
  });
});

describe('_amountInWords — Indian numbering', () => {
  const { _amountInWords } = require('./parser');

  test.each([
    ['Rupees One Lakh Nineteen Thousand Five Hundred Fifty Three Only',        119553],
    ['Rupees Ninety Five Thousand Nine Hundred Fifty Nine and Fifty Paise Only', 95959.5],
    ['Rupees One Lakh Nineteen Thousand Five Hundred and Fifty Three Only',     119553],
    ['INR Two Crore Fifty Lakh Three Thousand and Five Only',                    25003005],
    ['Rupees One Hundred Twenty Crore Only',                                     1200000000],
    ['Indian Rupees Five Lakhs Only',                                            500000],
    ['One Lakh Rupees and Paise Twelve Only',                                    100000.12],
    ['Rs. Fifty-Three Thousand Only',                                            53000],
    ['Rupees Fifty Paise Only',                                                  0.5],
  ])('%s → %s', (words, expected) => {
    expect(_amountInWords(words)).toBe(expected);
  });

  test.each([
    'Rupees Only',
    'Rupees One Lakh Banana Only',
    'Rupees Three Fifty Only',                          // not how a number is written
    'Rupees Five Thousand Two Lakh Only',               // scales out of order
    'Rupees One Lakh One Hundred Twenty Thousand Only', // a thousand group too big under a lakh
    'Rupees Hundred Only',
    'Rupees Ten and Hundred Paise Only',
  ])('malformed: %s → null', words => {
    expect(_amountInWords(words)).toBeNull();
  });
});

describe('_nameCase — a vendor name read in capitals', () => {
  const { _nameCase } = require('./parser');

  test.each([
    ['J. SAGAR ASSOCIATES',        'J. Sagar Associates'],
    ['ABC PTE LTD',                'ABC Pte Ltd'],
    ['3M SINGAPORE PTE LTD',       '3M Singapore Pte Ltd'],
    ['KL TRADING SDN BHD',         'KL Trading Sdn Bhd'],
    ['SAGAR & CO LLP',             'Sagar & Co LLP'],
    ['RELIANCE RETAIL PVT LTD',    'Reliance Retail Pvt Ltd'],
    ['THE BLACK AND WHITE STUDIO', 'The Black and White Studio'],
  ])('%s → %s', (name, expected) => {
    expect(_nameCase(name)).toBe(expected);
  });

  test.each(['J. Sagar Associates', 'iCloud Services', '3M', 'ACME', 'IBM'])('left as read: %s', name => {
    expect(_nameCase(name)).toBe(name);
  });

  test('the bill reader stores the title-cased name as vendor and contact', async () => {
    const { extractWithRetry } = require('./llm-parser');
    const { parsePDFWithLLM } = require('./parser');
    extractWithRetry.mockResolvedValue({ vendorName: 'J. SAGAR ASSOCIATES', invoiceNumber: 'BLR/26-27/2056', totalAmount: 10, lineItems: [] });
    const r = await parsePDFWithLLM('text', { date: '2026-10-05T04:00:00Z' }, 'a.pdf', 'u1', { currency: 'INR', accountCode: '310' });
    expect(r.vendorName).toBe('J. Sagar Associates');
    expect(r.contactName).toBe('J. Sagar Associates');
  });
});
