const zlib = require('zlib');
const { readArchive, openArchive, mimeFor, isJunk, MAX_TOTAL_BYTES } = require('./claim-archive');

// Builds a real .zip in memory, STORED (uncompressed), so these tests need no
// zip-writing dependency. The format is simple enough to emit by hand and it
// keeps the fixtures honest — yauzl parses these exactly as it parses a Mac one.
function makeZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = zlib.crc32 ? zlib.crc32(body) : require('crypto').createHash('md5').digest().readUInt32LE(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(body.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

describe('claims/claim-archive', () => {
  test('extracts the receipt images', async () => {
    const zip = makeZip([
      { name: 'claims/a.png', data: PNG },
      { name: 'claims/b.jpg', data: JPEG },
    ]);
    const r = await readArchive(zip);
    expect(r.entries.map(e => e.name)).toEqual(['claims/a.png', 'claims/b.jpg']);
    expect(r.entries[0].mime).toBe('image/png');
    expect(r.entries[1].mime).toBe('image/jpeg');
    expect(r.error).toBeNull();
  });

  test('filters the macOS shadow tree, which would otherwise double the count', async () => {
    // A zip made on a Mac mirrors every file under __MACOSX with a ._ twin.
    // Treating those as receipts would double the vision calls and the bill.
    const zip = makeZip([
      { name: 'claims/receipt.png', data: JPEG },
      { name: '__MACOSX/claims/._receipt.png', data: Buffer.from('metadata') },
      { name: 'claims/.DS_Store', data: Buffer.from('junk') },
    ]);
    const r = await readArchive(zip);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].name).toBe('claims/receipt.png');
  });

  test('skips files that could never become a Xero attachment, and says why', async () => {
    const zip = makeZip([
      { name: 'claims/receipt.png', data: JPEG },
      { name: 'claims/notes.txt', data: Buffer.from('hello') },
      { name: 'claims/sheet.xlsx', data: Buffer.from('x') },
    ]);
    const r = await readArchive(zip);
    expect(r.entries).toHaveLength(1);
    expect(r.skipped.map(s => s.name)).toEqual(['claims/notes.txt', 'claims/sheet.xlsx']);
    expect(r.skipped[0].reason).toMatch(/not a receipt file type/);
  });

  test('PDF receipts are extracted too', async () => {
    const r = await readArchive(makeZip([{ name: 'c/r.pdf', data: Buffer.from('%PDF-1.4') }]));
    expect(r.entries[0].mime).toBe('application/pdf');
  });

  test('a corrupt or empty archive yields no entries rather than throwing', async () => {
    expect((await readArchive(Buffer.from('not a zip at all'))).entries).toEqual([]);
    expect((await readArchive(Buffer.alloc(0))).error).toBe('empty archive');
    expect((await readArchive(null)).entries).toEqual([]);
  });

  test('directory entries are not mistaken for files', async () => {
    const r = await readArchive(makeZip([
      { name: 'claims/', data: Buffer.alloc(0) },
      { name: 'claims/r.png', data: JPEG },
    ]));
    expect(r.entries).toHaveLength(1);
  });

  // The name only says what an entry claims to be. A script or a program
  // renamed receipt.jpg used to be stored, sent to the model and served back
  // from this origin as an image.
  describe('what an entry really is', () => {
    const EXE  = Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0x00, 0x03, 0x00]), Buffer.alloc(58)]);
    const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(12)]);

    test('a renamed text file or program is left out, and the summary says why', async () => {
      const zip = makeZip([
        { name: 'c/real.jpg', data: JPEG },
        { name: 'c/notes.jpg', data: Buffer.from('dinner with client, SGD 80') },
        { name: 'c/setup.pdf', data: EXE },
      ]);
      for (const r of [await openArchive(zip), await readArchive(zip)]) {
        expect(r.entries.map(e => e.name)).toEqual(['c/real.jpg']);
        expect(r.skipped.map(x => x.name)).toEqual(['c/notes.jpg', 'c/setup.pdf']);
        for (const x of r.skipped) expect(x.reason).toBe('its contents are not a JPEG, PNG or PDF, whatever its name says');
        expect(r.error).toBeNull();
      }
    });

    test('a HEIC photo renamed .jpg is named, not called "not an image"', async () => {
      const r = await openArchive(makeZip([{ name: 'c/IMG_0001.jpg', data: HEIC }]));
      expect(r.entries).toEqual([]);
      expect(r.skipped[0].reason).toBe('it is a HEIC image, which Xero does not accept');
    });

    test('a real receipt under the wrong extension is kept, as the type it is', async () => {
      const r = await openArchive(makeZip([
        { name: 'c/screenshot.jpg', data: PNG },
        { name: 'c/photo.png', data: JPEG },
      ]));
      expect(r.entries.map(e => [e.name, e.mime])).toEqual([['c/screenshot.jpg', 'image/png'], ['c/photo.png', 'image/jpeg']]);
      expect(r.skipped).toEqual([]);
    });

    test('an empty file is left out rather than stored', async () => {
      const r = await openArchive(makeZip([{ name: 'c/blank.jpg', data: Buffer.alloc(0) }]));
      expect(r.entries).toEqual([]);
      expect(r.skipped[0].reason).toMatch(/not a JPEG, PNG or PDF/);
    });

    test('a file left out does not count towards the size cap', async () => {
      const junk = Buffer.alloc(64, 0x41);
      const r = await openArchive(makeZip([{ name: 'c/a.jpg', data: junk }, { name: 'c/b.jpg', data: JPEG }]),
        { maxTotalBytes: JPEG.length });
      expect(r.entries.map(e => e.name)).toEqual(['c/b.jpg']);
      expect(r.totalBytes).toBe(JPEG.length);
      expect(r.error).toBeNull();
    });

    test('compressed entries are checked from their first bytes, and still read in full afterwards', async () => {
      // Real archives deflate their entries; only the head is inflated to check one.
      const JSZip = require('jszip');
      const big = Buffer.concat([PNG, require('crypto').randomBytes(256 * 1024)]);
      const z = new JSZip();
      z.file('c/receipt.png', big);
      z.file('c/readme.jpg', 'not a photo at all '.repeat(500));
      z.file('c/scan.pdf', Buffer.from(`%PDF-1.4 ${'x'.repeat(5000)}`));
      const zip = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

      const r = await openArchive(zip);
      expect(r.entries.map(e => [e.name, e.mime])).toEqual([['c/receipt.png', 'image/png'], ['c/scan.pdf', 'application/pdf']]);
      expect(r.skipped).toEqual([{ name: 'c/readme.jpg', reason: 'its contents are not a JPEG, PNG or PDF, whatever its name says' }]);
      expect((await r.entries[0].read()).equals(big)).toBe(true);
    });
  });

  // A zip that deflates to a few MB can unpack to a hundred 15MB files.
  describe('size and memory', () => {
    test('openArchive lists entries without extracting them, and each reads on demand', async () => {
      const zip = makeZip([{ name: 'c/a.jpg', data: JPEG }, { name: 'c/b.pdf', data: Buffer.from('%PDF-1.4') }]);
      const r = await openArchive(zip);
      expect(r.entries.map(e => [e.name, e.size])).toEqual([['c/a.jpg', JPEG.length], ['c/b.pdf', 8]]);
      expect(r.entries[0].buffer).toBeUndefined();
      // After listing has finished, and more than once.
      expect(await r.entries[1].read()).toEqual(Buffer.from('%PDF-1.4'));
      expect(await r.entries[0].read()).toEqual(JPEG);
      expect(r.totalBytes).toBe(JPEG.length + 8);
    });

    test('the total unpacked size is capped, and going over it is an error rather than a quiet cut', async () => {
      const zip = makeZip([{ name: 'c/a.jpg', data: JPEG }, { name: 'c/b.jpg', data: JPEG }, { name: 'c/c.jpg', data: JPEG }]);
      const r = await openArchive(zip, { maxTotalBytes: JPEG.length * 2 });
      expect(r.entries).toHaveLength(2);
      expect(r.skipped).toEqual([{ name: 'c/c.jpg', reason: 'archive size limit reached' }]);
      expect(r.error).toMatch(/split it/);
    });

    test('readArchive reports the cap the same way, so bill intake stops on it too', async () => {
      const zip = makeZip([{ name: 'c/a.pdf', data: JPEG }, { name: 'c/b.pdf', data: JPEG }]);
      const r = await readArchive(zip, { maxTotalBytes: JPEG.length });
      expect(r.error).toMatch(/split it/);
    });

    test('the default cap is 200MB', () => {
      expect(MAX_TOTAL_BYTES).toBe(200 * 1024 * 1024);
    });
  });

  describe('helpers', () => {
    test('mimeFor is case-insensitive, matching real filenames like IMG_0321.PNG', () => {
      expect(mimeFor('IMG_0321.PNG')).toBe('image/png');
      expect(mimeFor('a.JPEG')).toBe('image/jpeg');
      expect(mimeFor('a.heic')).toBeNull();   // browsers convert these; a zip cannot
    });

    test('isJunk covers every macOS artefact seen in a real archive', () => {
      expect(isJunk('__MACOSX/x/._y.png')).toBe(true);
      expect(isJunk('x/._y.png')).toBe(true);
      expect(isJunk('x/.DS_Store')).toBe(true);
      expect(isJunk('x/')).toBe(true);
      expect(isJunk('x/real.png')).toBe(false);
    });
  });
});
