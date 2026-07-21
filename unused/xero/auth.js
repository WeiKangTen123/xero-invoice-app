const express = require('express');
const router  = express.Router();
const xero    = require('./client');
const cache   = require('../utils/token-cache');
const logger  = require('../utils/logger');
const crypto  = require('crypto');

// Step 1: Redirect user to Xero login
router.get('/connect', async (req, res) => {
  try {
    if (!xero.openIdClient) await xero.initialize();

    const state        = crypto.randomBytes(16).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    req.session.oauthState   = state;
    req.session.codeVerifier = codeVerifier;
    xero.config.state        = state;

    const url = xero.openIdClient.authorizationUrl({
      redirect_uri:          xero.config.redirectUris[0],
      scope:                 xero.config.scopes.join(' '),
      state,
      code_challenge:        codeChallenge,
      code_challenge_method: 'S256'
    });

    logger.info('Redirecting to Xero OAuth', { userId: req.session.userId });
    res.redirect(url);
  } catch (err) {
    logger.error('Failed to build consent URL', { error: err.message });
    res.status(500).json({ error: 'Failed to initiate OAuth' });
  }
});

// Step 2: Handle Xero callback
router.get('/callback', async (req, res) => {
  try {
    if (!xero.openIdClient) await xero.initialize();

    const params = xero.openIdClient.callbackParams(req.url);
    const tokenSet = await xero.openIdClient.callback(
      xero.config.redirectUris[0],
      params,
      {
        state:         req.session.oauthState,
        code_verifier: req.session.codeVerifier
      }
    );

    xero.setTokenSet(tokenSet);
    await xero.updateTenants();

    for (const tenant of xero.tenants) {
      cache.cacheToken(tenant.tenantId, tenant.tenantName, tokenSet.access_token, tokenSet.expires_at);
    }

    const tenantNames = xero.tenants.map(t => t.tenantName).join(', ');
    logger.info('OAuth success', { userId: req.session.userId, tenants: tenantNames });
    res.redirect('/dashboard');
  } catch (err) {
    logger.error('OAuth callback error', { error: err.message });
    res.status(500).json({ error: 'Authentication failed', detail: err.message });
  }
});

// Step 3: Disconnect a tenant
router.delete('/disconnect/:tenantId', async (req, res) => {
  try {
    cache.removeTenant(req.params.tenantId);
    res.json({ success: true });
  } catch (err) {
    logger.error('Disconnect failed', { error: err.message });
    res.status(500).json({ error: 'Disconnect failed' });
  }
});

module.exports = router;
