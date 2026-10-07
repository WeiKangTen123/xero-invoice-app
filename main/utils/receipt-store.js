const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

// Per-user receipt files for expense claims, on disk beside the PDF store.
//
// Deliberately a sibling of pdf-store.js rather than a generalisation of it: a
// bill's PDF and an expense claim's receipt have different lifecycles, different
// accepted types, and reach Xero by different paths. Merging them would save a
// few lines and cost the ability to reason about either.
//
// Unlike pdf-store the extension varies, so the stored filename is returned by
// save() and recorded on the invoice row — callers must not reconstruct it.
const BASE_DIR = require('./paths').usersDir();
const _stores  = new Map();

// What Xero's Files API accepts, which is the real constraint — storing a type
// Xero will later reject just moves the failure somewhere less useful.
const MIME_EXT = {
  'image/jpeg':      'jpg',
  'image/png':       'png',
  'application/pdf': 'pdf',
};

// Xero rejects attachments above 3MB. Enforced here as well as at the route so
// nothing can write an unattachable file to disk by taking another path in.
const MAX_BYTES = 3 * 1024 * 1024;

// sharp is loaded lazily, as in thumbnailer.js: requiring this module happens at
// boot, and a missing image library must cost the ability to shrink a large
// photo, never the ability to store an ordinary one.
let _sharp;
let _sharpFailed = false;
function _imageLib() {
  if (_sharpFailed) return null;
  if (!_sharp) {
    try {
      _sharp = require('sharp');
      // One thread: shrinking a receipt is not worth taking the box's second
      // core away from the requests it is also serving.
      if (typeof _sharp.concurrency === 'function') _sharp.concurrency(1);
    } catch (err) {
      _sharpFailed = true;
      logger.warn('sharp unavailable — oversized receipt photos cannot be shrunk', { error: err.message });
      return null;
    }
  }
  return _sharp;
}

// Tried in order, gentlest first. A phone photo of a receipt is legible long
// before 1800px on its longer edge, so the last step still reads; anything a
// step this small cannot bring under the limit is not a receipt photo worth
// degrading further.
const SHRINK_STEPS = [
  { edge: 4000, quality: 85 },
  { edge: 3000, quality: 80 },
  { edge: 2400, quality: 75 },
  { edge: 1800, quality: 70 },
];

const _mb = n => `${(n / 1024 / 1024).toFixed(1)}MB`;

// Brings a receipt under Xero's attachment limit where that can be done, and
// says plainly why when it cannot.
//
// The upload route never needs this: the browser compresses before sending.
// A zip or folder import does, because the files in it are whatever the
// camera wrote, and save() refusing a 6MB photo used to lose the receipt with
// only a log line to show for it. Returns { buffer, mime, shrunk, reason }:
// `reason` is null when the result fits, and a sentence for a person when it
// does not, in which case the original buffer comes back untouched.
async function fitToLimit(buffer, mime, { maxBytes = MAX_BYTES } = {}) {
  const type = String(mime || '').toLowerCase();
  if (!Buffer.isBuffer(buffer) || buffer.length <= maxBytes) return { buffer, mime, shrunk: false, reason: null };

  const over = `is ${_mb(buffer.length)}, over Xero's ${_mb(maxBytes)} attachment limit`;
  // A PDF cannot be re-encoded without a renderer, and quietly dropping its
  // pages to make it fit would be worse than not attaching it.
  if (type === 'application/pdf') return { buffer, mime, shrunk: false, reason: `the PDF ${over}, and a PDF cannot be made smaller here` };
  if (type !== 'image/jpeg' && type !== 'image/png') return { buffer, mime, shrunk: false, reason: `the file ${over}` };

  const lib = _imageLib();
  if (!lib) return { buffer, mime, shrunk: false, reason: `the photo ${over}, and no image library is available to shrink it` };

  for (const step of SHRINK_STEPS) {
    let out;
    try {
      out = await lib(buffer)
        .rotate()                                  // honour the EXIF orientation a phone camera writes
        .resize({ width: step.edge, height: step.edge, fit: 'inside', withoutEnlargement: true })
        // JPEG has no transparency; without this a transparent PNG
        // screenshot comes out on black, which hides black text.
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: step.quality, mozjpeg: true })
        .toBuffer();
    } catch (err) {
      logger.warn('Receipt photo could not be shrunk', { bytes: buffer.length, mime: type, error: err.message });
      return { buffer, mime, shrunk: false, reason: `the photo ${over}, and it could not be decoded to shrink it` };
    }
    // Always JPEG once re-encoded: a photographed receipt as PNG is several
    // times the size for nothing anyone can see.
    if (Buffer.isBuffer(out) && out.length > 0 && out.length <= maxBytes) {
      return { buffer: out, mime: 'image/jpeg', shrunk: true, reason: null };
    }
  }
  return { buffer, mime, shrunk: false, reason: `the photo ${over}, and could not be shrunk below it without becoming unreadable` };
}

function extensionFor(mime) { return MIME_EXT[String(mime || '').toLowerCase()] || null; }
function isAcceptedMime(mime) { return extensionFor(mime) !== null; }
function acceptedMimes() { return Object.keys(MIME_EXT); }

function forUser(userId) {
  if (_stores.has(userId)) return _stores.get(userId);

  const DIR = path.join(BASE_DIR, String(userId), 'receipts');
  function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

  // Returns the stored filename, which the caller persists on the invoice row.
  function save(id, buffer, mime) {
    const ext = extensionFor(mime);
    if (!ext) throw new Error(`Unsupported receipt type: ${mime}`);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Receipt file is empty');
    if (buffer.length > MAX_BYTES) throw new Error(`Receipt is ${buffer.length} bytes; the limit is ${MAX_BYTES}`);

    ensureDir();
    const filename = `${id}.${ext}`;
    fs.writeFileSync(path.join(DIR, filename), buffer);
    return filename;
  }

  // Null rather than a throw when absent: a missing file is a normal state (the
  // row can outlive the image), and callers render a placeholder for it.
  function getPath(filename) {
    if (!filename || String(filename).includes('/') || String(filename).includes('..')) return null;
    const p = path.join(DIR, filename);
    return fs.existsSync(p) ? p : null;
  }

  function read(filename) {
    const p = getPath(filename);
    return p ? fs.readFileSync(p) : null;
  }

  function exists(filename) { return getPath(filename) !== null; }

  // Cached thumbnails sit beside the original as "<filename>.w<width>.jpg", so
  // they are swept by prefix here rather than tracked in an index that could
  // drift out of step with the files themselves.
  function removeDerivatives(filename) {
    if (!filename) return 0;
    let n = 0;
    try {
      for (const f of fs.readdirSync(DIR)) {
        if (f.startsWith(`${filename}.w`) && f.endsWith('.jpg')) {
          try { fs.unlinkSync(path.join(DIR, f)); n++; } catch (_) { /* already gone */ }
        }
      }
    } catch (_) { /* no directory yet */ }
    return n;
  }

  function remove(filename) {
    const p = getPath(filename);
    // Swept whether or not the original is still present, so a receipt that was
    // half-deleted earlier cannot leave thumbnails behind for good.
    removeDerivatives(filename);
    if (!p) return false;
    fs.unlinkSync(p);
    return true;
  }

  function clearAll() {
    ensureDir();
    for (const f of fs.readdirSync(DIR)) {
      try { fs.unlinkSync(path.join(DIR, f)); } catch {}
    }
  }

  const store = { save, getPath, read, exists, remove, removeDerivatives, clearAll, dir: DIR };
  _stores.set(userId, store);
  return store;
}

module.exports = { forUser, extensionFor, isAcceptedMime, acceptedMimes, fitToLimit, MAX_BYTES, MIME_EXT, SHRINK_STEPS };
