const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const oauthState  = require('../utils/oauth-state');
const xeroOAuth    = require('../xero/oauth');
const tokenCache   = require('../utils/token-cache');
const { getUserConfig, saveUserConfig } = require('../utils/users');
const logger = require('../utils/logger');

// Where Xero's redirect callback sends the browser back to after completing (or
// failing) the connection. Express doesn't serve the SPA in dev — only Vite does —
// so the callback needs to know where the actual UI lives in that environment.
function _frontendSetupUrl() {
  if (process.env.NODE_ENV === 'production') return '/setup';
  return `${process.env.FRONTEND_URL || 'http://localhost:5173'}/setup`;
}

// GET /api/xero/oauth/connect — authenticated SPA call that mints the Xero
// consent-screen URL. The browser itself does the actual redirect (not this route).
router.get('/oauth/connect', requireAuth, (req, res) => {
  try {
    const url = xeroOAuth.buildAuthorizeUrl(req.user.id);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/xero/oauth/callback — Xero redirects the user's browser here after
// consent. This is a plain browser GET with no Authorization header, so it can't go
// through requireAuth, and MUST NOT complete the connection itself: `state` only
// proves the flow was started by someone — not that the browser sitting here now is
// that same someone (this app has no cookies/sessions to tie the two together).
// Trusting state alone here lets an attacker start a flow bound to their own
// account, hand the resulting Xero consent link to a victim, and have the victim's
// Xero org silently connected to the ATTACKER's app account instead of the victim's.
// So this route does nothing privileged — it just hands code+state to the SPA, which
// completes the connection via POST /oauth/complete while authenticated as whoever
// is actually sitting in that browser, and the server re-checks that they're the
// same person who started it before touching anything.
router.get('/oauth/callback', (req, res) => {
  const { code, state, error: xeroError } = req.query;
  const base = _frontendSetupUrl();

  if (xeroError) {
    logger.warn('Xero OAuth consent denied or errored', { error: xeroError });
    return res.redirect(`${base}?xero_oauth=error`);
  }
  if (!code || !state) {
    logger.warn('Xero OAuth callback with missing code or state');
    return res.redirect(`${base}?xero_oauth=error`);
  }

  res.redirect(`${base}?xero_oauth=pending&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
});

// POST /api/xero/oauth/complete — authenticated SPA call that actually finishes the
// connection. Rejects unless the caller is the same user `state` was minted for —
// this is the check that closes the hijack described above.
router.post('/oauth/complete', requireAuth, async (req, res) => {
  const { code, state } = req.body;
  if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });

  const boundUserId = oauthState.consume(state);
  if (!boundUserId || boundUserId !== req.user.id) {
    logger.warn('Xero OAuth completion rejected — state does not belong to this user', { userId: req.user.id });
    return res.status(400).json({ error: 'This Xero connection link is invalid or expired — try connecting again.' });
  }

  try {
    await xeroOAuth.completeConnection(req.user.id, code);
    res.json({ success: true });
  } catch (err) {
    logger.error('Xero OAuth completion failed', { error: err.message, userId: req.user.id });
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/xero/oauth/disconnect — clears the OAuth connection for this user
// (Custom Connection, if also configured, is untouched).
router.delete('/oauth/disconnect', requireAuth, (req, res) => {
  const cache = tokenCache.forUser(req.user.id);
  for (const tenant of cache.getAllTenants()) cache.removeTenant(tenant.tenant_id);
  saveUserConfig(req.user.id, { XERO_OAUTH_REFRESH_TOKEN: '', XERO_CONNECTION_TYPE: '' });
  logger.info('Xero OAuth connection disconnected', { by: req.user.email });
  res.json({ success: true });
});

// GET /api/xero/tenants — which method is active + which orgs are connected.
// Works for either connection method — getPersistedTenants doesn't care which
// flow cached them.
router.get('/tenants', requireAuth, (req, res) => {
  const config = getUserConfig(req.user.id);
  res.json({
    connectionType: config.XERO_CONNECTION_TYPE || 'custom',
    tenants:        tokenCache.getPersistedTenants(req.user.id),
  });
});

module.exports = router;
