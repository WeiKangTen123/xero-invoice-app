const fs = require('fs');
const path = require('path');
const pdfStore = require('./pdf-store');

describe('utils/pdf-store', () => {
  const userId = 'test-security-user';
  const store = pdfStore.forUser(userId);

  afterAll(() => {
    try {
      store.clearAll();
      const userDir = path.join(__dirname, '../data/users', userId);
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch {}
  });

  test('saves and retrieves a valid PDF safely', () => {
    const dummy = Buffer.from('%PDF-1.4 dummy content');
    const savedPath = store.save('inv-12345', dummy);
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(store.exists('inv-12345')).toBe(true);
    expect(store.getPath('inv-12345')).toBe(savedPath);

    expect(store.remove('inv-12345')).toBe(true);
    expect(store.exists('inv-12345')).toBe(false);
  });

  test('blocks path traversal attempts in getPath, exists, and remove', () => {
    expect(store.getPath('../../etc/passwd')).toBeNull();
    expect(store.getPath('../secrets')).toBeNull();
    expect(store.getPath('nested/dir/evil')).toBeNull();
    expect(store.getPath('win\\dir\\evil')).toBeNull();

    expect(store.exists('../../etc/passwd')).toBe(false);
    expect(store.remove('../../etc/passwd')).toBe(false);
  });

  test('throws an error on path traversal in save()', () => {
    const dummy = Buffer.from('malicious');
    expect(() => store.save('../../traversal', dummy)).toThrow('Invalid or unsafe PDF ID');
    expect(() => store.save('folder/escape', dummy)).toThrow('Invalid or unsafe PDF ID');
  });
});
