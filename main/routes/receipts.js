const express      = require('express');
const { newId } = require('../utils/ids');
const router       = express.Router();
const { decodeBase64 } = require('../utils/base64');
const jwt          = require('jsonwebtoken');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const invoiceStore = require('../utils/invoice-store');
const receiptStore = require('../utils/receipt-store');
const pairing      = require('../utils/pairing');
const users        = require('../utils/users');
const { parseReceiptImage, parseReceiptText } = require('../utils/receipt-parser');
// Required as a module rather than destructured so the functions are looked up
// at call time — a destructured import captures the original reference and can
// never be substituted in a test.
const pdfPages = require('../utils/pdf-pages');
const thumbnailer = require('../utils/thumbnailer');
const { hashBuffer, findDuplicate } = require('../claims/claim-dedup');
const { newClaimRow, claimPatch, accountFor } = require('../claims/claim-record');
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


// Shared by the authenticated desktop upload and the paired phone upload, so
// the two cannot drift apart on validation, ordering or the state a new receipt
// lands in. Returns { status, body }.
// Background reads still running. Production never waits on these — the whole
// point is that an upload returns before the read finishes — but tests must,
// or they read the row before it has been filled in.
const _inflight = new Set();
// Receipt ids being read right now, so the catch-up after a restart and a
// fresh upload can never read the same receipt twice at once.
const _reading = new Set();

// Marks the read over on every row it produced (the upload and any page or
// region siblings), so the phone can tell "still reading" from "read, and
// nothing was found". Looked up by id and by group: this used to load every
// record the user had to find the one or two it wanted, once per upload.
function _stampParsed(userId, id, at = new Date().toISOString()) {
  const s = invoiceStore.forUser(userId);
  const seen = new Set();
  for (const r of [s.getById(id), ...s.getReceiptGroup(id)]) {
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    s.update(r.id, { parsedAt: at });
  }
}

// Reads a stored receipt off the response path. Returns a promise that
// settles when the read has ended, however it ended. An upload never waits on
// it; the restart catch-up below does, to read one receipt at a time.
//
// Tracked so a test can wait for it. Guessing at how many event-loop ticks
// the read takes (the old settle() helper) was wrong often enough that one
// describe block had grown to three nested setImmediates, and still flaked.
function _readInBackground(userId, id, buffer, mime, storedName, hash) {
  _reading.add(id);
  const done = new Promise(resolve => setImmediate(() => {
    readAndMaybeSplit(userId, id, buffer, mime, storedName, hash)
      .catch(err => logger.warn('Receipt read failed', { userId, id, error: err.message }))
      .finally(() => {
        // However it ended, the read is over. Guarded, because a throw here
        // would leave this promise unsettled and the receipt marked as being
        // read for the life of the process.
        try { _stampParsed(userId, id); }
        catch (err) { logger.warn('Receipt read could not be marked finished', { userId, id, error: err.message }); }
        _reading.delete(id);
        resolve();
      });
  }));
  _inflight.add(done);
  done.finally(() => _inflight.delete(done));
  return done;
}

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

  // Already here?
  //
  // The batch importer MARKS a duplicate and carries on, because nobody is
  // watching it and a silently dropped receipt is how the "imported 0 claims"
  // bug happened. A hand upload is the opposite: somebody is standing there, so
  // the useful answer is to say so and point at the one they already have,
  // rather than leave them a second row to tidy up. Same signal, different
  // response, because the audience is different.
  const hash = hashBuffer(buffer);
  const dup = findDuplicate({ store: invoiceStore.forUser(userId), hash });
  if (dup) {
    logger.info('Receipt already uploaded', { userId, existingId: dup.match.id, source: source || 'upload' });
    return { status: 409, body: {
      error: `You have already uploaded this receipt (matches ${dup.match.invoiceNumber || dup.match.id}).`,
      reason: dup.reason,
      duplicateOf: dup.match.id,
      receipt: dup.match,
    } };
  }

  const id = newId();
  // Store the file BEFORE the row. A failed write must not leave a record
  // pointing at an image that was never saved.
  const storedName = receiptStore.forUser(userId).save(id, buffer, mime);

  // Nothing is known until it is read or typed; the row starts at review-needed
  // with the user's defaults, and the read fills it in (claims/claim-record.js).
  const record = invoiceStore.forUser(userId).add(newClaimRow({
    userId, id, source: source === 'phone' ? 'phone' : 'upload',
    extras: {
      receiptFile: storedName,
      receiptMime: mime,
      receiptHash: hash,
      description: filename ? String(filename).slice(0, 200) : null,
    },
  }));

  logger.info('Receipt stored', { userId, id, bytes: buffer.length, mime, source: source || 'upload' });

  // Read the receipt AFTER it is safely stored, and off the response path.
  //
  // Two reasons it is not awaited. A phone on mobile data should not hold a
  // request open for the several seconds a vision call takes, and a batch of
  // five receipts would otherwise be five sequential waits. The row already
  // exists and is already visible; parsing only fills it in.
  //
  // Parsing is an enhancement, never a gate: if it fails the receipt stays
  // exactly where it is, at review-needed, for the user to type by hand. A
  // restart before it finishes is caught up on boot (resumeUnreadReceipts).
  _readInBackground(userId, id, buffer, mime, storedName, hash);

  return { status: 201, body: { receipt: record, imageToken: issueImageToken(userId, id) } };
}

// Once a receipt has been READ, there is a second thing to check: an upload that
// is not the same file can still be the same expense — a photo of a receipt
// already claimed from a scan, say, or the same taxi ride snapped twice.
//
// This one only ever leaves a NOTE. Vendor, date and amount agreeing is strong
// evidence but not proof, 'duplicate' is a locked status, and two identical
// coffees on one afternoon are unusual rather than impossible. The person
// holding the receipts decides; this just makes sure they are asked.
function _flagIfSuspected(userId, id) {
  const store = invoiceStore.forUser(userId);
  const rec = store.getById(id);
  if (!rec || rec.status === 'duplicate') return;

  const dup = findDuplicate({
    store, vendorName: rec.vendorName, date: rec.invoiceDate, amount: rec.totalAmount,
    excludeId: id,
  });
  if (!dup) return;

  logger.info('Possible duplicate receipt', { userId, id, of: dup.match.id });
  // A note the read already left (a page with no text, a page cap) is kept
  // after this one. Overwriting it would drop the only mention of a page.
  const prior = rec.errorMsg && !/duplicate/i.test(rec.errorMsg) ? rec.errorMsg.replace(/^Please check:\s*/i, '') : null;
  store.update(id, {
    duplicateOf: dup.match.id,
    errorMsg: `Possible duplicate of ${dup.match.id}${dup.match.invoiceNumber ? ` (${dup.match.invoiceNumber})` : ''} — ${dup.reason}. Check before approving.${prior ? ` Also: ${prior}` : ''}`,
  });
}

// Applies one receipt's fields to a record.
//
// The account follows what the receipt was for. Every claim used to land on
// the user's one default account, so snacks and airfares shared a line; the
// reader already names a category and the org's chart of accounts already
// names its accounts, so the two are matched. No match keeps the default.
async function _applyFields(userId, id, r, extra = {}) {
  const accountCode = (await accountFor(userId, null, r)) || undefined;
  invoiceStore.forUser(userId).update(id, claimPatch(r, { accountCode, ...extra }));
}

// "Please check: ..." is the prefix the review screen strips before showing a
// note under "Attention Needed", the same convention the bill parser uses.
function _note(userId, id, notes) {
  if (!notes.length) return;
  invoiceStore.forUser(userId).update(id, { errorMsg: `Please check: ${notes.join('; ')}.` });
}

const _pageList = pages => (pages.length === 1
  ? `page ${pages[0]}`
  : `pages ${pages.slice(0, -1).join(', ')} and ${pages[pages.length - 1]}`);

// A PDF becomes one record unless its pages are plainly separate receipts.
//
// Splitting used to follow the page count: any two pages with text became two
// claims, so a two-page hotel folio was two half-stays; a scanned page between
// two text pages vanished without a row or a word; and every page of a long
// PDF was a model call of its own, with no limit on pages. Now:
//   * pdf-pages decides from what is printed (a total and a date of their own
//     on each page, no page numbering or shared folio number) and caps the
//     read at 30 pages
//   * when the text cannot decide, the single whole-document read that a
//     one-record PDF needs anyway is also asked how many receipts it saw; one
//     per page, each traceable by its total, splits with no further call
//   * a page with no text is a flagged row among separate receipts, and a
//     note on the record otherwise
async function _readPdf(userId, id, buffer, mime, storedName, hash) {
  const store = invoiceStore.forUser(userId);
  const extracted = await pdfPages.extractPages(buffer);
  const notes = [];
  // Pages past the cap were never read. Saying so is the difference between a
  // long PDF and a claim quietly missing its second half.
  if (extracted.truncated) notes.push(`only the first ${extracted.pages.length} of ${extracted.numPages} pages were read; check the rest of the PDF by hand`);

  if (!extracted.hasText) {
    // A scan: every page is an image and there is no renderer to draw one
    // for the vision reader. The record stays as uploaded, typeable by hand.
    _note(userId, id, [...notes, 'this PDF has no text layer (it is a scan), so nothing could be read from it; type the figures in']);
    logger.info('PDF has no text layer; left for the user', { userId, id });
    return;
  }

  const decision = pdfPages.splittablePages(extracted);
  let targets;   // [{ page, receipt? }], once the PDF is known to hold separate receipts
  if (decision.split) {
    targets = decision.pageNumbers.map(page => ({ page }));
  } else {
    const parsed = await parseReceiptText(userId, extracted.pages.join('\n\n'));
    const found = (parsed && parsed.receipts) || [];
    const attributed = decision.oneDocument ? null : pdfPages.attributeToPages(found, extracted.pages, decision.pageNumbers);
    if (!attributed) {
      if (found.length) await _applyFields(userId, id, found[0]);
      const blank = decision.blankPages;
      if (blank.length) {
        notes.push(`${_pageList(blank)} of this PDF ${blank.length === 1 ? 'has' : 'have'} no readable text (a scan?); check nothing on ${blank.length === 1 ? 'it' : 'them'} is missing from this claim`);
      }
      if (found.length > 1) {
        notes.push(`the reader saw ${found.length} receipts in this PDF but could not tell which page each is on, so only the first was used; check the figures`);
      }
      _note(userId, id, notes);
      if (found.length) _flagIfSuspected(userId, id);
      logger.info('PDF read as one receipt', { userId, id, read: !!parsed, found: found.length, reason: decision.reason });
      return;
    }
    targets = attributed;
  }

  // Separate receipts: one record per page, all pointing at the same file.
  // A sibling is a complete claim of the same source as the upload, with the
  // same bytes, so the same hash.
  const group  = id;
  const parent = store.getById(id);
  const sibling = (page, extras = {}) => store.add(newClaimRow({ userId, source: parent.source, groupId: group, extras: {
    receiptFile: storedName, receiptMime: mime, receiptHash: hash, receiptPage: page, ...extras,
  } }));

  const [first, ...rest] = targets;
  store.update(id, { receiptPage: first.page, receiptGroup: group });
  _note(userId, id, notes);
  const rows = [{ rowId: id, ...first }];
  for (const t of rest) rows.push({ rowId: sibling(t.page).id, ...t });
  // A page with no text among separate receipts is most likely a receipt that
  // was scanned rather than saved. It gets a row of its own, flagged, so it is
  // either claimed or deliberately deleted.
  for (const page of decision.blankPages) {
    sibling(page, { errorMsg: `Please check: page ${page} of this PDF has no readable text, so it may be a scanned receipt. Type its figures in, or delete this row if the page is blank.` });
  }

  for (const t of rows) {
    // Figures the whole-document read already traced to this page are used
    // as they are; otherwise the page is read from its own text.
    const r = t.receipt || (((await parseReceiptText(userId, extracted.pages[t.page - 1])) || {}).receipts || [])[0];
    if (r) { await _applyFields(userId, t.rowId, r); _flagIfSuspected(userId, t.rowId); }
  }
  logger.info('PDF split by page', { userId, id, receipts: rows.length, blankPages: decision.blankPages.length, byReader: !decision.split });
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
// splittablePages() (or, for a PDF, attributeToPages()) says the evidence is
// clean. Anything doubtful stays as one record holding the whole upload,
// because inventing a second receipt is worse than failing to split a real one.
async function readAndMaybeSplit(userId, id, buffer, mime, storedName, hash = null) {
  const store = invoiceStore.forUser(userId);

  if (mime === 'application/pdf') return _readPdf(userId, id, buffer, mime, storedName, hash);

  // ── Image: one record per detected receipt ────────────────────────────────
  const parsed = await parseReceiptImage(userId, buffer, mime);
  if (!parsed) return;                       // unreadable — the record survives as-is

  const { receipts, split, reason } = parsed;

  if (!split) {
    // One receipt, or evidence too weak to split on. Either way the whole image
    // stays on one record.
    await _applyFields(userId, id, receipts[0]);
    _flagIfSuspected(userId, id);
    logger.info('Receipt read', { userId, id, receipts: receipts.length, split: false, reason });
    return;
  }

  const group  = id;
  const parent = store.getById(id);
  const [first, ...rest] = receipts;
  await _applyFields(userId, id, first, { receiptBox: JSON.stringify(first.box), receiptGroup: group });
  _flagIfSuspected(userId, id);
  for (const r of rest) {
    // A sibling is a complete claim of the same source as the upload,
    // pointing at the SAME file — the same bytes, so the same hash.
    const sib = store.add(newClaimRow({ userId, source: parent.source, groupId: group, extras: {
      receiptFile: storedName, receiptMime: mime, receiptHash: hash, receiptBox: JSON.stringify(r.box),
    } }));
    await _applyFields(userId, sib.id, r);
    _flagIfSuspected(userId, sib.id);
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
router.post('/pair', requireAuth, asyncHandler(async (req, res) => {
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
}));

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
        // parsed: the automatic read has ENDED, whatever it found. unreadable:
        // it ended and found nothing, so the phone says so instead of spinning.
        parsed:     !!r.parsedAt,
        unreadable: !!r.parsedAt && !r.vendorName && !r.totalAmount,
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
router.get('/:id/image', asyncHandler(async (req, res) => {
  let payload;
  try {
    payload = verifyImageToken(req.query.token, req.params.id);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired image token' });
  }

  const record = invoiceStore.forUser(payload.userId).getById(req.params.id);
  if (!record || !record.receiptFile) return res.status(404).json({ error: 'Receipt not found' });

  const store    = receiptStore.forUser(payload.userId);
  const filePath = store.getPath(record.receiptFile);
  if (!filePath) return res.status(404).json({ error: 'Receipt file is missing' });

  // ?w= asks for a scaled copy. Callers that render small — the pairing modal's
  // 76px tiles — ask for one; the review screen does not, because it draws the
  // photo to a canvas and crops it by pixel box, which needs the original.
  //
  // Anything that cannot be scaled (a PDF, an unknown width, an image library
  // that failed to load) falls through to the original rather than erroring. A
  // heavier image is a far better outcome than a broken one.
  if (req.query.w) {
    const thumb = await thumbnailer.thumbnailPath(
      filePath, store.dir, record.receiptFile, req.query.w, record.receiptMime,
    );
    if (thumb) {
      res.type('image/jpeg');
      // Derived from an immutable original at a fixed width, and the URL is
      // already scoped by a short-lived token, so it is private to this viewer.
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.sendFile(thumb);
    }
  }

  res.type(record.receiptMime || 'application/octet-stream');
  res.sendFile(filePath);
}));

// POST /api/receipts/:id/reread — ask the model to look at the photo again.
//
// Without this, a receipt that failed to read was stuck forever: Gemini being
// down, over quota, or simply having a bad moment meant typing every field by
// hand, with no way to retry even on a perfectly legible photo.
//
// This re-reads and UPDATES FIELDS ONLY — it never splits. A re-read that
// decided the photo held two receipts would create siblings alongside any that
// already exist, and duplicate records are worse than an unsplit one. Splitting
// stays a decision made once, at upload.
//
// Costs one Gemini call and NO Xero call. Nothing here writes to Xero.
// A photo goes back to the vision reader. A PDF is read from its text again —
// only the page this record owns when it is one page of a split file.
async function _rereadFrom(userId, record, buffer) {
  if (record.receiptMime !== 'application/pdf') return parseReceiptImage(userId, buffer, record.receiptMime);
  const extracted = await pdfPages.extractPages(buffer);
  if (!extracted.hasText) return null;
  const text = record.receiptPage ? extracted.pages[record.receiptPage - 1] : extracted.pages.join('\n\n');
  return parseReceiptText(userId, text);
}

router.post('/:id/reread', requireAuth, asyncHandler(async (req, res) => {
  const store  = invoiceStore.forUser(req.user.id);
  const record = store.getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Receipt not found' });
  if (!record.receiptFile) return res.status(400).json({ error: 'This record has no receipt file to read' });

  const buffer = receiptStore.forUser(req.user.id).read(record.receiptFile);
  if (!buffer) return res.status(404).json({ error: 'The receipt file is missing from storage' });

  try {
    const parsed = await _rereadFrom(req.user.id, record, buffer);
    if (!parsed || !parsed.receipts?.length) {
      // Honest failure: the record is untouched and still typeable by hand.
      return res.json({ ok: false, reason: 'unreadable', receipt: record });
    }

    // The region this record owns, if it is one of several from a single photo.
    // Re-reading a split sibling must describe ITS receipt, not the first one
    // the model happens to see in the frame.
    let chosen = parsed.receipts[0];
    if (record.receiptBox && parsed.receipts.length > 1) {
      let box = null;
      try { box = JSON.parse(record.receiptBox); } catch { box = null; }
      if (box) {
        const centre = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
        const [cy, cx] = centre(box);
        const withBox = parsed.receipts.filter(r => r.box);
        if (withBox.length) {
          chosen = withBox.reduce((best, r) => {
            const [ry, rx] = centre(r.box);
            const d = Math.hypot(ry - cy, rx - cx);
            return d < best.d ? { r, d } : best;
          }, { r: withBox[0], d: Infinity }).r;
        }
      }
    }

    // The same patch a first read applies — including the account, which a
    // re-read that finally makes out a category used to leave unchanged.
    // From the chart of the company this claim goes to (or went to): a claim
    // already sent keeps its company, others follow the default.
    const accountCode = (await accountFor(req.user.id, null, chosen,
      record.xeroTenantId ? { tenantId: record.xeroTenantId } : {})) || undefined;
    const updated = store.update(req.params.id, claimPatch(chosen, { accountCode }));

    logger.info('Receipt re-read', { userId: req.user.id, id: req.params.id, confidence: chosen.confidence, found: parsed.receipts.length });
    res.json({ ok: true, receipt: updated, confidence: chosen.confidence, found: parsed.receipts.length });
  } catch (err) {
    logger.warn('Receipt re-read failed', { userId: req.user.id, id: req.params.id, error: err.message });
    res.json({ ok: false, reason: 'unavailable', receipt: record });
  }
}));

// GET /api/receipts/:id/group — the other records that came from the same
// upload, so the review screen can say "1 of 2" and offer to step between them.
// groupType distinguishes:
//   'batch'  — a folder/zip claim import (source === 'claim'). No merge allowed.
//   'split'  — a single photo or PDF that was automatically split into regions/pages.
router.get('/:id/group', requireAuth, (req, res) => {
  const store  = invoiceStore.forUser(req.user.id);
  const record = store.getById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Receipt not found' });
  if (!record.receiptGroup) return res.json({ split: false, index: 1, total: 1, siblings: [] });

  const members = store.getReceiptGroup(record.receiptGroup)
    // Stable, human order: PDF pages by page, photo regions top-to-bottom.
    .sort((a, b) => (a.receiptPage || 0) - (b.receiptPage || 0) || String(a.id).localeCompare(String(b.id)));

  // A batch import is one where the receipts came from a claim folder/zip
  // (source === 'claim'). An actual split has receiptBox or receiptPage set.
  const isBatch = members.every(r => r.source === 'claim');
  // Use the original filename / zip name stored on the first sibling, falling
  // back to the group ID when none is available.
  const batchLabel = isBatch
    ? (members[0]?.claimBatch || members[0]?.receiptGroup || 'Batch Import')
    : null;

  res.json({
    split: true,
    groupType: isBatch ? 'batch' : 'split',
    batchLabel,
    index: members.findIndex(r => r.id === record.id) + 1,
    total: members.length,
    siblings: members.map(r => ({
      id: r.id,
      vendorName: r.vendorName,
      totalAmount: r.totalAmount,
      currency: r.currency,
      page: r.receiptPage,
      status: r.status,
    })),
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

  const members  = store.getReceiptGroup(record.receiptGroup);
  const siblings = members.filter(r => r.id !== record.id);
  // A folder or zip import is not a split: merging it would delete every other
  // claim in the import (see the groupType note on GET /:id/group).
  if (members.every(r => r.source === 'claim')) {
    return res.status(400).json({ error: 'This is a claim import, not a split receipt. Delete individual claims instead.' });
  }
  // A part already in Xero cannot be deleted locally without losing its Xero ID.
  if (siblings.some(r => r.xeroInvoiceId || r.status === 'submitting')) {
    return res.status(409).json({ error: 'Part of this receipt was already sent to Xero, so it cannot be merged back.' });
  }
  for (const sib of siblings) store.remove(sib.id);

  const merged = store.update(req.params.id, { receiptBox: null, receiptPage: null, receiptGroup: null });
  logger.info('Split merged back', { userId: req.user.id, id: req.params.id, removed: siblings.length });
  res.json({ receipt: merged, removed: siblings.length });
});

// ── Reads cut off by a restart ───────────────────────────────────────────────
// A background read lives only in this process. A restart in the seconds
// between an upload and the end of its read (and every deploy is a restart)
// left the row unread for good: parsedAt never set, the phone showing
// "Reading..." forever, the fields blank until somebody typed them.
//
// So on boot, every uploaded receipt that was never marked read is read again,
// or, where reading it now would do harm, only marked finished:
//   * someone has typed figures into it, and a late read would overwrite them
//   * it already has split siblings: the read got that far, and reading again
//     would split it a second time
//   * it is older than RESUME_MAX_AGE_MS: nobody is waiting on it, and a
//     backlog of old rows must not become a burst of model calls at boot
//   * its file is gone
// Each of those still has "Read again", which never splits.
//
// main/index.js calls this once the server is listening. Accounts run side by
// side; within one, reads go one at a time, and gemini-client keeps them
// inside the quota.
const RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function _resumeAccount(userId, now, out) {
  const store = invoiceStore.forUser(userId);
  // getFlagged rather than getAll: an unread receipt is always still waiting
  // for review, so only rows that could qualify are loaded.
  const unread = store.getFlagged().filter(r =>
    r.status === 'review-needed' && r.invoiceType === 'EXPENSE' &&
    (r.source === 'upload' || r.source === 'phone') && r.receiptFile && !r.parsedAt);

  for (const r of unread.filter(x => !x.receiptGroup || x.receiptGroup === x.id)) {
    if (_reading.has(r.id)) continue;
    const fresh = now - Date.parse(r.receivedAt || r.processedAt || '') <= RESUME_MAX_AGE_MS;
    // "Nothing on it yet" the way the phone status reads it: the store hands an
    // empty amount back as 0, not null.
    const untouched = !r.vendorName && !r.totalAmount
      && store.getReceiptGroup(r.id).every(x => x.id === r.id);
    const buffer = fresh && untouched ? receiptStore.forUser(userId).read(r.receiptFile) : null;
    if (!buffer) { _stampParsed(userId, r.id); out.closed++; continue; }
    out.queued++;
    await _readInBackground(userId, r.id, buffer, r.receiptMime, r.receiptFile, r.receiptHash || null);
  }

  // A sibling whose upload was marked finished without it: the restart came
  // between the two stamps.
  for (const r of unread.filter(x => x.receiptGroup && x.receiptGroup !== x.id)) {
    if (_reading.has(r.receiptGroup)) continue;
    const current = store.getById(r.id);
    if (current && !current.parsedAt) { store.update(r.id, { parsedAt: new Date().toISOString() }); out.closed++; }
  }
}

async function resumeUnreadReceipts({ now = Date.now() } = {}) {
  const out = { queued: 0, closed: 0 };
  let accounts;
  try { accounts = users.getAllUsers(); }
  catch (err) { logger.error('Unread receipt recovery could not list accounts', { error: err.message }); return out; }

  await Promise.all(accounts.map(async user => {
    const userId = String(user.id);
    // Nothing is read for a disabled account, since a read spends its model
    // quota. Its rows wait, unread, for if it is enabled again.
    let active = true;
    try { active = users.isActive(userId); } catch (_) { active = true; }
    if (!active) return;
    try { await _resumeAccount(userId, now, out); }
    catch (err) { logger.warn('Unread receipt recovery failed for an account', { userId, error: err.message }); }
  }));

  if (out.queued || out.closed) logger.info('Unread receipts recovered after a restart', out);
  return out;
}

module.exports = router;
module.exports._decodeBase64 = decodeBase64;
module.exports.resumeUnreadReceipts = resumeUnreadReceipts;
module.exports.RESUME_MAX_AGE_MS = RESUME_MAX_AGE_MS;
// Resolves once every background read started so far has finished, however it
// finished. Reads started while draining are waited for too.
module.exports._drain = async function _drain() {
  while (_inflight.size) await Promise.allSettled([..._inflight]);
};
