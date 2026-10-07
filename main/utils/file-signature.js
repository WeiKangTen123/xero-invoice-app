// What a file IS, read from its first bytes, rather than what it claims to be.
//
// An upload's MIME type is whatever the client declared, and an archive entry's
// is whatever its name says. Either can be wrong by accident (a PNG saved as
// .jpg) or on purpose (a script or an executable renamed receipt.jpg). Trusted,
// the second is written to disk, handed to the vision reader and later served
// back from this origin under an image type. The first few bytes of every format
// a receipt arrives in are fixed by its specification, so they are checked
// instead, and nothing that matches none of them is stored.
//
// WebP and HEIC are recognised although no receipt is stored in either: Xero
// does not accept them as attachments. Recognising them is what lets the
// refusal say "this is a HEIC photo" rather than "this is not an image", which
// would be untrue and no help to the person holding it.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ISO base-media brands (the four bytes after "ftyp") that mean a HEIF image.
// The hev* and hei* brands are HEVC-coded, which is what an iPhone writes and
// what is usually meant by HEIC; mif1/msf1 are the generic HEIF brands. AVIF
// shares the container but not these brands, so it is not matched.
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);

// How many leading bytes sniff() needs at most. A caller reading only the head
// of a file (an archive entry, say) reads at least this much.
const HEAD_BYTES = 16;

const LABELS = {
  'image/jpeg':      'JPEG',
  'image/png':       'PNG',
  'image/webp':      'WebP',
  'image/heic':      'HEIC',
  'image/heif':      'HEIF',
  'application/pdf': 'PDF',
};

// Returns the MIME type the bytes show, or null when they match nothing here.
function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return null;
  const b = buffer;
  const ascii = (start, end) => b.toString('latin1', start, end);

  // The start-of-image marker. Real files follow it with another marker, but
  // FF D8 is the part every JPEG has, and it is what file(1) itself checks.
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
  }
  // At the very start. Readers tolerate junk before it, but nothing that makes
  // a receipt PDF puts any there, and allowing it is how a file can be an HTML
  // page and a "PDF" at once.
  if (b.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

// "JPEG", "PNG", ... for a person; "JPEG, PNG or PDF" for a list of them.
function label(mime) { return LABELS[mime] || String(mime); }
function labelList(mimes) {
  const names = mimes.map(label);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : (names[0] || '');
}

// Decides whether these bytes may be stored as one of `accepted`.
//
// Returns { mime } with the type the CONTENT shows, or { error, found } with a
// sentence for a person and whatever sniff() made of the bytes (null for
// nothing). The content decides rather than the declared type: a real receipt
// whose name or label is merely wrong is stored under the type it actually is
// (and so served back with the right Content-Type), and only a file that is
// none of the accepted formats is refused.
function check(buffer, accepted) {
  const found = sniff(buffer);
  const wanted = labelList(accepted);
  if (!found) {
    return { found, error: `This file is not a ${wanted}: its contents match none of them, whatever its name or type says. Only receipt photos and PDFs can be added.` };
  }
  if (!accepted.includes(found)) {
    return { found, error: `This is a ${label(found)} image, which Xero does not accept as an attachment. Save it as a ${wanted} and try again.` };
  }
  return { mime: found };
}

module.exports = { sniff, check, label, labelList, HEAD_BYTES };
