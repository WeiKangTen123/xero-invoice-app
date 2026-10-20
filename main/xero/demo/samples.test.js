// The demo documents are only useful if the app reads them as intended, so
// each one is checked against the reader the app actually uses on it: the AR
// template parser on the email bodies, pdf-parse (what email/parser.js
// extractText runs) on the bills, and the attachment classifier on the photo.
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const sharp    = require('sharp');

const { buildSamples, writeSamples, SAMPLE_KINDS, singaporeToday } = require('./samples');
const { parseTemplateFormat } = require('../../email/parser');
const { documentKind, MIN_IMAGE_BYTES } = require('../../intake/document');
const { CATEGORY_NAMES } = require('../../claims/categories');

const TODAY = '2026-10-20';
const SEED  = 'recording-1';

let samples;
beforeAll(async () => { samples = await buildSamples({ today: TODAY, seed: SEED }); });

const byId = id => samples.emails.find(e => e.id === id);
const attachment = id => byId(id).attachments[0];
// Per line, rounded half up in cents: what the demo Xero (api.js) charges.
const lineGst = amount => Math.round(Math.round(amount * 100) * 9 / 100) / 100;
const sum = list => Math.round(list.reduce((s, v) => s + v * 100, 0)) / 100;

describe('the set', () => {
  test('SAMPLE_KINDS names every kind', () => {
    expect(SAMPLE_KINDS).toEqual(['ar', 'ap', 'ap-photo', 'receipt']);
  });

  test('five emails in sending order and three receipts, in the agreed shapes', () => {
    expect(samples.emails.map(e => e.kind)).toEqual(['ar', 'ar', 'ap', 'ap', 'ap-photo']);
    for (const e of samples.emails) {
      expect(typeof e.id).toBe('string');
      expect(e.subject).toBeTruthy();
      expect(e.text).toBeTruthy();
      expect(Array.isArray(e.attachments)).toBe(true);
      for (const a of e.attachments) {
        expect(a.filename).toMatch(/\.(pdf|jpg)$/);
        expect(Buffer.isBuffer(a.content)).toBe(true);
      }
    }
    expect(samples.emails.filter(e => e.kind === 'ar').every(e => e.attachments.length === 0)).toBe(true);
    expect(samples.emails.filter(e => e.kind !== 'ar').every(e => e.attachments.length === 1 && /^Please find attached/.test(e.text))).toBe(true);

    expect(samples.receipts).toHaveLength(3);
    for (const r of samples.receipts) {
      expect(r.contentType).toBe('image/jpeg');
      expect(r.filename).toMatch(/\.jpg$/);
      expect(Buffer.isBuffer(r.content)).toBe(true);
      expect(Object.keys(r.expected)).toEqual(expect.arrayContaining(['merchant', 'total', 'date', 'category']));
    }
    const ids = [...samples.emails, ...samples.receipts].map(x => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('builds in well under three seconds', async () => {
    const t = Date.now();
    await buildSamples({ today: TODAY, seed: 'timing' });
    expect(Date.now() - t).toBeLessThan(3000);
  });

  test('defaults to today in Singapore, and refuses a date it cannot read', async () => {
    expect(singaporeToday(new Date('2026-10-19T16:30:00Z'))).toBe('2026-10-20');   // 00:30 in Singapore
    const fresh = await buildSamples();
    expect(fresh.receipts[0].expected.date).toBe(singaporeToday());
    await expect(buildSamples({ today: '20/10/2026' })).rejects.toThrow(/today must be a date/);
    await expect(buildSamples({ today: '2026-02-30' })).rejects.toThrow(/today must be a date/);
  });
});

describe('AR: the email template', () => {
  const email = { subject: 'x', date: `${TODAY}T02:00:00.000Z`, from: { text: 'Demo <demo@example.sg>', value: [{ address: 'demo@example.sg' }] } };
  const defaults = { currency: 'USD', accountCode: '200' };

  test('both bodies are recognised as the template', () => {
    for (const id of ['ar-harbourline', 'ar-meridian']) {
      const { text } = byId(id);
      expect(text).toMatch(/Client\s*\/\s*Customer[^:\n]*:/i);
      expect(text).toMatch(/(?:\d+\.\s*)?Description\s*\/\s*Details\s*:/i);
    }
  });

  test('Harbourline: one line of 4,800, from the Demo Company customer on file', () => {
    const e = byId('ar-harbourline');
    expect(e.subject).toBe('Harbourline Logistics – invoice for Q4 telematics');
    const p = parseTemplateFormat(e.text, email, defaults);
    expect(p.contactName).toBe('Harbourline Logistics Pte Ltd');
    expect(p.contactEmail).toBe('accounts@harbourline.example.sg');
    expect(p.contactAddress).toBe('9 Pandan Crescent #04-11, Singapore 128465');
    expect(p.currency).toBe('SGD');
    expect(p.lineAmountTypes).toBe('Exclusive');
    expect(p.lineItems.map(l => l.unitAmount)).toEqual([4800]);
    expect(p.lineItems[0].description).toMatch(/Fleet telematics subscription, Q4 2026/);
    expect(p.lineItems[0].description).not.toMatch(/Amount\s*:/);
    expect(p.totalAmount).toBe(4800);
    expect(p.dueDate).toBe('2026-11-19');
    expect(p.reviewReason).toBeNull();
    expect(e.expected).toMatchObject({ contact: p.contactName, total: p.totalAmount, lineItems: [4800] });
  });

  test('Meridian: two lines, 1,850 and 500, neither read as a payment schedule', () => {
    const e = byId('ar-meridian');
    const p = parseTemplateFormat(e.text, email, defaults);
    expect(p.contactName).toBe('Meridian Fitouts Pte Ltd');
    expect(p.contactEmail).toBe('ap@meridianfitouts.example.sg');
    expect(p.lineItems.map(l => l.unitAmount)).toEqual([1850, 500]);
    expect(p.lineItems[1].description).toMatch(/^Project: Layout plan/);
    expect(p.totalAmount).toBe(2350);
    expect(p.reviewReason).toBeNull();
    expect(p.description).toBe('Site survey and measured drawings, Layout plan');
  });
});

describe('AP: the PDF tax invoices', () => {
  const cases = [
    { id: 'ap-sunbright', supplier: 'Sunbright Office Supplies Pte Ltd', gst: 'M90471236K', number: /^SB-2026-\d{4}$/, total: '386.40', figures: [354.50, 31.90, 386.40] },
    { id: 'ap-kestrel',   supplier: 'Kestrel Cloud Services Pte Ltd',    gst: '201734918W', number: /^KCS-202610-\d{4}$/, total: '1,290.00', figures: [1183.49, 106.51, 1290.00] },
  ];

  test.each(cases)('$supplier: the text pdf-parse extracts names the supplier, number and total', async c => {
    const a = attachment(c.id);
    const { expected } = byId(c.id);
    expect(a.contentType).toBe('application/pdf');
    expect(documentKind(a)).toBe('pdf');
    expect(expected.invoiceNumber).toMatch(c.number);
    expect(a.filename).toContain(expected.invoiceNumber);

    const { text, numpages } = await pdfParse(a.content);   // as email/parser.js extractText calls it
    expect(numpages).toBe(1);
    expect(text.trim().length).toBeGreaterThan(50);            // extractText's "has a text layer" test
    expect(text).toContain(c.supplier);
    expect(text).toContain(`GST Reg No: ${c.gst}`);
    expect(text).toContain(`Invoice No.: ${expected.invoiceNumber}`);
    expect(text).toContain(`Total (incl. GST) S$ ${c.total}`);
    expect(text).toContain('Invoice date: 20 Oct 2026');
    expect(text).toContain('Due date: 19 Nov 2026');
    expect(text).toContain('Demo Company Pte Ltd\n3 Westgate Tower, #03-12\nSingapore 608532');
    // A row's cells stay apart: "1 980.00 980.00", never "1980.00980.00".
    expect(text).not.toMatch(/\d\.\d\d\d/);
  });

  test.each(cases)('$supplier: the lines, GST per line and total agree to the cent', ({ id, figures }) => {
    const { expected } = byId(id);
    const [subTotal, gst, total] = figures;
    expect([expected.subTotal, expected.gst, expected.total]).toEqual(figures);
    expect(sum(expected.lineItems)).toBe(subTotal);
    expect(sum(expected.lineItems.map(lineGst))).toBe(gst);
    expect(sum([subTotal, gst])).toBe(total);
  });
});

describe('AP photo: the catering bill', () => {
  test('a JPEG over 1000 px wide that the mail intake treats as a document, not a logo', async () => {
    const a = attachment('ap-orchid');
    const meta = await sharp(a.content).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBeGreaterThanOrEqual(1000);
    expect(meta.height).toBeGreaterThan(meta.width);
    expect(a.content.length).toBeGreaterThanOrEqual(MIN_IMAGE_BYTES);
    expect(documentKind(a)).toBe('image');
  });

  test('612.00 incl. GST, adding up per line', () => {
    const { expected } = byId('ap-orchid');
    expect(expected).toMatchObject({ supplier: 'Orchid Catering Pte Ltd', subTotal: 561.47, gst: 50.53, total: 612 });
    expect(sum(expected.lineItems)).toBe(561.47);
    expect(sum(expected.lineItems.map(lineGst))).toBe(50.53);
  });
});

describe('receipts for Add Claim', () => {
  test('narrow thermal receipts as JPEGs', async () => {
    for (const r of samples.receipts) {
      const meta = await sharp(r.content).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(600);
      expect(meta.height).toBeGreaterThanOrEqual(1400);
      expect(meta.height).toBeLessThan(1700);
    }
  });

  test('what the claim reader is expected to find', () => {
    expect(samples.receipts.map(r => r.expected)).toEqual([
      { merchant: 'Common Grounds Coffee', total: 14.6,  date: TODAY, category: 'Entertainment/Meals', time: expect.stringMatching(/^09:\d\d$/), currency: 'SGD', tax: 1.21 },
      { merchant: 'Grab',                  total: 18.4,  date: TODAY, category: 'Local Travel',        time: '08:52',                            currency: 'SGD', tax: 1.52 },
      { merchant: 'Popular Bookstore',     total: 42.35, date: TODAY, category: 'Office Supplies',     time: expect.stringMatching(/^12:\d\d$/), currency: 'SGD', tax: 3.5 },
    ]);
    for (const r of samples.receipts) expect(CATEGORY_NAMES).toContain(r.expected.category);
  });
});

describe('determinism', () => {
  test('the same seed gives the same bytes', async () => {
    const again = await buildSamples({ today: TODAY, seed: SEED });
    expect(again.emails.map(e => [e.subject, e.text])).toEqual(samples.emails.map(e => [e.subject, e.text]));
    samples.emails.forEach((e, i) => e.attachments.forEach((a, j) => {
      expect(again.emails[i].attachments[j].filename).toBe(a.filename);
      expect(again.emails[i].attachments[j].content.equals(a.content)).toBe(true);
    }));
    samples.receipts.forEach((r, i) => expect(again.receipts[i].content.equals(r.content)).toBe(true));
  });

  test('another seed gives other numbers and other files, from the same suppliers', async () => {
    const other = await buildSamples({ today: TODAY, seed: 'recording-2' });
    for (const id of ['ap-sunbright', 'ap-kestrel', 'ap-orchid']) {
      const a = byId(id).expected, b = other.emails.find(e => e.id === id).expected;
      expect(b.invoiceNumber).not.toBe(a.invoiceNumber);
      expect(b.supplier).toBe(a.supplier);
      expect(b.gstRegNo).toBe(a.gstRegNo);
      expect(b.total).toBe(a.total);
    }
    // Every file differs, so the app's duplicate check (a hash of the bytes)
    // does not take a second take for the first.
    samples.emails.slice(2).forEach((e, i) => expect(other.emails[i + 2].attachments[0].content.equals(e.attachments[0].content)).toBe(false));
    samples.receipts.forEach((r, i) => expect(other.receipts[i].content.equals(r.content)).toBe(false));
  });
});

describe('writeSamples', () => {
  test('writes every attachment, each AR body and every receipt, creating the folders', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-samples-')), 'nested', 'out');
    try {
      const written = await writeSamples(dir, samples);
      const expected = [
        path.join(dir, 'emails', 'ar-harbourline.txt'),
        path.join(dir, 'emails', 'ar-meridian.txt'),
        ...samples.emails.flatMap(e => e.attachments.map(a => path.join(dir, 'emails', a.filename))),
        ...samples.receipts.map(r => path.join(dir, 'receipts', r.filename)),
      ];
      expect(written.sort()).toEqual(expected.sort());
      expect(written).toHaveLength(8);
      for (const file of written) expect(fs.statSync(file).size).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(dir, 'emails', 'ar-meridian.txt'), 'utf8').trim()).toBe(byId('ar-meridian').text);
      const pdf = attachment('ap-kestrel');
      expect(fs.readFileSync(path.join(dir, 'emails', pdf.filename)).equals(pdf.content)).toBe(true);
    } finally {
      fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true });
    }
  });
});
