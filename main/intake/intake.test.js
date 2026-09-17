const doc     = require('./document');
const dedup   = require('./dedup');
const { buildRecord } = require('./record');
const { PROFILES, profileFor } = require('./profiles');

// The intake core is pure: no I/O, no model, no store except a stub. What it
// guarantees is that three extractors with three vocabularies come out as one
// shape, that one dedup serves all three kinds, and that the initial status of
// a row is decided by what the document is and where it came from — not by
// which file built it.

describe('intake/document — numbers never widen', () => {
  test('a clean number passes, anything else is null', () => {
    expect(doc.num(12.5)).toBe(12.5);
    expect(doc.num('1,250.50')).toBe(1250.5);
    expect(doc.num('SGD 99')).toBe(99);
    expect(doc.num('')).toBeNull();
    expect(doc.num('abc')).toBeNull();
    expect(doc.num(NaN)).toBeNull();
    expect(doc.num(null)).toBeNull();
  });
  test('money rounds to cents', () => {
    expect(doc.money(10.005)).toBe(10.01);
    expect(doc.money('3.14159')).toBe(3.14);
  });
});

describe('intake/document — two date readers, for two jobs', () => {
  test('isoDate is strict: real ISO only, never the future', () => {
    expect(doc.isoDate('2026-08-10')).toBe('2026-08-10');
    expect(doc.isoDate('2026-13-45')).toBeNull();
    expect(doc.isoDate('10/08/2026')).toBeNull();
    expect(doc.isoDate('2099-01-01')).toBeNull();
  });
  test('addDays answers null for a date it cannot read instead of throwing', () => {
    expect(doc.addDays('TBC', 30)).toBeNull();
    expect(doc.addDays(null, 30)).toBeNull();
    expect(doc.addDays('14/09/2026', 30)).toBe('2026-10-14');   // day-first is readable
    expect(doc.addDays('2026-09-14', 30)).toBe('2026-10-14');
  });

  test('parseDate is lenient and day-first, and returns null rather than today', () => {
    expect(doc.parseDate('10/08/2026')).toBe('2026-08-10');
    expect(doc.parseDate('2026-08-10')).toBe('2026-08-10');
    expect(doc.parseDate('10 Aug 2026')).toBe('2026-08-10');
    expect(doc.parseDate('TBC')).toBeNull();
    expect(doc.parseDate('')).toBeNull();
    expect(doc.parseDate(null)).toBeNull();
  });
  test('addDays counts calendar days', () => {
    expect(doc.addDays('2026-08-17', 30)).toBe('2026-09-16');
  });
});

describe('intake/document — currency and tax', () => {
  test('a currency is a 3-letter code or nothing', () => {
    expect(doc.currencyCode(' sgd ')).toBe('SGD');
    expect(doc.currencyCode('Singapore dollars')).toBeNull();
  });
  test('detectCurrency reads the document, and a bare $ is not a signal', () => {
    expect(doc.detectCurrency('Total: SGD 1,090.00')).toBe('SGD');
    expect(doc.detectCurrency('Amount S$500')).toBe('SGD');
    expect(doc.detectCurrency('Fee £250')).toBe('GBP');
    expect(doc.detectCurrency('Total $500')).toBeNull();
    expect(doc.detectCurrency('')).toBeNull();
  });
  test('a tax percentage is read from text; a bare label is not a rate', () => {
    expect(doc.parseTaxPercent('GST 9%')).toBe(9);
    expect(doc.parseTaxPercent('VAT (20%)')).toBe(20);
    expect(doc.parseTaxPercent('GST')).toBeNull();
    expect(doc.parseTaxPercent('')).toBeNull();
  });
  test('subTotal + tax = total is always restored', () => {
    expect(doc.ensureSubtotalTax({ total: 109 })).toMatchObject({ subTotal: 109, taxAmount: 0 });
    expect(doc.ensureSubtotalTax({ total: 109, taxAmount: 9 })).toMatchObject({ subTotal: 100, taxAmount: 9 });
    expect(doc.ensureSubtotalTax({ total: 109, subTotal: 100 })).toMatchObject({ subTotal: 100, taxAmount: 9 });
    // a stated subtotal is kept even when it exceeds the total; only the tax
    // that would go negative is clamped, so nothing negative reaches Xero
    expect(doc.ensureSubtotalTax({ total: 100, subTotal: 120 })).toMatchObject({ subTotal: 120, taxAmount: 0 });
  });
});

describe('intake/document — three vocabularies, one shape', () => {
  const bill    = { vendorName: 'Isetan', invoiceNumber: 'A-1', invoiceDate: '2026-08-10', totalAmount: '109.00', taxAmount: 9, currency: 'sgd', lineItems: [{ description: 'Goods', amount: 100 }] };
  const receipt = { merchant: 'Grab', date: '2026-08-10', total: 18.4, tax: null, currency: 'SGD', lineItems: [{ name: 'Ride', price: 18.4 }] };
  const invoice = { contactName: 'PereOcean', contactEmail: 'x@y.com', invoiceNumber: 'PO-1', invoiceDate: '2026-08-10', totalAmount: 1000, subTotal: 1000, taxAmount: 0, currency: 'SGD', lineItems: [{ description: 'Water', unitAmount: 1000, discountRate: 0 }] };

  test('a bill, a receipt and an invoice all normalise to the same keys', () => {
    const keys = o => Object.keys(o).sort().join(',');
    const [b, r, i] = [bill, receipt, invoice].map(doc.normaliseDocument);
    expect(keys(b)).toBe(keys(r));
    expect(keys(r)).toBe(keys(i));
    expect(b.contact.name).toBe('Isetan');
    expect(r.contact.name).toBe('Grab');
    expect(i.contact.name).toBe('PereOcean');
  });
  test('values are cleaned on the way in', () => {
    const b = doc.normaliseDocument(bill);
    expect(b.total).toBe(109);
    expect(b.currency).toBe('SGD');
    expect(b.subTotal).toBe(100);
    expect(b.lineItems).toEqual([{ description: 'Goods', unitAmount: 100, discountRate: 0, taxPercent: null }]);
  });
  test('a line item that has neither description nor amount is dropped; one with either is kept', () => {
    const d = doc.normaliseDocument({ lineItems: [{}, { description: 'x' }, { amount: 5 }] });
    expect(d.lineItems).toHaveLength(2);
    expect(d.lineItems[1].description).toBe('Item');
  });
  test('nothing is invented for a missing field', () => {
    const d = doc.normaliseDocument({});
    expect(d.contact.name).toBeNull();
    expect(d.number).toBeNull();
    expect(d.date).toBeNull();
    expect(d.currency).toBeNull();
    expect(d.total).toBeNull();
  });
});

describe('intake/profiles — where the three kinds differ', () => {
  test('every profile answers the same questions', () => {
    for (const p of Object.values(PROFILES)) {
      expect(['bill', 'invoice', 'claim']).toContain(p.kind);
      expect(['ACCPAY', 'ACCREC']).toContain(p.xeroType);
      expect(['supplier', 'customer']).toContain(p.contactRole);
      expect(typeof p.initialStatus('email')).toBe('string');
      expect(typeof p.autoPost('email')).toBe('boolean');
    }
  });
  test('an emailed bill is pending and may auto-post; an uploaded one waits for a person', () => {
    expect(PROFILES.ACCPAY.initialStatus('email')).toBe('pending');
    expect(PROFILES.ACCPAY.autoPost('email')).toBe(true);
    expect(PROFILES.ACCPAY.initialStatus('upload')).toBe('review-needed');
    expect(PROFILES.ACCPAY.autoPost('upload')).toBe(false);
  });
  test('an emailed invoice is pending; a composed or imported one waits for a person', () => {
    expect(PROFILES.ACCREC.initialStatus('email')).toBe('pending');
    expect(PROFILES.ACCREC.autoPost('email')).toBe(true);
    for (const s of ['form', 'spreadsheet']) {
      expect(PROFILES.ACCREC.initialStatus(s)).toBe('review-needed');
      expect(PROFILES.ACCREC.autoPost(s)).toBe(false);
    }
  });

  test('a claim never auto-posts, whatever the source', () => {
    for (const s of ['upload', 'phone', 'claim']) {
      expect(PROFILES.EXPENSE.initialStatus(s)).toBe('review-needed');
      expect(PROFILES.EXPENSE.autoPost(s)).toBe(false);
    }
  });
  test('a claim posts to Xero as a bill', () => {
    expect(PROFILES.EXPENSE.xeroType).toBe('ACCPAY');
  });
  test('an unknown type is an error, not a silent default', () => {
    expect(() => profileFor('WHATEVER')).toThrow(/No intake profile/);
  });
});

describe('intake/dedup — one implementation, three kinds', () => {
  const rows = [
    { id: 'r1', vendorName: 'Isetan Singapore Pte Ltd', invoiceDate: '2026-08-10', totalAmount: 45.5, status: 'reviewed' },
    { id: 'r2', vendorName: 'Grab',                     invoiceDate: '2026-08-10', totalAmount: 18.4, status: 'duplicate' },
  ];
  const store = {
    getAll: () => rows,
    findByReceiptHash: h => (h === 'abc' ? rows[0] : null),
    findStored: (name, number) => (number === 'A-1' ? rows[0] : null),
  };

  test('the same file is a certain duplicate', () => {
    const r = dedup.findDuplicate({ store, hash: 'abc', profile: PROFILES.EXPENSE });
    expect(r).toMatchObject({ match: rows[0], certain: true });
  });
  test('a matching document number is a certain duplicate, for kinds that carry numbers', () => {
    const r = dedup.findDuplicate({ store, profile: PROFILES.ACCPAY, contactName: 'Isetan', number: 'A-1', date: '2026-08-10', amount: 45.5 });
    expect(r).toMatchObject({ certain: true, reason: 'the same document number' });
  });
  test('a claim ignores numbers even when one is passed', () => {
    const r = dedup.findDuplicate({ store, profile: PROFILES.EXPENSE, contactName: 'Nobody', number: 'A-1', date: '2000-01-01', amount: 1 });
    expect(r).toBeNull();
  });
  test('vendor + date + amount is only ever a suspicion', () => {
    const r = dedup.findDuplicate({ store, contactName: 'isetan', date: '2026-08-10', amount: 45.5 });
    expect(r).toMatchObject({ match: rows[0], certain: false });
  });
  test('a row already marked duplicate is not a match target', () => {
    expect(dedup.findDuplicate({ store, contactName: 'Grab', date: '2026-08-10', amount: 18.4 })).toBeNull();
  });
  test('any of the three fields missing means no fields match', () => {
    expect(dedup.findDuplicate({ store, contactName: 'Isetan', amount: 45.5 })).toBeNull();
    expect(dedup.findDuplicate({ store, date: '2026-08-10', amount: 45.5 })).toBeNull();
  });
  test('excludeId keeps a record from matching itself', () => {
    expect(dedup.findDuplicate({ store, hash: 'abc', excludeId: 'r1' })).toBeNull();
  });
  test('vendor matching tolerates suffixes and brand containment, not unrelated names', () => {
    expect(dedup.vendorMatches('Isetan Singapore Pte Ltd', 'ISETAN')).toBe(true);
    expect(dedup.vendorMatches('Grab Holdings Inc', 'grab')).toBe(true);
    expect(dedup.vendorMatches('Grab', 'Gojek')).toBe(false);
  });
});

describe('intake/record — one row builder', () => {
  const d = doc.normaliseDocument({ vendorName: 'Isetan', invoiceNumber: 'A-1', invoiceDate: '2026-08-10', totalAmount: 109, taxAmount: 9, currency: 'SGD', lineItems: [{ description: 'Goods', amount: 100 }] });

  test('the same document is a different row depending on what it is and where it came from', () => {
    const emailed  = buildRecord({ document: d, invoiceType: 'ACCPAY',  source: 'email'  });
    const uploaded = buildRecord({ document: d, invoiceType: 'ACCPAY',  source: 'upload' });
    const claim    = buildRecord({ document: d, invoiceType: 'EXPENSE', source: 'upload' });
    expect(emailed.status).toBe('pending');
    expect(uploaded.status).toBe('review-needed');
    expect(claim.status).toBe('review-needed');
    expect(claim.invoiceType).toBe('EXPENSE');   // the store's own vocabulary, not the Xero type
  });
  test('the row carries what the handler always wrote, with the same defaults', () => {
    const r = buildRecord({ document: d, invoiceType: 'ACCPAY', source: 'email', defaults: { accountCode: '310' } });
    expect(r).toMatchObject({
      vendorName: 'Isetan', contactName: 'Isetan', invoiceNumber: 'A-1', invoiceDate: '2026-08-10',
      totalAmount: 109, subTotal: 100, taxAmount: 9, currency: 'SGD', accountCode: '310',
      hasPdf: false, reports: [],
    });
    expect(r.lineItems).toEqual([{ description: 'Goods', unitAmount: 100, discountRate: 0 }]);
    expect(r.id).toMatch(/^\d{13}[a-z0-9]{8}$/);   // utils/ids: eight random characters behind the timestamp
  });
  test('an empty document still produces a row a person can fix, not a crash', () => {
    const r = buildRecord({ document: doc.normaliseDocument({}), invoiceType: 'EXPENSE', source: 'phone' });
    expect(r.vendorName).toBe('Unknown');
    expect(r.invoiceNumber).toBe('—');
    expect(r.totalAmount).toBe(0);
    expect(r.currency).toBe(require('../utils/users').getUserDefaults(null).currency);   // one shared default, not a literal
  });
  test('extras override defaults but cannot change the shape', () => {
    const r = buildRecord({ document: d, invoiceType: 'ACCPAY', source: 'upload', extras: { hasPdf: true, pdfFilename: 'a.pdf', receivedAt: '2026-08-01T00:00:00Z' } });
    expect(r.hasPdf).toBe(true);
    expect(r.pdfFilename).toBe('a.pdf');
    expect(r.receivedAt).toBe('2026-08-01T00:00:00Z');
  });
});
