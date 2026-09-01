const fs   = require('fs');
const path = require('path');
const os   = require('os');

const store = require('./receipt-store');

// Each test writes under main/data/users/<id>/receipts. The ids are unique per
// test so nothing collides, and clearAll tidies up after.
const uid = () => `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // enough to be a real buffer

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
      expect(s.save('def', JPEG, 'application/pdf')).toBe('def.pdf');
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
      expect(() => s.save('r1', Buffer.alloc(store.MAX_BYTES, 1), 'image/jpeg')).not.toThrow();
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
      s.save('r2', JPEG, 'image/png');
      s.clearAll();
      expect(s.exists('r1.jpg')).toBe(false);
      expect(s.exists('r2.png')).toBe(false);
      expect(fs.existsSync(s.dir)).toBe(true);
    });

    test('the same user gets the same store instance back', () => {
      const id = uid(); created.push(id);
      expect(store.forUser(id)).toBe(store.forUser(id));
    });
  });
});
