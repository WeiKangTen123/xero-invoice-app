const fs   = require('fs');
const path = require('path');

// Per-user receipt files for expense claims, on disk beside the PDF store.
//
// Deliberately a sibling of pdf-store.js rather than a generalisation of it: a
// bill's PDF and an expense claim's receipt have different lifecycles, different
// accepted types, and reach Xero by different paths. Merging them would save a
// few lines and cost the ability to reason about either.
//
// Unlike pdf-store the extension varies, so the stored filename is returned by
// save() and recorded on the invoice row — callers must not reconstruct it.
const BASE_DIR = path.join(__dirname, '../data/users');
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

  function remove(filename) {
    const p = getPath(filename);
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

  const store = { save, getPath, read, exists, remove, clearAll, dir: DIR };
  _stores.set(userId, store);
  return store;
}

module.exports = { forUser, extensionFor, isAcceptedMime, acceptedMimes, MAX_BYTES, MIME_EXT };
