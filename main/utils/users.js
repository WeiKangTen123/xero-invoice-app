const fs      = require('fs');
const path    = require('path');
const bcrypt  = require('bcryptjs');

const DATA_DIR   = path.join(__dirname, '../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Serialise all writes to users.json through a promise chain so concurrent
// admin operations (e.g. two admins creating users at once) never corrupt the file.
let _usersWriteLock = Promise.resolve();

function _withUsersLock(fn) {
  const result = _usersWriteLock.then(fn);
  _usersWriteLock = result.catch(() => {});
  return result;
}

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── Per-user config (IMAP, Xero credentials, per-user defaults) ──────────────

function getUserConfig(userId) {
  const file = path.join(DATA_DIR, 'users', userId, 'config.json');
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return {}; }
}

function saveUserConfig(userId, patch) {
  const dir = path.join(DATA_DIR, 'users', userId);
  fs.mkdirSync(dir, { recursive: true });
  const current = getUserConfig(userId);
  const updated = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) continue; // undefined/null = not provided
    if (v === '') {
      delete updated[k]; // explicit empty string = user wants to clear this field
    } else {
      updated[k] = v;
    }
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(updated, null, 2));
  return updated;
}

// ── User CRUD ─────────────────────────────────────────────────────────────────

function hasUsers() {
  return readUsers().length > 0;
}

function findById(id) {
  return readUsers().find(u => u.id === id) || null;
}

function findByEmail(email) {
  return readUsers().find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
}

async function createUser(email, password, role = 'user') {
  const hash = await bcrypt.hash(password, 10);
  return _withUsersLock(() => {
    const users = readUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
      throw new Error('Email already exists');
    }
    // 'auto' = first user becomes admin, all subsequent users become 'user'.
    // Resolved inside the lock so two simultaneous first registrations cannot
    // both claim admin — only one can be first in the serialised queue.
    const actualRole = role === 'auto' ? (users.length === 0 ? 'admin' : 'user') : role;
    const user = {
      id:        `${Date.now()}`,
      email:     email.toLowerCase().trim(),
      password:  hash,
      role:      actualRole,
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    writeUsers(users);

    // Pre-create the user's data directory so every account in users.json
    // has a corresponding folder from day one (not lazily on first config save).
    const userDir    = path.join(DATA_DIR, 'users', user.id);
    const configFile = path.join(userDir, 'config.json');
    fs.mkdirSync(userDir, { recursive: true });
    if (!fs.existsSync(configFile)) {
      fs.writeFileSync(configFile, JSON.stringify({}, null, 2));
    }

    return sanitize(user);
  });
}

async function validatePassword(email, password) {
  const user = findByEmail(email);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password);
  return ok ? sanitize(user) : null;
}

function getAllUsers() {
  return readUsers().map(sanitize);
}

function updateUserRole(id, role) {
  return _withUsersLock(() => {
    const users = readUsers();
    const idx   = users.findIndex(u => u.id === id);
    if (idx === -1) throw new Error('User not found');
    users[idx] = { ...users[idx], role };
    writeUsers(users);
    return sanitize(users[idx]);
  });
}

function deleteUser(id) {
  return _withUsersLock(() => {
    const users = readUsers().filter(u => u.id !== id);
    writeUsers(users);
    // Remove the user's data directory atomically with the auth record so
    // a future registration cannot collide with an orphaned dataset.
    const userDir = path.join(DATA_DIR, 'users', id);
    fs.rmSync(userDir, { recursive: true, force: true });
  });
}

function sanitize(u) {
  return { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt };
}

// Returns which setup sections are configured for a user, and whether the
// system is ready to start (imap + xero are both required; llm is optional).
function getSetupStatus(userId) {
  const config = getUserConfig(userId);
  const imap   = !!(config.IMAP_HOST && config.IMAP_USER && config.IMAP_PASS);
  const xero   = !!(config.XERO_CLIENT_ID && config.XERO_CLIENT_SECRET);
  const llm    = !!(config.Gemini_API_KEY || config.Nvidia_API_KEY || config.OPENROUTER_API_KEY);

  const missingConfig = [];
  if (!imap) missingConfig.push('imap');
  if (!xero) missingConfig.push('xero');
  if (!llm)  missingConfig.push('llm');

  return {
    imap:          { configured: imap },
    xero:          { configured: xero },
    llm:           { configured: llm },
    ready:         imap && xero,
    missingConfig,
  };
}

// Ensures every account in users.json has a corresponding data directory and
// config.json. Safe to call on every startup — creates only what is missing,
// never overwrites existing files. Guards against users that were created
// before the directory-provisioning logic existed in createUser.
function ensureUserDirectories() {
  for (const u of readUsers()) {
    const userDir    = path.join(DATA_DIR, 'users', u.id);
    const configFile = path.join(userDir, 'config.json');
    fs.mkdirSync(userDir, { recursive: true });
    if (!fs.existsSync(configFile)) {
      fs.writeFileSync(configFile, JSON.stringify({}, null, 2));
    }
  }
}

module.exports = {
  hasUsers, findById, findByEmail, createUser, validatePassword,
  getAllUsers, updateUserRole, deleteUser, readUsers,
  getUserConfig, saveUserConfig, getSetupStatus, ensureUserDirectories,
};
