const fs   = require('fs');
const path = require('path');

const BASE_DIR = path.join(__dirname, '../data/users');
const _stores  = new Map();

function _isSafeId(id) {
  if (!id || typeof id !== 'string') return false;
  return !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

function forUser(userId) {
  if (_stores.has(userId)) return _stores.get(userId);

  const PDF_DIR = path.join(BASE_DIR, String(userId), 'pdfs');

  function ensureDir() { fs.mkdirSync(PDF_DIR, { recursive: true }); }

  function save(id, buffer) {
    if (!_isSafeId(id)) throw new Error('Invalid or unsafe PDF ID');
    ensureDir();
    const dest = path.join(PDF_DIR, `${id}.pdf`);
    fs.writeFileSync(dest, buffer);
    return dest;
  }

  function getPath(id) {
    if (!_isSafeId(id)) return null;
    const p = path.join(PDF_DIR, `${id}.pdf`);
    return fs.existsSync(p) ? p : null;
  }

  function exists(id) {
    if (!_isSafeId(id)) return false;
    return fs.existsSync(path.join(PDF_DIR, `${id}.pdf`));
  }

  function remove(id) {
    if (!_isSafeId(id)) return false;
    const p = path.join(PDF_DIR, `${id}.pdf`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
    return false;
  }

  function clearAll() {
    ensureDir();
    for (const f of fs.readdirSync(PDF_DIR)) {
      if (f.endsWith('.pdf')) {
        try { fs.unlinkSync(path.join(PDF_DIR, f)); } catch {}
      }
    }
  }

  const store = { save, getPath, exists, remove, clearAll };
  _stores.set(userId, store);
  return store;
}

module.exports = { forUser };
