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

// The optional groups a request names in ?extras= (Setup's ticked boxes), or
// null when it names none at all, which leaves the choice to the probe. An
// empty value is a real answer: ask for none. Unknown keys are ignored.
function _extrasFrom(query) {
  if (query.extras === undefined) return null;
  return String(query.extras).split(',').map(s => s.trim()).filter(k => xeroOAuth.GROUP_KEYS.includes(k));
}

// GET /api/xero/oauth/connect — authenticated SPA call that mints the Xero
// consent-screen URL. The browser itself does the actual redirect (not this route).
// ?extras=live,balance names the optional permissions to ask for (Setup's
// boxes); one Xero refuses this app is left out and reported in `excluded`,
// since asking for it lands the person on Xero's "invalid_scope" page, which
// never comes back. Answers { url, requested, excluded }.
router.get('/oauth/connect', requireAuth, asyncHandler(async (req, res) => {
  try {
    const { url, requested, excluded } = await xeroOAuth.authorizeFor(req.user.id, {
      extras: _extrasFrom(req.query), force: req.query.force === 'true',
    });
    res.json({ url, requested, excluded });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

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
    // Only an error about scopes touches the state: anything else (a person
    // declining) leaves it alone. What the refused link asked for comes with
    // its state, so a refusal that names no scope drops only what was asked
    // for this time.
    if (state && xeroOAuth.scopeRefusal(req.query)) {
      const entry  = oauthState.consumeEntry(String(state));
      const groups = entry && Array.isArray(entry.data?.groups) ? entry.data.groups : undefined;
      const refused = xeroOAuth.scopeRefusal(req.query, groups === undefined ? null : xeroOAuth.groupScopes(groups));
      if (refused && entry?.userId) {
        let retry = null;
        try {
          retry = xeroOAuth.retryAuthorizeUrl(entry.userId, refused, groups);
        } catch (err) {
          logger.warn('Could not ask for Xero consent again without the refused scopes', { error: err.message, userId: entry.userId });
        }
        if (retry) return res.redirect(retry);
      }
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

  const entry = oauthState.consumeEntry(state);
  if (!entry || entry.userId !== req.user.id) {
    logger.warn('Xero OAuth completion rejected — state does not belong to this user', { userId: req.user.id });
    return res.status(400).json({ error: 'This Xero connection link is invalid or expired — try connecting again.' });
  }

  try {
    // The optional groups the link asked for, so the ones it did not are
    // recorded as the person's choice (xero/oauth.js completeConnection).
    const groups = Array.isArray(entry.data?.groups) ? entry.data.groups : undefined;
    await xeroOAuth.completeConnection(req.user.id, code, { groups });
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
// app-wide banner and Setup. Exactly { method, connected, needsReconnect,
// reason, missingScopes, refusedScopes, refusedMessage, optional, probe } —
// see xero/reconnect.js getConnectionStatus. It never calls the Xero API, so
// it is safe to poll. For an OAuth connection whose app has not been asked
// in the last day which optional permissions it may request, it starts that
// probe (three requests to Xero's authorize page, no API call) without
// waiting; the next poll reports the answer. ?force=true asks again and
// waits — Setup's "Check again".
router.get('/connection', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const force  = req.query.force === 'true';
  if (getConnectionStatus(userId).method === 'oauth') {
    // Returns at once with the last answer while it is fresh; otherwise asks
    // Xero, shared with any probe already running for this user.
    const probe = xeroOAuth.probeOptionalScopes(userId, { force }).catch(err => {
      if (!/not configured/i.test(err.message)) logger.warn('Could not ask Xero which permissions this app may request', { userId, error: err.message });
    });
    if (force) await probe;
  }
  const s = getConnectionStatus(userId);
  res.json({
    method:         s.method,
    connected:      s.connected,
    needsReconnect: s.needsReconnect,
    reason:         s.reason,
    missingScopes:  s.missingScopes,
    refusedScopes:  s.refusedScopes,
    refusedMessage: s.refusedMessage,
    optional:       s.optional,
    probe:          s.probe,
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
