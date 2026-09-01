const express      = require('express');
const router       = express.Router();
const jwt          = require('jsonwebtoken');
const { requireAuth, jwtSecret } = require('../middleware/auth-middleware');
const invoiceStore = require('../utils/invoice-store');
const receiptStore = require('../utils/receipt-store');
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

// POST /api/receipts  { mime, data, filename?, source? }
router.post('/', requireAuth, (req, res) => {
  try {
    const { mime, data, filename, source } = req.body || {};

    if (!receiptStore.isAcceptedMime(mime)) {
      return res.status(400).json({
        error: `Unsupported file type${mime ? ` (${mime})` : ''}. Accepted: ${receiptStore.acceptedMimes().join(', ')}.`,
      });
    }

    const buffer = decodeBase64(data);
    if (!buffer) return res.status(400).json({ error: 'File data is missing or not valid base64' });

    if (buffer.length > receiptStore.MAX_BYTES) {
      const mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`;
      return res.status(413).json({
        error: `Receipt is ${mb(buffer.length)}; Xero accepts at most ${mb(receiptStore.MAX_BYTES)}. Try a lower-resolution photo.`,
      });
    }

    const id = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
    // Store the file BEFORE the row. A failed write must not leave a record
    // pointing at an image that was never saved.
    const storedName = receiptStore.forUser(req.user.id).save(id, buffer, mime);

    const record = invoiceStore.forUser(req.user.id).add({
      id,
      status:      'review-needed',   // nothing is known until it is read or typed
      invoiceType: 'EXPENSE',
      source:      source === 'phone' ? 'phone' : 'upload',
      receiptFile: storedName,
      receiptMime: mime,
      description: filename ? String(filename).slice(0, 200) : null,
      processedAt: new Date().toISOString(),
    });

    logger.info('Receipt uploaded', { userId: req.user.id, id, bytes: buffer.length, mime, source: source || 'upload' });
    res.status(201).json({ receipt: record, imageToken: issueImageToken(req.user.id, id) });
  } catch (err) {
    logger.error('Receipt upload failed', { userId: req.user.id, error: err.message });
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

  if (record.receiptFile) receiptStore.forUser(req.user.id).remove(record.receiptFile);
  store.remove(req.params.id);
  logger.info('Receipt deleted', { userId: req.user.id, id: req.params.id });
  res.json({ ok: true });
});

module.exports = router;
module.exports._decodeBase64 = decodeBase64;
