const yauzl  = require('yauzl');
const logger = require('../utils/logger');

// Opens a .zip of receipt images in memory.
//
// Real claim archives are made on a Mac, so they carry a __MACOSX/ shadow tree
// of AppleDouble metadata files that mirror every real entry. Reading those as
// receipts would double the count and send junk to the model.
//
// Nothing is written to disk here — entries come back as buffers (readArchive)
// or as readers (openArchive) for the caller to store through receipt-store,
// which already enforces the type and size rules.

// Mirrors receipt-store's accepted types: anything else cannot become a Xero
// attachment, so there is no point extracting it.
const IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

// A claim archive of more than this is a mistake, not a claim. Each entry costs
// a vision call, so an unbounded archive is an unbounded bill.
const MAX_ENTRIES = 100;
const MAX_ENTRY_BYTES = 15 * 1024 * 1024;   // before compression to ≤3MB

// The upload itself is capped at a few MB, but that is the COMPRESSED size: a
// zip of a hundred 15MB files that deflate to almost nothing passes every other
// check and then unpacks to 1.5GB. The sizes are the ones each entry declares,
// which yauzl holds the stream to (validateEntrySizes), so a lying entry fails
// to read rather than slipping past this.
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const SIZE_LIMIT_REASON = 'archive size limit reached';

function mimeFor(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return IMAGE_EXT[ext] || null;
}

// macOS metadata, hidden files, and directory entries.
function isJunk(name) {
  return name.startsWith('__MACOSX/')
      || name.split('/').some(part => part.startsWith('._') || part === '.DS_Store')
      || name.endsWith('/');
}

function _readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err || new Error('could not be read'));
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

// Lists an archive WITHOUT extracting it. Returns
// { entries: [{ name, mime, size, read }], skipped: [...], error, totalBytes },
// where read() resolves to that entry's bytes each time it is called.
//
// Extracting everything up front meant a hundred 15MB photos were all held in
// memory together for the minutes an import takes to read them. Listing first
// lets the caller pull a batch at a time and let it go again. A zip opened
// from a buffer is never closed by yauzl, so read() still works after listing
// has finished.
//
// Never throws — a corrupt archive yields no entries and a reason, so an
// import can report it rather than dying.
function openArchive(buffer, { maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  return new Promise(resolve => {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      return resolve({ entries: [], skipped: [], error: 'empty archive', totalBytes: 0 });
    }

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        logger.warn('Claim archive could not be opened', { error: err && err.message });
        return resolve({ entries: [], skipped: [], error: 'not a readable zip', totalBytes: 0 });
      }

      const entries = [];
      const skipped = [];
      let totalBytes = 0;
      let overSize = false;

      zip.on('entry', entry => {
        const name = entry.fileName;

        if (isJunk(name)) return zip.readEntry();
        if (entries.length >= MAX_ENTRIES) { skipped.push({ name, reason: 'archive limit reached' }); return zip.readEntry(); }

        const mime = mimeFor(name);
        if (!mime) { skipped.push({ name, reason: 'not a receipt file type' }); return zip.readEntry(); }
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) { skipped.push({ name, reason: 'file too large' }); return zip.readEntry(); }
        if (totalBytes + entry.uncompressedSize > maxTotalBytes) {
          overSize = true;
          skipped.push({ name, reason: SIZE_LIMIT_REASON });
          return zip.readEntry();
        }

        totalBytes += entry.uncompressedSize;
        entries.push({ name, mime, size: entry.uncompressedSize, read: () => _readEntry(zip, entry) });
        zip.readEntry();
      });

      // An archive over the size cap is reported as an ERROR, not only as
      // skipped entries: importing the first 200MB and quietly leaving the
      // rest is the worst outcome available, and an error is what every caller
      // already stops on.
      const sizeError = () => (overSize
        ? `the archive unpacks to more than ${Math.round(maxTotalBytes / 1048576)}MB; split it into smaller archives`
        : null);
      zip.on('end',   () => resolve({ entries, skipped, error: sizeError(), totalBytes }));
      zip.on('error', e => resolve({ entries, skipped, error: e.message, totalBytes }));
      zip.readEntry();
    });
  });
}

// Returns { entries: [{ name, mime, buffer }], skipped: [...], error }, every
// entry extracted. For callers that want the bytes at once (bill intake); the
// size cap above is what keeps this bounded. Never throws.
async function readArchive(buffer, opts) {
  const listed = await openArchive(buffer, opts);
  const entries = [];
  const skipped = [...listed.skipped];
  for (const e of listed.entries) {
    try { entries.push({ name: e.name, mime: e.mime, buffer: await e.read() }); }
    catch (_) { skipped.push({ name: e.name, reason: 'could not be read' }); }
  }
  return { entries, skipped, error: listed.error };
}

module.exports = { readArchive, openArchive, mimeFor, isJunk, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, SIZE_LIMIT_REASON };
