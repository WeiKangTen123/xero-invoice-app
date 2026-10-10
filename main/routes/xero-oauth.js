const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth-middleware');
const asyncHandler = require('../middleware/async-handler');
const oauthState  = require('../utils/oauth-state');
const xeroOAuth    = require('../xero/oauth');
const tokenCache   = require('../utils/token-cache');
const { getConnectionStatus } = require('../xero/reconnect');
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
    // Xero would not let this app ask for the optional report scopes
    // (invalid_scope). Asked once more without them, for the user the flow was
    // started for; the second refusal, if any, is the error below. Consuming
    // the state here is safe: no code came with it, so the flow it bound is
    // over, and the new link binds a new state to the same user. See
    // xero/oauth.js scopeRefusal and retryAuthorizeUrl.
    const refused = xeroOAuth.scopeRefusal(req.query);
    if (refused && state) {
      const userId = oauthState.consume(String(state));
      let retry = null;
      try {
        retry = userId ? xeroOAuth.retryAuthorizeUrl(userId, refused) : null;
      } catch (err) {
        logger.warn('Could not ask for Xero consent again without the refused scopes', { error: err.message, userId });
      }
      if (retry) return res.redirect(retry);
    }
    logger.warn('Xero OAuth consent denied or errored', { error: xeroError, description: req.query.error_description || undefined });
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
router.post('/oauth/complete', requireAuth, asyncHandler(async (req, res) => {
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
}));

// DELETE /api/xero/oauth/disconnect — clears the OAuth connection for this user
// (Custom Connection, if also configured, is untouched).
//
// Revokes the refresh token with Xero first. Clearing it only here left the
// grant alive on Xero's side: the app stayed listed under the user's
// connected apps, with access to their books, until the token lapsed by
// itself. Revocation is best-effort — Xero being unreachable must not stop a
// person disconnecting — so its outcome is logged, and the local state is
// cleared either way.
router.delete('/oauth/disconnect', requireAuth, asyncHandler(async (req, res) => {
  let revoked = false;
  try {
    revoked = await xeroOAuth.revokeRefreshToken(req.user.id);
  } catch (err) {
    logger.warn('Xero OAuth revocation threw — disconnecting locally anyway', { error: err.message, userId: req.user.id });
  }

  const cache = tokenCache.forUser(req.user.id);
  for (const tenant of cache.getAllTenants()) cache.removeTenant(tenant.tenant_id);
  saveUserConfig(req.user.id, { XERO_OAUTH_REFRESH_TOKEN: '', XERO_CONNECTION_TYPE: '' });
  tokenCache.clearHealth(req.user.id);
  require('../xero/reports').clearCache(req.user.id); // don't let Xero Insights serve stale data post-disconnect
  logger.info('Xero OAuth connection disconnected', { by: req.user.email, revokedWithXero: !!revoked });
  res.json({ success: true });
}));

// GET /api/xero/connection — the state of this user's Xero connection for the
// app-wide banner. Exactly { method, connected, needsReconnect, reason,
// missingScopes, refusedScopes, refusedMessage } — see xero/reconnect.js
// getConnectionStatus. Reads what is on file and never calls Xero, so it is
// safe to poll.
router.get('/connection', requireAuth, asyncHandler(async (req, res) => {
  const s = getConnectionStatus(req.user.id);
  res.json({
    method:         s.method,
    connected:      s.connected,
    needsReconnect: s.needsReconnect,
    reason:         s.reason,
    missingScopes:  s.missingScopes,
    refusedScopes:  s.refusedScopes,
    refusedMessage: s.refusedMessage,
  });
}));

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
