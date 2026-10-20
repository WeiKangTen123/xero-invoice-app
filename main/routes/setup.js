const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { requireAuth, requireAdmin } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const {
  getUserConfig, saveUserConfig, getSetupStatus, getImapSettings, isDemoUser,
  getGeminiKeys, addGeminiKey, removeGeminiKey, checkAllowanceSettings, defaultsFrom, timezoneProblem,
} = require('../utils/users');
const logger  = require('../utils/logger');
const { automaticImapValues } = require('../email/imap-settings');

// ── Field definitions ─────────────────────────────────────────────────────────

// Per-user fields — stored in data/users/{id}/config.json
// Each user brings their own IMAP account and Xero connection. Gemini API keys are
// a separate 1:many resource managed via the /llm-keys routes below, not a flat
// field here — a user can have any number of them.
// Each user brings their own Xero Web app for OAuth too (XERO_OAUTH_CLIENT_ID/SECRET),
// same per-user model as the Custom Connection fields — see xero/oauth.js for why
// (Xero's rate limit is per-app, so per-user apps give each user their own budget).
const USER_SECTIONS = {
  xero:        ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_OAUTH_CLIENT_ID', 'XERO_OAUTH_CLIENT_SECRET'],
  imap:        ['IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS', 'IMAP_FILTER_FROM', 'IMAP_POLL_INTERVAL_MS', 'IMAP_LOOKBACK_DAYS'],
  // CLAIM_PAYEE_NAME: the claimant as a Xero contact. Without it an expense
  // claim is posted as a bill owed to the shop on the receipt.
  defaults:    ['DEFAULT_ACCOUNT_CODE', 'DEFAULT_CURRENCY', 'ZERO_TAX_RATE', 'CLAIM_PAYEE_NAME'],
  // Claims with no receipt. A blank rate turns that kind of claim off; a blank
  // account codes it to the claim account. Checked before saving
  // (users.checkAllowanceSettings), unlike the free-text defaults above.
  allowances:  ['MILEAGE_RATE', 'MILEAGE_ACCOUNT_CODE', 'PER_DIEM_RATE', 'PER_DIEM_ACCOUNT_CODE'],
  // Display-only preference — every timestamp is stored in UTC regardless; this only
  // controls what timezone it's FORMATTED in for this user (see ui's formatDate.js).
  preferences: ['TIMEZONE'],
};

// Plain-language labels for fields whose key does not explain itself. Sent with
// the field so the Setup page can show it in place of the key.
const FIELD_LABELS = {
  CLAIM_PAYEE_NAME:      'Your name for expense claims (the payee in Xero)',
  MILEAGE_RATE:          'Mileage rate per km',
  MILEAGE_ACCOUNT_CODE:  'Mileage account',
  PER_DIEM_RATE:         'Per diem daily rate',
  PER_DIEM_ACCOUNT_CODE: 'Per diem account',
};

// What a blank account box codes the claim to, said beside the box: the claim
// account, which is itself a default and may not be what the user expects.
const ACCOUNT_FALLBACK_KEYS = new Set(['MILEAGE_ACCOUNT_CODE', 'PER_DIEM_ACCOUNT_CODE']);

// Shared/global fields — stored in .env; only admins can set these
// (Slack webhook — infrastructure-level config not per-user)
// Real credentials. They are reported as set/unset and never sent back to
// the browser; a blank value on save means "keep what is stored". The page
// used to receive the raw client secret and IMAP password on every load and
// post them back on every save.
const SECRET_KEYS = new Set(['XERO_CLIENT_SECRET', 'XERO_OAUTH_CLIENT_SECRET', 'IMAP_PASS']);

// How a stored secret is shown so a person can tell it is there and which
// one it is: dots and its last four characters, as the Gemini keys are
// listed. Never more: the browser has never been sent a stored secret, which
// is what keeps one off a shared screen. One too short to spare four
// characters shows dots only.
const MASK_DOTS = '••••••••••••';
function maskSecret(value) {
  const v = String(value || '');
  if (!v) return '';
  return v.length >= 12 ? `${MASK_DOTS}${v.slice(-4)}` : MASK_DOTS;
}

const GLOBAL_SECTIONS = {
  optional:  ['SLACK_WEBHOOK_URL'],
  // A property of this server's deployment, not of any one user — every user's own
  // Xero Web app (see USER_SECTIONS.xero above) registers this same redirect URI.
  xeroOAuth: ['XERO_OAUTH_REDIRECT_URI'],
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

// ── GET /api/setup — returns both per-user config and global config ───────────
router.get('/', requireAuth, (req, res) => {
  const userConfig = getUserConfig(req.user.id);
  const globalEnv  = readEnvFile();
  const result     = {};

  // What a blank mailbox box will actually use, so the form can offer the value
  // instead of demanding it. Null means there is nothing to work out and the
  // field has to be filled in by hand.
  const auto = automaticImapValues(req.user.email);
  const claimAccount = defaultsFrom(userConfig).accountCode.claim;

  // The mailbox the stored password belongs to, so it can be reviewed as
  // "the password for weikangten@gmail.com": the user typed, else the one
  // worked out from the sign-in address, as the watcher resolves it.
  const imapAccount = String(userConfig.IMAP_USER || auto.IMAP_USER || req.user.email || '');

  for (const [section, keys] of Object.entries(USER_SECTIONS)) {
    result[section] = {};
    for (const key of keys) {
      const val = String(userConfig[key] || '');
      const secret = SECRET_KEYS.has(key);
      result[section][key] = {
        value: secret ? '' : val,
        isSet: val.length > 0,
        ...(secret && { masked: maskSecret(val) }),
        ...(key === 'IMAP_PASS' && { account: imapAccount }),
        auto:  auto[key] ?? null,
        ...(FIELD_LABELS[key] && { label: FIELD_LABELS[key] }),
        ...(ACCOUNT_FALLBACK_KEYS.has(key) && { hint: `Blank uses your claim account (${claimAccount}).` }),
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
      if (SECRET_KEYS.has(k) && (v === '' || v == null)) continue;   // blank = keep the stored secret
      if (allUserKeys.includes(k))   userPatch[k]   = v;
      else if (allGlobalKeys.includes(k) && req.user.role === 'admin') globalPatch[k] = v;
    }

    // Rates price claims, so a value that cannot be one is refused, and the
    // whole save with it: half a form applied is harder to notice than none.
    const { values: checkedPatch, errors } = checkAllowanceSettings(userPatch);
    // The timezone is free text that every report dates itself in, and a name
    // Intl does not know used to 500 every one of them until it was corrected.
    if (userPatch.TIMEZONE !== undefined) {
      const problem = timezoneProblem(userPatch.TIMEZONE);
      if (problem) errors.push({ field: 'TIMEZONE', error: problem });
      else checkedPatch.TIMEZONE = String(userPatch.TIMEZONE ?? '').trim();
    }
    if (errors.length) return res.status(400).json({ error: errors[0].error, errors });
    Object.assign(userPatch, checkedPatch);

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
//
// Every key the account can be using, in the order gemini-client.js
// (_resolveKeys) tries them: the added keys, then a key saved in the old
// single-key field (Gemini_API_KEY), which is used only while no key is
// added, then the server's shared key from .env for an account with none of
// its own. The old field's key used to be left off this list, so an account
// running on it read "No API keys added yet". `inUse` says which of them
// reading invoices actually uses now; `serverKey` whether the shared one is
// there to fall back on.
const maskKey = key => (key.length > 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : '••••');
router.get('/llm-keys', requireAuth, (req, res) => {
  const added  = getGeminiKeys(req.user.id);
  const legacy = String(getUserConfig(req.user.id).Gemini_API_KEY || '');
  const keys = added.map(k => ({
    id:        k.id,
    label:     k.label,
    createdAt: k.createdAt,
    keyMasked: maskKey(k.apiKey),
    inUse:     true,
  }));
  if (legacy) {
    keys.push({ id: 'legacy', label: null, createdAt: null, keyMasked: maskKey(legacy), legacy: true, inUse: added.length === 0 });
  }
  res.json({ keys, serverKey: !added.length && !legacy && !!process.env.Gemini_API_KEY });
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

// DELETE /api/setup/llm-keys/:id — `legacy` clears the old single-key field.
router.delete('/llm-keys/:id', requireAuth, (req, res) => {
  if (req.params.id === 'legacy') {
    if (!getUserConfig(req.user.id).Gemini_API_KEY) return res.status(404).json({ error: 'Key not found' });
    saveUserConfig(req.user.id, { Gemini_API_KEY: '' });
    logger.info('Gemini API key removed', { by: req.user.email, legacy: true });
    return res.json({ success: true });
  }
  const removed = removeGeminiKey(req.user.id, Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Key not found' });
  logger.info('Gemini API key removed', { by: req.user.email });
  res.json({ success: true });
});

// ── POST /api/setup/test/xero — test this user's Xero connection ──────────────
// Tests whichever method is active (OAuth or Custom Connection) and leaves it
// active. It used to test Custom Connection only and switch the account to it
// on success, so an OAuth user pressing Test was silently moved off OAuth —
// see xero/reconnect.js testConnection.
router.post('/test/xero', requireAuth, asyncHandler(async (req, res) => {
  const { testConnection, DEMO_NO_XERO_MESSAGE } = require('../xero/reconnect');
  const { xeroErrMsg }     = require('../xero/xero-utils');
  // Nothing to test for a demo account. `message` is what the Test button
  // shows; `error` is what every other refusal of a demo account carries.
  if (isDemoUser(req.user.id)) {
    return res.status(400).json({ success: false, error: DEMO_NO_XERO_MESSAGE, message: DEMO_NO_XERO_MESSAGE });
  }
  try {
    const { method } = await testConnection(req.user.id);
    const via = method === 'oauth' ? 'via Xero login (OAuth)' : 'via Custom Connection';
    res.json({ success: true, message: `Xero connected successfully ${via}` });
  } catch (err) {
    res.status(400).json({ success: false, message: xeroErrMsg(err) });
  }
}));

// ── POST /api/setup/test/imap — test this user's IMAP connection ──────────────
router.post('/test/imap', requireAuth, asyncHandler(async (req, res) => {
  try {
    // The same settings the watcher will use, so a passing test means a working
    // watcher — including everything filled in from the account.
    const settings = getImapSettings(req.user.id);

    if (!settings.ready) {
      const missing = !settings.password ? 'an app password'
                    : !settings.host     ? 'the mailbox server (we do not know it for this email provider)'
                    : 'a mailbox address';
      return res.status(400).json({ success: false, message: `Mailbox not configured — go to Setup and add ${missing}.` });
    }

    const Imap = require('imap');
    const imap = new Imap({
      user:       settings.user,
      password:   settings.password,
      host:       settings.host,
      port:       settings.port,
      tls:        true,
      // The same certificate rule as the watcher itself: verified for any real
      // mail server, skipped only for a loopback bridge. The test used to skip
      // it always, so it could pass for a connection the watcher then refused.
      tlsOptions: require('../email/watcher-registry').imapTlsOptions(settings.host),
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
}));

// ── POST /api/setup/test/llm — test this user's LLM key ─────────────────────
router.post('/test/llm', requireAuth, asyncHandler(async (req, res) => {
  try {
    const { extractWithRetry } = require('../email/llm-parser');
    await extractWithRetry('Invoice #TEST-001\nVendor: Test Co\nTotal: $1.00', 'test.pdf', req.user.id);
    res.json({ success: true, message: 'LLM API connected successfully' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
}));

module.exports = router;
