// The emailed-bill intake from a parsed email to stored rows: the queue, the
// worker, the parser, the handler and the store run for real against the test
// database; the bill model, the vision reader, the PDF text layer and Xero are
// stubbed at the edge, so nothing leaves the process.
//
// What it pins down:
//   - a row records the Message-ID of the email it came from
//   - the same email delivered again (a reconnect, a mail marked unread) is
//     recognised before the model reads it, by Message-ID and attachment
//   - the same PDF under another Message-ID is recognised by its hash
//   - a PDF inside a forwarded email is read, as from the inner sender
//   - an attached photo goes to the vision reader and is held, never posted
//   - a supplier's bill whose bank account changed is held with the reason
jest.mock('pdf-parse', () => jest.fn(async () => ({ text: `TAX INVOICE ${'line of bill text '.repeat(10)}` })));
jest.mock('../email/llm-parser', () => ({ extractWithRetry: jest.fn() }));
jest.mock('../utils/receipt-parser', () => ({ parseReceiptImage: jest.fn() }));
// The AR template's second reading is a model call too; it agrees here.
jest.mock('../email/template-verifier', () => ({
  verifyTemplateExtraction: jest.fn(async (_text, parsed) => ({ parsed, reviewReason: null })),
}));
jest.mock('../xero/invoices', () => ({ createDraftInvoice: jest.fn(), updateDraftInvoice: jest.fn() }));
jest.mock('../xero/reconnect', () => ({ reconnectXero: jest.fn(async () => {}) }));
jest.mock('../utils/notify', () => ({ notifyError: jest.fn(async () => {}), notifyInvoiceCreated: jest.fn(async () => {}) }));

const crypto = require('crypto');

const PDF  = Buffer.from('%PDF-1.4 the bill from Acme, page one');
const PDF2 = Buffer.from('%PDF-1.4 a different bill from Acme');
// A photo-sized JPEG: the start-of-image marker, enough bytes to be a picture
// rather than a signature logo, and the end marker.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40 * 1024, 7), Buffer.from([0xff, 0xd9])]);
const sha  = b => crypto.createHash('sha256').update(b).digest('hex');

const mail = (over = {}) => ({
  messageId: '<m1@acme.test>',
  from:      { text: 'Acme Billing <billing@acme.test>' },
  subject:   'Invoice A-1',
  date:      new Date('2026-09-01T03:00:00Z'),
  text:      'Please find our invoice attached.',
  attachments: [{ filename: 'A-1.pdf', contentType: 'application/pdf', content: PDF }],
  ...over,
});

const bill = (over = {}) => ({
  vendorName: 'Acme Pte Ltd', invoiceNumber: 'A-1', invoiceDate: '2026-09-01', currency: 'SGD',
  totalAmount: 109, subTotal: 100, taxAmount: 9, documentType: 'invoice',
  lineItems: [{ description: 'Widgets', amount: 100 }],
  paymentReference: 'Bank: OCBC | Acct: 601-493935-001 | Swift: OCBCSGSG | Beneficiary: Acme Pte Ltd',
  ...over,
});

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
}

let queue, worker, llm, vision, xero, settings, handler, store, userId, n = 0;

beforeEach(async () => {
  jest.resetModules();
  require('../db/migrate').run();
  queue    = require('./email-queue');
  worker   = require('./email-worker');
  llm      = require('../email/llm-parser');
  vision   = require('../utils/receipt-parser');
  xero     = require('../xero/invoices');
  settings = require('../utils/settings-store');
  const u  = await require('../utils/users').createUser(`intake${Date.now()}-${n++}@test.com`, 'password123', 'user');
  userId   = u.id;
  store    = require('../utils/invoice-store').forUser(userId);
  handler  = require('../utils/invoice-handler').createHandler(userId, { submitDelayMs: 0 });
  llm.extractWithRetry.mockReset().mockResolvedValue(bill());
  vision.parseReceiptImage.mockReset();
});
afterEach(() => worker.stopWorker(userId));

// One delivery: queued as the watcher queues it, then worked to the end.
async function deliver(email) {
  const job = queue.enqueue(userId, email);
  worker.startWorker(userId, inv => handler.onInvoiceEmail(inv));
  await until(() => !queue.getPending(userId).some(j => j.id === job.id));
  worker.stopWorker(userId);
  await handler.whenIdle();
  return job;
}

describe('the Message-ID and the file hash are stored on the row', () => {
  test('a bill read from an email carries its Message-ID and the hash of its PDF', async () => {
    await deliver(mail());
    const rows = store.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: '<m1@acme.test>', receiptHash: sha(PDF), invoiceNumber: 'A-1', pdfFilename: 'A-1.pdf' });
  });
});

describe('a re-delivered email is recognised before the model reads it', () => {
  test('the same message again: skipped, the model is not called a second time, no second row', async () => {
    await deliver(mail());
    // A second reading that differs would have slipped past the number check.
    llm.extractWithRetry.mockResolvedValue(bill({ invoiceNumber: 'A-l' }));
    const again = await deliver(mail());
    expect(llm.extractWithRetry).toHaveBeenCalledTimes(1);
    expect(store.getAll()).toHaveLength(1);
    expect(queue.getStats(userId).jobs.some(j => j.id === again.id)).toBe(false);   // finished, not left queued
  });

  test('the same Message-ID and attachment name is enough, even if the bytes came out different', async () => {
    await deliver(mail());
    await deliver(mail({ attachments: [{ filename: 'A-1.pdf', contentType: 'application/pdf', content: PDF2 }] }));
    expect(llm.extractWithRetry).toHaveBeenCalledTimes(1);
    expect(store.getAll()).toHaveLength(1);
  });

  test('a new attachment on the same message is still read; only the recorded one is skipped', async () => {
    await deliver(mail());
    llm.extractWithRetry.mockResolvedValue(bill({ invoiceNumber: 'A-2', totalAmount: 218, subTotal: 200, taxAmount: 18, lineItems: [{ description: 'More widgets', amount: 200 }] }));
    await deliver(mail({ attachments: [
      { filename: 'A-1.pdf', contentType: 'application/pdf', content: PDF },
      { filename: 'A-2.pdf', contentType: 'application/pdf', content: PDF2 },
    ] }));
    expect(llm.extractWithRetry).toHaveBeenCalledTimes(2);
    expect(store.getAll().map(r => r.invoiceNumber).sort()).toEqual(['A-1', 'A-2']);
  });

  test('a body-only email read once is not read again', async () => {
    const template = [
      'Client / Customer : Beta Pte Ltd', 'Email : ap@beta.test', 'Address : 1 Road',
      '1. Description / Details : Consulting', 'Amount : SGD1000', 'Discount :', 'Tax (If applicable) :',
    ].join('\n');
    const verify = require('../email/template-verifier').verifyTemplateExtraction;
    await deliver(mail({ messageId: '<ar-1@us.test>', text: template, attachments: [] }));
    expect(store.getAll()).toHaveLength(1);
    await deliver(mail({ messageId: '<ar-1@us.test>', text: template, attachments: [] }));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(store.getAll()).toHaveLength(1);
  });

  test('the same PDF under another Message-ID is caught by its hash', async () => {
    await deliver(mail());
    await deliver(mail({ messageId: '<fwd-77@colleague.test>', subject: 'Fwd: Invoice A-1',
      attachments: [{ filename: 'renamed.pdf', contentType: 'application/pdf', content: PDF }] }));
    expect(llm.extractWithRetry).toHaveBeenCalledTimes(1);
    expect(store.getAll()).toHaveLength(1);
  });
});

describe('a PDF inside a forwarded email', () => {
  const forwarded = () => mail({
    messageId: '<outer-1@us.test>',
    from: { text: 'Colleague <me@us.test>' },
    subject: 'Fwd: Invoice A-1',
    attachments: [{ filename: 'Invoice A-1.eml', contentType: 'message/rfc822', content: Buffer.from('From: …') }],
    forwarded: [{
      messageId: '<inner-1@acme.test>',
      from: { text: 'Acme Billing <billing@acme.test>', value: [{ address: 'billing@acme.test', name: 'Acme Billing' }] },
      subject: 'Invoice A-1 for September',
      date: new Date('2026-08-30T01:00:00Z'),
      attachments: [{ filename: 'A-1.pdf', contentType: 'application/pdf', content: PDF }],
    }],
  });

  test('is queued with the inner message as its origin', () => {
    const job = queue.enqueue(userId, forwarded());
    expect(job.email.attachments).toEqual([expect.objectContaining({
      filename: 'A-1.pdf', kind: 'pdf',
      forwarded: expect.objectContaining({ fromAddress: 'billing@acme.test', subject: 'Invoice A-1 for September', messageId: '<inner-1@acme.test>' }),
    })]);
    const email = queue.reconstructEmail(userId, job);
    expect(email.attachments[0].content.equals(PDF)).toBe(true);
    expect(email.attachments[0].forwarded.from.value[0].address).toBe('billing@acme.test');
    queue.clearAll(userId);
  });

  test('is read and stored: the contact from the inner sender, the source email the forward', async () => {
    await deliver(forwarded());
    expect(llm.extractWithRetry).toHaveBeenCalledTimes(1);
    const [row] = store.getAll();
    expect(row).toMatchObject({ invoiceNumber: 'A-1', contactEmail: 'billing@acme.test', sourceEmail: 'Colleague <me@us.test>', messageId: '<outer-1@us.test>' });
  });
});

describe('an attached photo', () => {
  const photo = () => mail({ messageId: '<snap-1@phone.test>', subject: 'Receipt from lunch',
    attachments: [{ filename: 'IMG_0042.jpg', contentType: 'image/jpeg', content: JPEG }] });

  test('is queued as a photo; a small inline logo is not', () => {
    const logo = { filename: 'logo.png', contentType: 'image/png', content: Buffer.alloc(4 * 1024, 1), related: true };
    const big  = { filename: 'banner.png', contentType: 'image/png', content: Buffer.alloc(60 * 1024, 1), related: true };
    const job = queue.enqueue(userId, mail({ attachments: [logo, big, photo().attachments[0]] }));
    expect(job.email.attachments).toEqual([expect.objectContaining({ filename: 'IMG_0042.jpg', kind: 'image', contentType: 'image/jpeg' })]);
    queue.clearAll(userId);
  });

  test('goes to the vision reader, is stored as a bill with the photo, and is held — never posted, even with auto-submit on', async () => {
    settings.forUser(userId).set({ autoProcess: true });
    vision.parseReceiptImage.mockResolvedValue({ receipts: [{
      merchant: 'Kopi Co', date: '2026-09-02', total: 12.5, tax: null, subTotal: null, currency: 'SGD',
      description: '[Entertainment/Meals] Coffee for 2 @ Kopi Co (09:12)', lineItems: [], confidence: 'high',
    }], split: false });

    await deliver(photo());

    expect(vision.parseReceiptImage).toHaveBeenCalledTimes(1);
    const [uid, buffer, mime] = vision.parseReceiptImage.mock.calls[0];
    expect(uid).toBe(userId);
    expect(buffer.equals(JPEG)).toBe(true);
    expect(mime).toBe('image/jpeg');
    expect(llm.extractWithRetry).not.toHaveBeenCalled();

    const [row] = store.getAll();
    expect(row).toMatchObject({
      invoiceType: 'ACCPAY', source: 'email-image', status: 'review-needed',
      vendorName: 'Kopi Co', totalAmount: 12.5, receiptMime: 'image/jpeg',
      messageId: '<snap-1@phone.test>', receiptHash: sha(JPEG), confidence: 'high',
      description: 'Coffee for 2 @ Kopi Co (09:12)',
    });
    expect(row.receiptFile).toBeTruthy();
    expect(row.errorMsg).toMatch(/came in as a photo/);
    expect(xero.createDraftInvoice).not.toHaveBeenCalled();
  });

  test('a photo the reader cannot read is still kept as a bill for a person', async () => {
    vision.parseReceiptImage.mockResolvedValue(null);
    await deliver(photo());
    const [row] = store.getAll();
    expect(row).toMatchObject({ source: 'email-image', status: 'review-needed', totalAmount: 0 });
    expect(row.errorMsg).toMatch(/could not be read/);
  });

  test('the same photo delivered again is not read again', async () => {
    vision.parseReceiptImage.mockResolvedValue({ receipts: [{ merchant: 'Kopi Co', total: 12.5, lineItems: [], confidence: 'high' }], split: false });
    await deliver(photo());
    await deliver(photo());
    expect(vision.parseReceiptImage).toHaveBeenCalledTimes(1);
    expect(store.getAll()).toHaveLength(1);
  });
});

describe('a supplier\'s bank details', () => {
  const second = (paymentReference, over = {}) => {
    llm.extractWithRetry.mockResolvedValue(bill({
      invoiceNumber: 'A-2', invoiceDate: '2026-10-01', totalAmount: 218, subTotal: 200, taxAmount: 18,
      lineItems: [{ description: 'More widgets', amount: 200 }], paymentReference, ...over,
    }));
    return deliver(mail({ messageId: '<m2@acme.test>', subject: 'Invoice A-2',
      attachments: [{ filename: 'A-2.pdf', contentType: 'application/pdf', content: PDF2 }] }));
  };
  const rowFor = number => store.getAll().find(r => r.invoiceNumber === number);

  test('changed since the supplier\'s last bill: held, with both sets of details in the reason', async () => {
    await deliver(mail());
    expect(rowFor('A-1').status).toBe('pending');
    await second('Bank: DBS | Acct: 072-998877-6 | Beneficiary: Acme Pte Ltd');
    const row = rowFor('A-2');
    expect(row.status).toBe('review-needed');
    expect(row.errorMsg).toMatch(/^Bank details differ from this supplier's last bill: /);
    expect(row.errorMsg).toContain('072-998877-6');
    expect(row.errorMsg).toContain('601-493935-001');
    expect(row.errorMsg).toContain('A-1, 2026-09-01');
  });

  test('changed, with auto-submit on: still held, nothing sent to Xero', async () => {
    await deliver(mail());
    settings.forUser(userId).set({ autoProcess: true });
    await second('Bank: DBS | Acct: 072-998877-6');
    expect(rowFor('A-2').status).toBe('review-needed');
    expect(xero.createDraftInvoice).not.toHaveBeenCalled();
  });

  test('unchanged, written differently: not held', async () => {
    await deliver(mail());
    await second('Bank: OCBC Bank | A/C No. 601 493935 001 | SWIFT OCBCSGSG');
    expect(rowFor('A-2')).toMatchObject({ status: 'pending', errorMsg: null });
  });

  test('nothing to compare with — the first bill, or another supplier — is not held', async () => {
    await deliver(mail());
    await second('Bank: DBS | Acct: 072-998877-6', { vendorName: 'Other Supplier Pte Ltd' });
    expect(rowFor('A-2')).toMatchObject({ status: 'pending', errorMsg: null });
  });
});
