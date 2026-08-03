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
// through requireAuth — the `state` param IS the auth boundary (see utils/oauth-state.js).
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error: xeroError } = req.query;
  const base = _frontendSetupUrl();

  if (xeroError) {
    logger.warn('Xero OAuth consent denied or errored', { error: xeroError });
    return res.redirect(`${base}?xero_oauth=error`);
  }

  const userId = oauthState.consume(state);
  if (!userId || !code) {
    logger.warn('Xero OAuth callback with missing/invalid state or code');
    return res.redirect(`${base}?xero_oauth=error`);
  }

  try {
    await xeroOAuth.completeConnection(userId, code);
    res.redirect(`${base}?xero_oauth=success`);
  } catch (err) {
    logger.error('Xero OAuth callback failed', { error: err.message, userId });
    res.redirect(`${base}?xero_oauth=error`);
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
