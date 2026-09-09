const zlib = require('zlib');
const { readArchive, mimeFor, isJunk } = require('./claim-archive');

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

describe('claims/claim-archive', () => {
  test('extracts the receipt images', async () => {
    const zip = makeZip([
      { name: 'claims/a.png', data: JPEG },
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
