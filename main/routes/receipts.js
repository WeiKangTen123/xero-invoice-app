const express      = require('express');
const router       = express.Router();
const jwt          = require('jsonwebtoken');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const invoiceStore = require('../utils/invoice-store');
const receiptStore = require('../utils/receipt-store');
const pairing      = require('../utils/pairing');
const { parseReceiptImage } = require('../utils/receipt-parser');
// Required as a module rather than destructured so the functions are looked up
// at call time — a destructured import captures the original reference and can
// never be substituted in a test.
const pdfPages = require('../utils/pdf-pages');
const QRCode       = require('qrcode');
const logger       = require('../utils/logger');

// Expense claims. A receipt arrives as a file rather than an email attachment,
// so this is the only intake path the user drives by hand.
//
// NOTHING here writes to Xero. A receipt becomes a local record that the user
// reviews; building and sending the Xero payload is a separate, later step.
//
// Uploads are base64 JSON rather than multipart on purpose: express.json is
// already mounted at 10mb, so this needs no new dependency, and the client
// compresses to well under the 3MB Xero attachment cap before sending anyway.

// Browsers cannot attach an Authorization header to an <img src>, so image
// access uses the same short-lived, single-purpose token the PDF route uses.
const IMAGE_TOKEN_TTL = '5m';

function issueImageToken(userId, invoiceId) {
  return jwt.sign({ userId, invoiceId, purpose: 'receipt' }, jwtSecret(), { expiresIn: IMAGE_TOKEN_TTL });
}

function verifyImageToken(token, invoiceId) {
  const payload = jwt.verify(token, jwtSecret());
  // A PDF token must not open a receipt, and a token for one receipt must not
  // open another. Both are checked, not just expiry.
  if (payload.purpose !== 'receipt' || payload.invoiceId !== invoiceId) {
    throw new Error('Token scope mismatch');
  }
  return payload;
}

// Base64 can carry a data: prefix depending on how the client built it. Decode
// strictly: a string that isn't valid base64 must fail here, not produce a
// truncated file that looks stored but won't open.
function decodeBase64(data) {
  if (typeof data !== 'string' || !data) return null;
  const raw = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw.replace(/\s/g, ''))) return null;
  const buf = Buffer.from(raw, 'base64');
  return buf.length ? buf : null;
}

// Shared by the authenticated desktop upload and the paired phone upload, so
// the two cannot drift apart on validation, ordering or the state a new receipt
// lands in. Returns { status, body }.
function storeReceipt(userId, { mime, data, filename, source }) {
  if (!receiptStore.isAcceptedMime(mime)) {
    return { status: 400, body: {
      error: `Unsupported file type${mime ? ` (${mime})` : ''}. Accepted: ${receiptStore.acceptedMimes().join(', ')}.`,
    } };
  }

  const buffer = decodeBase64(data);
  if (!buffer) return { status: 400, body: { error: 'File data is missing or not valid base64' } };

  if (buffer.length > receiptStore.MAX_BYTES) {
    const mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`;
    return { status: 413, body: {
      error: `Receipt is ${mb(buffer.length)}; Xero accepts at most ${mb(receiptStore.MAX_BYTES)}. Try a lower-resolution photo.`,
    } };
  }

  const id = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
  // Store the file BEFORE the row. A failed write must not leave a record
  // pointing at an image that was never saved.
  const storedName = receiptStore.forUser(userId).save(id, buffer, mime);

  const record = invoiceStore.forUser(userId).add({
    id,
    status:      'review-needed',   // nothing is known until it is read or typed
    invoiceType: 'EXPENSE',
    source:      source === 'phone' ? 'phone' : 'upload',
    receiptFile: storedName,
    receiptMime: mime,
    description: filename ? String(filename).slice(0, 200) : null,
    processedAt: new Date().toISOString(),
  });

  logger.info('Receipt stored', { userId, id, bytes: buffer.length, mime, source: source || 'upload' });

  // Read the receipt AFTER it is safely stored, and off the response path.
  //
  // Two reasons it is not awaited. A phone on mobile data should not hold a
  // request open for the several seconds a vision call takes, and a batch of
  // five receipts would otherwise be five sequential waits. The row already
  // exists and is already visible; parsing only fills it in.
  //
  // Parsing is an enhancement, never a gate: if it fails the receipt stays
  // exactly where it is, at review-needed, for the user to type by hand.
  setImmediate(() => {
    readAndMaybeSplit(userId, id, buffer, mime, storedName)
      .catch(err => logger.warn('Receipt read failed', { userId, id, error: err.message }));
  });

  return { status: 201, body: { receipt: record, imageToken: issueImageToken(userId, id) } };
}

// Applies one receipt's fields to a record.
function _applyFields(userId, id, r, extra = {}) {
  invoiceStore.forUser(userId).update(id, {
    vendorName:  r.merchant    ?? undefined,
    invoiceDate: r.date        ?? undefined,
    currency:    r.currency    ?? undefined,
    totalAmount: r.total       ?? undefined,
    taxAmount:   r.tax         ?? undefined,
    subTotal:    r.subTotal    ?? undefined,
    description: r.description ?? undefined,
    ...extra,
  });
}

// Reads an upload and, when the evidence is unambiguous, turns one upload into
// several records.
//
// Crucially the FILE IS NEVER CUT UP. Every sibling points at the same stored
// file and carries the region it owns — a bounding box for a photo, a page
// number for a PDF — and the UI crops on display. That means:
//   * no server-side image library, and no PDF renderer
//   * the original is always intact, so merging back is just deleting rows
//   * a bad split costs one click to undo and loses nothing
//
// Splitting only happens when receipt-parser's splittable() or pdf-pages'
// splittablePages() says the evidence is clean. Anything doubtful stays as one
// record holding the whole upload, because inventing a second receipt is worse
// than failing to split a real one.
async function readAndMaybeSplit(userId, id, buffer, mime, storedName) {
  const store = invoiceStore.forUser(userId);

  // ── PDF: one record per page ──────────────────────────────────────────────
  if (mime === 'application/pdf') {
    const extracted = await pdfPages.extractPages(buffer);
    const decision  = pdfPages.splittablePages(extracted);
    if (!decision.split) {
      logger.info('PDF kept as one receipt', { userId, id, reason: decision.reason });
      return;
    }

    const group = id;
    const [first, ...rest] = decision.pageNumbers;
    store.update(id, { receiptPage: first, receiptGroup: group });
    for (const page of rest) {
      const sibId = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
      store.add({
        id: sibId,
        status: 'review-needed',
        invoiceType: 'EXPENSE',
        source: 'upload',
        receiptFile: storedName,      // the SAME file
        receiptMime: mime,
        receiptPage: page,
        receiptGroup: group,
        processedAt: new Date().toISOString(),
      });
    }
    logger.info('PDF split by page', { userId, id, pages: decision.pageNumbers.length });
    return;
  }

  // ── Image: one record per detected receipt ────────────────────────────────
  const parsed = await parseReceiptImage(userId, buffer, mime);
  if (!parsed) return;                       // unreadable — the record survives as-is

  const { receipts, split, reason } = parsed;

  if (!split) {
    // One receipt, or evidence too weak to split on. Either way the whole image
    // stays on one record.
    _applyFields(userId, id, receipts[0]);
    logger.info('Receipt read', { userId, id, receipts: receipts.length, split: false, reason });
    return;
  }

  const group = id;
  const [first, ...rest] = receipts;
  _applyFields(userId, id, first, { receiptBox: JSON.stringify(first.box), receiptGroup: group });
  for (const r of rest) {
    const sibId = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
    store.add({
      id: sibId,
      status: 'review-needed',
      invoiceType: 'EXPENSE',
      source: 'upload',
      receiptFile: storedName,        // the SAME file
      receiptMime: mime,
      receiptBox: JSON.stringify(r.box),
      receiptGroup: group,
      processedAt: new Date().toISOString(),
    });
    _applyFields(userId, sibId, r);
  }
  logger.info('Photo split into separate receipts', { userId, id, count: receipts.length });
}

// POST /api/receipts  { mime, data, filename?, source? }
router.post('/', requireAuth, (req, res) => {
  try {
    const { status, body } = storeReceipt(req.user.id, req.body || {});
    res.status(status).json(body);
  } catch (err) {
    logger.error('Receipt upload failed', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// ── Phone pairing ───────────────────────────────────────────────────────────
// The desktop mints a token, renders it as a QR code, and the phone opens the
// link. The token in that URL is the only credential the phone has, so it grants
// upload and nothing else. See utils/pairing.js.

function captureUrl(req, token) {
  // Behind nginx with trust proxy set, these reflect the public origin.
  return `${req.protocol}://${req.get('host')}/capture/${token}`;
}

// POST /api/receipts/pair — desktop asks for a QR
router.post('/pair', requireAuth, async (req, res) => {
  try {
    const token = pairing.create(req.user.id);
    const url   = captureUrl(req, token);
    // SVG rather than a data URL: it scales to any panel size without going
    // blurry, and it keeps the qrcode dependency out of the UI bundle.
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' });
    logger.info('Receipt pairing created', { userId: req.user.id });
    res.status(201).json({ token, url, qrSvg, expiresInMs: pairing.TTL_MS, maxUploads: pairing.MAX_USES });
  } catch (err) {
    logger.error('Pairing failed', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'Could not create a pairing code' });
  }
});

// GET /api/receipts/pair/:token — desktop polls its OWN pairing for arrivals.
// Returns the receipts themselves, each with a viewing token, so the dialog can
// show the photo that just landed rather than only a counter. One poll carries
// everything the panel needs.
router.get('/pair/:token', requireAuth, (req, res) => {
  if (!pairing.ownedBy(req.params.token, req.user.id)) {
    return res.status(404).json({ error: 'Pairing not found' });
  }
  // status(), not verify(): this only describes the pairing, and a pairing that
  // has spent its whole budget still has photos worth showing.
  const state = pairing.status(req.params.token);
  if (!state) return res.json({ alive: false, spent: false, uploads: 0, receipts: [] });

  const store = invoiceStore.forUser(req.user.id);
  const receipts = state.receiptIds
    .map(id => {
      const r = store.getById(id);
      if (!r) return null;   // deleted between arriving and this poll
      return {
        id: r.id,
        // Parsing is asynchronous, so these fill in over successive polls.
        vendorName:  r.vendorName,
        totalAmount: r.totalAmount,
        currency:    r.currency,
        imageToken:  issueImageToken(req.user.id, r.id),
      };
    })
    .filter(Boolean);

  res.json({
    alive: state.alive,
    spent: state.spent,
    uploads: state.uses,
    usesLeft: state.usesLeft,
    expiresInMs: state.expiresInMs,
    receipts,
  });
});

// DELETE /api/receipts/pair/:token — desktop revokes when the dialog closes, so
// a QR that was on screen stops working the moment the user is done with it.
router.delete('/pair/:token', requireAuth, (req, res) => {
  if (!pairing.ownedBy(req.params.token, req.user.id)) {
    return res.status(404).json({ error: 'Pairing not found' });
  }
  pairing.revoke(req.params.token);
  res.json({ ok: true });
});

// GET /api/receipts/capture/:token — the phone checks the link before opening a
// camera. No auth: the token is the credential. Returns nothing identifying.
router.get('/capture/:token', (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json({ ok: false, error: 'This link has expired. Show a new QR code on your computer.' });
  res.json({ ok: true, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs });
});

// GET /api/receipts/capture/:token/status — what the phone shows after a photo.
//
// A deliberately narrow widening of the phone's capability. It returns the
// PARSED FIELDS of receipts uploaded through THIS token, and nothing else:
//   * no image is served — the phone took the photo and already has it locally,
//     so it renders its own file rather than fetching one back
//   * no receipt outside this pairing is reachable, whoever owns it
//   * no identity, no totals for the account, no list of anything else
//
// The point is confirmation that the RECEIPT was captured, not merely that a
// file moved. "Grab · SGD 18.40" says that; "IMG_2841.jpg" does not.
router.get('/capture/:token/status', (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json({ error: 'This link has expired. Show a new QR code on your computer.' });

  const store = invoiceStore.forUser(state.userId);
  const receipts = state.receiptIds
    .map(id => {
      const r = store.getById(id);
      if (!r) return null;
      return {
        id: r.id,
        // Null until the vision parse finishes, which is why the phone shows
        // "Reading…" for a moment and then the amount.
        vendorName:  r.vendorName  || null,
        totalAmount: r.totalAmount || null,
        currency:    r.currency    || null,
        // True once parsing has been attempted and produced nothing usable, so
        // the phone can say "not read" rather than spinning forever.
        parsed: !!(r.vendorName || r.totalAmount),
      };
    })
    .filter(Boolean);

  res.json({ ok: true, usesLeft: state.usesLeft, expiresInMs: state.expiresInMs, receipts });
});

// POST /api/receipts/capture/:token — the phone uploads. No auth by design.
router.post('/capture/:token', (req, res) => {
  const state = pairing.verify(req.params.token);
  if (!state) return res.status(401).json({ error: 'This link has expired. Show a new QR code on your computer.' });

  try {
    const { status, body } = storeReceipt(state.userId, { ...(req.body || {}), source: 'phone' });
    // Only a stored receipt spends an upload — a rejected file must not burn
    // one of the user's twenty.
    if (status === 201) pairing.consume(req.params.token, body.receipt?.id);
    // The phone has no business receiving a token that can read the image back.
    if (body.imageToken) delete body.imageToken;
    res.status(status).json(body);
  } catch (err) {
    logger.error('Paired upload failed', { error: err.message });
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// GET /api/receipts/:id/token — mint a viewing token for <img src>
router.get('/:id/token', requireAuth, (req, res) => {
  const record = invoiceStore.forUser(req.user.id).getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Receipt not found' });
  res.json({ token: issueImageToken(req.user.id, req.params.id) });
});

// GET /api/receipts/:id/image?token=... — no requireAuth; the token IS the auth
router.get('/:id/image', (req, res) => {
  let payload;
  try {
    payload = verifyImageToken(req.query.token, req.params.id);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired image token' });
  }

  const record = invoiceStore.forUser(payload.userId).getById(req.params.id);
  if (!record || !record.receiptFile) return res.status(404).json({ error: 'Receipt not found' });

  const filePath = receiptStore.forUser(payload.userId).getPath(record.receiptFile);
  if (!filePath) return res.status(404).json({ error: 'Receipt file is missing' });

  res.type(record.receiptMime || 'application/octet-stream');
  res.sendFile(filePath);
});

// DELETE /api/receipts/:id — removes the row and the file together
router.delete('/:id', requireAuth, (req, res) => {
  const store  = invoiceStore.forUser(req.user.id);
  const record = store.getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Receipt not found' });
  if (record.invoiceType !== 'EXPENSE') return res.status(400).json({ error: 'Not an expense claim' });

  store.remove(req.params.id);

  // Split siblings SHARE one stored file, so it may only be deleted once the
  // last record referencing it is gone. Removing it with the first would leave
  // the others pointing at nothing.
  if (record.receiptFile) {
    const stillUsed = store.getAll().some(r => r.receiptFile === record.receiptFile);
    if (!stillUsed) receiptStore.forUser(req.user.id).remove(record.receiptFile);
  }

  logger.info('Receipt deleted', { userId: req.user.id, id: req.params.id });
  res.json({ ok: true });
});

// GET /api/receipts/:id/group — the other records that came from the same
// upload, so the review screen can say "1 of 2" and offer to step between them.
router.get('/:id/group', requireAuth, (req, res) => {
  const store  = invoiceStore.forUser(req.user.id);
  const record = store.getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Receipt not found' });
  if (!record.receiptGroup) return res.json({ split: false, index: 1, total: 1, siblings: [] });

  const members = store.getAll()
    .filter(r => r.receiptGroup === record.receiptGroup)
    // Stable, human order: PDF pages by page, photo regions top-to-bottom.
    .sort((a, b) => (a.receiptPage || 0) - (b.receiptPage || 0) || String(a.id).localeCompare(String(b.id)));

  res.json({
    split: true,
    index: members.findIndex(r => r.id === record.id) + 1,
    total: members.length,
    siblings: members.map(r => ({ id: r.id, vendorName: r.vendorName, totalAmount: r.totalAmount, currency: r.currency, page: r.receiptPage })),
  });
});

// POST /api/receipts/:id/merge — undo a split.
//
// Deletes every sibling from the same upload except this one, and clears the
// region so the surviving record shows the whole original again. Possible only
// because the file was never cut up.
router.post('/:id/merge', requireAuth, (req, res) => {
  const store  = invoiceStore.forUser(req.user.id);
  const record = store.getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Receipt not found' });
  if (!record.receiptGroup) return res.status(400).json({ error: 'This receipt was not split' });

  const siblings = store.getAll().filter(r => r.receiptGroup === record.receiptGroup && r.id !== record.id);
  for (const sib of siblings) store.remove(sib.id);

  const merged = store.update(req.params.id, { receiptBox: null, receiptPage: null, receiptGroup: null });
  logger.info('Split merged back', { userId: req.user.id, id: req.params.id, removed: siblings.length });
  res.json({ receipt: merged, removed: siblings.length });
});

module.exports = router;
module.exports._decodeBase64 = decodeBase64;
