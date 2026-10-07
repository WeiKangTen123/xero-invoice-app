const fs   = require('fs');
const os   = require('os');
const path = require('path');
const sharp = require('sharp');
const thumbnailer = require('./thumbnailer');

// Matching what thumbnailer.js does in the application. libvips otherwise sizes
// its pool to the CPU count, and jest runs several workers at once — each with
// its own pool, which oversubscribes the machine enough to disturb timing
// assumptions in entirely unrelated suites.
sharp.concurrency(1);

// A receipt served at 76px should not be the 3MB file that was uploaded. These
// cover the parts that decide whether that happens, and the fallbacks — because
// every failure here is supposed to end in a heavier image, never a broken one.

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// Deliberately small. These only have to be wider than the 160px target for
// the resize paths to mean anything, and jest runs suites in parallel — a
// suite that saturates the CPU encoding large images slows every other one
// down enough to disturb tests that assume something finishes promptly.
async function writeJpeg(name, width = 240, height = 320) {
  const buf = await sharp({ create: { width, height, channels: 3, background: '#7a7a90' } })
    .jpeg({ quality: 90 }).toBuffer();
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

// A valid PNG of any size that costs next to nothing to build or hold: one
// bit per pixel and every pixel white, so 64 million pixels deflate to about
// 22KB. That is the shape of a decompression bomb: tiny on disk, enormous
// once decoded.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function flatPng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1;                                            // one bit per pixel, greyscale
  const row = Buffer.alloc(1 + Math.ceil(width / 8), 0xff); row[0] = 0;   // no filter, all white
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', require('zlib').deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('utils/thumbnailer — which requests are honoured', () => {
  test('only whitelisted widths, so one caller cannot fill the disk with variants', () => {
    expect(thumbnailer.allowedWidth(160)).toBe(160);
    expect(thumbnailer.allowedWidth('160')).toBe(160);
    expect(thumbnailer.allowedWidth(161)).toBeNull();
    expect(thumbnailer.allowedWidth('nonsense')).toBeNull();
    expect(thumbnailer.allowedWidth(999999)).toBeNull();
  });

  test('rasters only — a PDF receipt is not something this can scale', () => {
    expect(thumbnailer.isResizable('image/jpeg')).toBe(true);
    expect(thumbnailer.isResizable('image/png')).toBe(true);
    expect(thumbnailer.isResizable('application/pdf')).toBe(false);
    expect(thumbnailer.isResizable(undefined)).toBe(false);
  });

  test('derivatives are recognisable by name, which is how they get swept', () => {
    expect(thumbnailer.derivativeName('abc.jpg', 160)).toBe('abc.jpg.w160.jpg');
    expect(thumbnailer.isDerivative('abc.jpg.w160.jpg')).toBe(true);
    expect(thumbnailer.isDerivative('abc.jpg')).toBe(false);
  });
});

describe('utils/thumbnailer — generating', () => {
  test('produces a genuinely smaller file at the requested width', async () => {
    const src = await writeJpeg('r.jpg');
    const out = await thumbnailer.thumbnailPath(src, dir, 'r.jpg', 160, 'image/jpeg');

    expect(out).toBeTruthy();
    expect(fs.statSync(out).size).toBeLessThan(fs.statSync(src).size);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(160);
  });

  test('never enlarges — a receipt already smaller than the target is left alone', async () => {
    const src = await writeJpeg('small.jpg', 80, 100);
    const out = await thumbnailer.thumbnailPath(src, dir, 'small.jpg', 160, 'image/jpeg');
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(80);
  });

  test('a second request reuses the cached file rather than re-encoding', async () => {
    const src = await writeJpeg('r.jpg');
    const first = await thumbnailer.thumbnailPath(src, dir, 'r.jpg', 160, 'image/jpeg');
    const stampA = fs.statSync(first).mtimeMs;
    const second = await thumbnailer.thumbnailPath(src, dir, 'r.jpg', 160, 'image/jpeg');
    expect(second).toBe(first);
    expect(fs.statSync(second).mtimeMs).toBe(stampA);
  });

  test('a replaced original invalidates its thumbnail — a receipt can be rotated in place', async () => {
    const src = await writeJpeg('r.jpg');
    const out = await thumbnailer.thumbnailPath(src, dir, 'r.jpg', 160, 'image/jpeg');
    const before = fs.statSync(out).mtimeMs;

    // Rewrite the source with a later mtime, as a re-read or rotate would.
    const replaced = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#222' } })
      .jpeg().toBuffer();
    fs.writeFileSync(src, replaced);
    fs.utimesSync(src, new Date(), new Date(Date.now() + 2000));

    const after = await thumbnailer.thumbnailPath(src, dir, 'r.jpg', 160, 'image/jpeg');
    expect(fs.statSync(after).mtimeMs).not.toBe(before);
  });
});

describe('utils/thumbnailer — falling back rather than failing', () => {
  // Each of these returns null, and the route reads null as "send the original".
  test('an unsupported width is declined, not clamped to something arbitrary', async () => {
    const src = await writeJpeg('r.jpg');
    expect(await thumbnailer.thumbnailPath(src, dir, 'r.jpg', 137, 'image/jpeg')).toBeNull();
  });

  test('a PDF is declined', async () => {
    const p = path.join(dir, 'r.pdf');
    fs.writeFileSync(p, Buffer.from('%PDF-1.4 not really'));
    expect(await thumbnailer.thumbnailPath(p, dir, 'r.pdf', 160, 'application/pdf')).toBeNull();
  });

  test('a corrupt image is declined instead of throwing into the response', async () => {
    const p = path.join(dir, 'broken.jpg');
    fs.writeFileSync(p, Buffer.from('this is not a jpeg'));
    await expect(thumbnailer.thumbnailPath(p, dir, 'broken.jpg', 160, 'image/jpeg')).resolves.toBeNull();
  });

  test('an image declaring more pixels than the cap is declined without being decoded', async () => {
    const bomb = path.join(dir, 'bomb.png');
    fs.writeFileSync(bomb, flatPng(8000, 8000));            // 64 million pixels
    // A real, valid PNG: its header reads fine when nothing caps it.
    expect((await sharp(bomb).metadata()).width).toBe(8000);
    expect(await thumbnailer.thumbnailPath(bomb, dir, 'bomb.png', 160, 'image/png')).toBeNull();

    // Built the same way under the cap, it scales as normal, so what was
    // refused above is the size and not the file.
    const flat = path.join(dir, 'flat.png');
    fs.writeFileSync(flat, flatPng(400, 300));
    const out = await thumbnailer.thumbnailPath(flat, dir, 'flat.png', 160, 'image/png');
    expect((await sharp(out).metadata()).width).toBe(160);
  });

  test('a missing source is declined rather than throwing', async () => {
    const p = path.join(dir, 'gone.jpg');
    await expect(thumbnailer.thumbnailPath(p, dir, 'gone.jpg', 160, 'image/jpeg')).resolves.toBeNull();
  });
});
