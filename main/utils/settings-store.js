const fs   = require('fs');
const path = require('path');

const BASE_DIR = path.join(__dirname, '../data/users');
const DEFAULTS = { autoProcess: true };
const _stores  = new Map();

function forUser(userId) {
  if (_stores.has(userId)) return _stores.get(userId);

  const FILE = path.join(BASE_DIR, userId, 'settings.json');

  function read() {
    try {
      if (!fs.existsSync(FILE)) return { ...DEFAULTS };
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    } catch { return { ...DEFAULTS }; }
  }

  function _write(settings) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
  }

  function get(key) { const s = read(); return key ? s[key] : s; }

  function set(patch) {
    const updated = { ...read(), ...patch };
    _write(updated);
    return updated;
  }

  const store = { get, set };
  _stores.set(userId, store);
  return store;
}

module.exports = { forUser };
