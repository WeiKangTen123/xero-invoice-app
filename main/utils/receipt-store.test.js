const fs   = require('fs');
const path = require('path');
const os   = require('os');

const store = require('./receipt-store');

// Each test writes under main/data/users/<id>/receipts. The ids are unique per
// test so nothing collides, and clearAll tidies up after.
const uid = () => `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
// Enough of each format's header to pass save()'s check of the contents;
// nothing here inspects pixels.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PDF  = Buffer.from('%PDF-1.4 1 0 obj');
// A filled buffer as large as the test needs, that still opens as a JPEG.
const jpegOf = size => { const b = Buffer.alloc(size, 1); JPEG.copy(b); return b; };

describe('utils/receipt-store', () => {
  const created = [];
  function userStore() { const id = uid(); created.push(id); return { id, s: store.forUser(id) }; }

  afterAll(() => {
    for (const id of created) {
      try { fs.rmSync(path.join(__dirname, '../data/users', id), { recursive: true, force: true }); } catch {}
    }
  });

  describe('accepted types', () => {
    test('accepts exactly what Xero will attach, and nothing else', () => {
      expect(store.acceptedMimes().sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
      expect(store.isAcceptedMime('image/jpeg')).toBe(true);
      expect(store.isAcceptedMime('image/heic')).toBe(false);   // the iPhone default
      expect(store.isAcceptedMime('image/tiff')).toBe(false);
      expect(store.isAcceptedMime('')).toBe(false);
      expect(store.isAcceptedMime(undefined)).toBe(false);
    });

    test('mime matching is case-insensitive', () => {
      expect(store.extensionFor('IMAGE/JPEG')).toBe('jpg');
    });
  });

  describe('save', () => {
    test('returns the stored filename so callers never reconstruct it', () => {
      const { s } = userStore();
      expect(s.save('abc', JPEG, 'image/jpeg')).toBe('abc.jpg');
      expect(s.save('def', PDF, 'application/pdf')).toBe('def.pdf');
    });

    test('the file is actually on disk and reads back byte-identical', () => {
      const { s } = userStore();
      const name = s.save('r1', JPEG, 'image/jpeg');
      expect(s.exists(name)).toBe(true);
      expect(s.read(name).equals(JPEG)).toBe(true);
    });

    test('rejects a type Xero would refuse, rather than storing it to fail later', () => {
      const { s } = userStore();
      expect(() => s.save('r1', JPEG, 'image/heic')).toThrow(/Unsupported/i);
    });

    test('rejects an empty buffer', () => {
      const { s } = userStore();
      expect(() => s.save('r1', Buffer.alloc(0), 'image/jpeg')).toThrow(/empty/i);
      expect(() => s.save('r1', null, 'image/jpeg')).toThrow(/empty/i);
    });

    test('enforces the 3MB cap here too, not only at the route', () => {
      // A second way in must not be able to write an unattachable file.
      const { s } = userStore();
      const tooBig = Buffer.alloc(store.MAX_BYTES + 1, 1);
      expect(() => s.save('r1', tooBig, 'image/jpeg')).toThrow(/limit/i);
      expect(s.exists('r1.jpg')).toBe(false);
    });

    test('a file exactly at the cap is allowed', () => {
      const { s } = userStore();
      expect(() => s.save('r1', jpegOf(store.MAX_BYTES), 'image/jpeg')).not.toThrow();
    });

    // The routes identify() a file before saving it; this is the second way in,
    // so a renamed file cannot reach disk under an extension it is not.
    test('refuses a renamed text file or program, and writes nothing', () => {
      const { s } = userStore();
      const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62)]);
      expect(() => s.save('r1', Buffer.from('just some text'), 'image/jpeg')).toThrow(/not a JPEG, PNG or PDF/);
      expect(() => s.save('r2', exe, 'application/pdf')).toThrow(/not a JPEG, PNG or PDF/);
      expect(s.exists('r1.jpg')).toBe(false);
      expect(s.exists('r2.pdf')).toBe(false);
    });

    test('refuses bytes that are a different receipt type than declared', () => {
      // The extension comes from the declared type, so a PNG saved as a JPEG
      // would be served back under the wrong type. Callers pass identify()'s.
      const { s } = userStore();
      expect(() => s.save('r1', PNG, 'image/jpeg')).toThrow(/image\/png, not image\/jpeg/);
      expect(s.save('r1', PNG, 'image/png')).toBe('r1.png');
    });
  });

  describe('identify — what an upload actually is', () => {
    test('accepts real JPEG, PNG and PDF headers, as the type the bytes show', () => {
      expect(store.identify(JPEG)).toEqual({ mime: 'image/jpeg' });
      expect(store.identify(PNG)).toEqual({ mime: 'image/png' });
      expect(store.identify(PDF)).toEqual({ mime: 'application/pdf' });
    });

    test('refuses a renamed text file with a sentence a person can act on', () => {
      expect(store.identify(Buffer.from('hello')).error).toMatch(/not a JPEG, PNG or PDF/);
    });

    test('names a HEIC photo rather than calling it "not an image"', () => {
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(4)]);
      expect(store.identify(heic).error).toMatch(/HEIC image, which Xero does not accept/);
    });
  });

  describe('reading', () => {
    test('a missing file is null, not a throw — a row can outlive its image', () => {
      const { s } = userStore();
      expect(s.getPath('nope.jpg')).toBeNull();
      expect(s.read('nope.jpg')).toBeNull();
      expect(s.exists('nope.jpg')).toBe(false);
    });

    test('an absent or blank filename is null rather than resolving to the directory', () => {
      const { s } = userStore();
      expect(s.getPath('')).toBeNull();
      expect(s.getPath(null)).toBeNull();
      expect(s.getPath(undefined)).toBeNull();
    });

    test('refuses to traverse out of the user directory', () => {
      // The filename reaches this from a DB row; a poisoned one must not read
      // another user's receipt or anything else on the disk.
      const { s } = userStore();
      expect(s.getPath('../../../etc/passwd')).toBeNull();
      expect(s.getPath('..%2Fetc')).toBeNull();
      expect(s.getPath('sub/dir.jpg')).toBeNull();
    });
  });

  describe('isolation and cleanup', () => {
    test('one user cannot see another user\'s receipts', () => {
      const a = userStore(), b = userStore();
      a.s.save('shared-id', JPEG, 'image/jpeg');
      expect(a.s.exists('shared-id.jpg')).toBe(true);
      expect(b.s.exists('shared-id.jpg')).toBe(false);
      expect(a.s.dir).not.toBe(b.s.dir);
    });

    test('remove deletes, and is false for something already gone', () => {
      const { s } = userStore();
      const name = s.save('r1', JPEG, 'image/jpeg');
      expect(s.remove(name)).toBe(true);
      expect(s.remove(name)).toBe(false);
      expect(s.exists(name)).toBe(false);
    });

    test('clearAll empties the directory without removing it', () => {
      const { s } = userStore();
      s.save('r1', JPEG, 'image/jpeg');
      s.save('r2', PNG, 'image/png');
      s.clearAll();
      expect(s.exists('r1.jpg')).toBe(false);
      expect(s.exists('r2.png')).toBe(false);
      expect(fs.existsSync(s.dir)).toBe(true);
    });

    // Thumbnails are cached beside the original as "<filename>.w<width>.jpg".
    // Nothing indexes them, so the only thing keeping them from accumulating
    // forever is that remove() sweeps by prefix.
    test('removing a receipt takes its cached thumbnails with it', () => {
      const { s } = userStore();
      const name = s.save('r1', JPEG, 'image/jpeg');
      fs.writeFileSync(path.join(s.dir, `${name}.w160.jpg`), JPEG);
      fs.writeFileSync(path.join(s.dir, `${name}.w480.jpg`), JPEG);

      expect(s.remove(name)).toBe(true);
      expect(fs.existsSync(path.join(s.dir, `${name}.w160.jpg`))).toBe(false);
      expect(fs.existsSync(path.join(s.dir, `${name}.w480.jpg`))).toBe(false);
    });

    test('thumbnails of a receipt whose original is already gone are still swept', () => {
      // A receipt deleted before thumbnails were swept would otherwise keep them
      // on disk permanently, with nothing left to attribute them to.
      const { s } = userStore();
      const name = s.save('r1', JPEG, 'image/jpeg');
      fs.writeFileSync(path.join(s.dir, `${name}.w160.jpg`), JPEG);
      fs.unlinkSync(path.join(s.dir, name));

      expect(s.remove(name)).toBe(false);   // the original really was gone
      expect(fs.existsSync(path.join(s.dir, `${name}.w160.jpg`))).toBe(false);
    });

    test('one receipt\'s thumbnails are not swept by deleting another', () => {
      const { s } = userStore();
      const a = s.save('r1', JPEG, 'image/jpeg');
      const b = s.save('r2', JPEG, 'image/jpeg');
      fs.writeFileSync(path.join(s.dir, `${a}.w160.jpg`), JPEG);
      fs.writeFileSync(path.join(s.dir, `${b}.w160.jpg`), JPEG);

      s.remove(a);
      expect(fs.existsSync(path.join(s.dir, `${b}.w160.jpg`))).toBe(true);
    });

    test('the same user gets the same store instance back', () => {
      const id = uid(); created.push(id);
      expect(store.forUser(id)).toBe(store.forUser(id));
    });
  });
});
