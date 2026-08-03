const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { requireAuth, requireAdmin } = require('../middleware/auth-middleware');
const {
  getUserConfig, saveUserConfig, getSetupStatus,
  getGeminiKeys, addGeminiKey, removeGeminiKey,
} = require('../utils/users');
const logger  = require('../utils/logger');

// ── Field definitions ─────────────────────────────────────────────────────────

// Per-user fields — stored in data/users/{id}/config.json
// Each user brings their own IMAP account and Xero connection. Gemini API keys are
// a separate 1:many resource managed via the /llm-keys routes below, not a flat
// field here — a user can have any number of them.
const USER_SECTIONS = {
  xero:     ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET'],
  imap:     ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS', 'IMAP_FILTER_FROM', 'IMAP_POLL_INTERVAL_MS', 'IMAP_LOOKBACK_DAYS'],
  defaults: ['DEFAULT_ACCOUNT_CODE', 'DEFAULT_CURRENCY', 'ZERO_TAX_RATE'],
};

// Shared/global fields — stored in .env; only admins can set these
// (Slack webhook, Redis — infrastructure-level config not per-user)
const GLOBAL_SECTIONS = {
  optional:  ['SLACK_WEBHOOK_URL', 'REDIS_URL'],
  // One shared Xero "Web app" registration for the whole deployment — each user
  // authorizes it against their own org via the consent screen (see routes/xero-oauth.js),
  // unlike the per-user XERO_CLIENT_ID/SECRET Custom Connection fields above.
  xeroOAuth: ['XERO_OAUTH_CLIENT_ID', 'XERO_OAUTH_CLIENT_SECRET', 'XERO_OAUTH_REDIRECT_URI'],
};

const ENV_FILE = path.join(__dirname, '../.env');

function readEnvFile() {
  try {
    if (!fs.existsSync(ENV_FILE)) return {};
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    const env   = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

function writeEnvFile(updates) {
  // Read the raw file to preserve blank lines and # comment lines.
  // Rewrite changed values in place; append new keys at the end.
  let raw = '';
  try { raw = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
  const written = new Set();
  const lines = raw.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line; // keep comments/blanks
    const idx = trimmed.indexOf('=');
    if (idx < 0) return line;
    const key = trimmed.slice(0, idx).trim();
    if (key in updates && updates[key] !== '' && updates[key] != null) {
      written.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k) && v !== '' && v != null) lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
  for (const [k, v] of Object.entries(updates)) {
    if (v) process.env[k] = v;
  }
}

// ── GET /api/setup/status — quick summary of which sections are configured ────
// Lightweight check — no secrets returned, used by the frontend to decide
// whether to show a "setup required" banner or redirect on first login.
router.get('/status', requireAuth, (req, res) => {
  res.json(getSetupStatus(req.user.id));
});

// ── GET /api/setup — returns both per-user config and global config ───────────
router.get('/', requireAuth, (req, res) => {
  const userConfig = getUserConfig(req.user.id);
  const globalEnv  = readEnvFile();
  const result     = {};

  for (const [section, keys] of Object.entries(USER_SECTIONS)) {
    result[section] = {};
    for (const key of keys) {
      const val = userConfig[key] || '';
      result[section][key] = {
        value: val,
        isSet: val.length > 0,
      };
    }
  }

  // Global LLM section — visible to all but only writable by admin
  for (const [section, keys] of Object.entries(GLOBAL_SECTIONS)) {
    result[section] = {};
    for (const key of keys) {
      const val = globalEnv[key] || '';
      result[section][key] = {
        value:    val,
        isSet:    val.length > 0,
        readOnly: req.user.role !== 'admin',
      };
    }
  }

  res.json(result);
});

// ── POST /api/setup — save updated values ─────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
  try {
    const allUserKeys  = Object.values(USER_SECTIONS).flat();
    const allGlobalKeys = Object.values(GLOBAL_SECTIONS).flat();

    const userPatch   = {};
    const globalPatch = {};

    for (const [k, v] of Object.entries(req.body)) {
      if (allUserKeys.includes(k))   userPatch[k]   = v;
      else if (allGlobalKeys.includes(k) && req.user.role === 'admin') globalPatch[k] = v;
    }

    if (Object.keys(userPatch).length)   saveUserConfig(req.user.id, userPatch);
    if (Object.keys(globalPatch).length) writeEnvFile(globalPatch);

    logger.info('Setup config saved', {
      userKeys:   Object.keys(userPatch),
      globalKeys: Object.keys(globalPatch),
      by:         req.user.email,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gemini API keys — a separate 1:many resource, not a flat Setup field ──────
// gemini-client.js rotates through every model on one key before moving to the
// next, so adding a key here is real extra quota headroom, not just a spare.

// GET /api/setup/llm-keys — list this user's keys (masked, never the raw value)
router.get('/llm-keys', requireAuth, (req, res) => {
  const keys = getGeminiKeys(req.user.id).map(k => ({
    id:        k.id,
    label:     k.label,
    createdAt: k.createdAt,
    keyMasked: k.apiKey.length > 8 ? `${k.apiKey.slice(0, 4)}••••${k.apiKey.slice(-4)}` : '••••',
  }));
  res.json({ keys });
});

// POST /api/setup/llm-keys — add a new key
router.post('/llm-keys', requireAuth, (req, res) => {
  try {
    const { apiKey, label } = req.body;
    const result = addGeminiKey(req.user.id, apiKey, label);
    logger.info('Gemini API key added', { by: req.user.email });
    res.status(201).json({ success: true, id: result.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/setup/llm-keys/:id
router.delete('/llm-keys/:id', requireAuth, (req, res) => {
  const removed = removeGeminiKey(req.user.id, Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Key not found' });
  logger.info('Gemini API key removed', { by: req.user.email });
  res.json({ success: true });
});

// ── POST /api/setup/test/xero — test this user's Xero connection ──────────────
router.post('/test/xero', requireAuth, async (req, res) => {
  try {
    const { autoConnect } = require('../xero/connect');
    await autoConnect(req.user.id);
    res.json({ success: true, message: 'Xero connected successfully' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ── POST /api/setup/test/imap — test this user's IMAP connection ──────────────
router.post('/test/imap', requireAuth, async (req, res) => {
  try {
    const config   = getUserConfig(req.user.id);
    const imapUser = config.IMAP_USER;
    const imapPass = config.IMAP_PASS;
    const imapHost = config.IMAP_HOST || 'imap.gmail.com';
    const imapPort = Number(config.IMAP_PORT) || 993;

    if (!imapUser || !imapPass) {
      return res.status(400).json({ success: false, message: 'IMAP credentials not configured — go to Setup and enter your email and password first' });
    }

    const Imap = require('imap');
    const imap = new Imap({
      user:       imapUser,
      password:   imapPass,
      host:       imapHost,
      port:       imapPort,
      tls:        true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
    });
    await new Promise((resolve, reject) => {
      imap.once('ready', () => { imap.end(); resolve(); });
      imap.once('error', reject);
      imap.connect();
    });
    res.json({ success: true, message: 'IMAP connected successfully' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ── POST /api/setup/test/llm — test this user's LLM key ─────────────────────
router.post('/test/llm', requireAuth, async (req, res) => {
  try {
    const { extractWithRetry } = require('../email/llm-parser');
    await extractWithRetry('Invoice #TEST-001\nVendor: Test Co\nTotal: $1.00', 'test.pdf', req.user.id);
    res.json({ success: true, message: 'LLM API connected successfully' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;
