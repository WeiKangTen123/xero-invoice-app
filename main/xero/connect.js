const axios  = require('axios');
const logger = require('../utils/logger');

// The scope list lives with the other Xero helpers so OAuth and Custom
// Connection cannot drift apart again (they had: budgets were OAuth-only).
// accounting.attachments is the one deliberate difference: it is not asked
// for here, because Xero refuses a client-credentials request that names a
// scope the connection was never granted, and that would stop every Custom
// Connection set up without it from connecting at all (see xero-utils.js).
const {
  SCOPES, XeroReconnectError, reconnectReason, tokenErrorCode, credentialFingerprint,
} = require('./xero-utils');

// A refused Client ID or Secret (invalid_client) is recorded the same way as a
// dead OAuth refresh token: every request used to ask Xero again with the same
// credentials and show a bare 400. Automatic attempts with the credentials Xero
// refused now fail at once; saving different ones in Setup lets the next one
// through, and `force` (a person pressing Test) always asks Xero.
async function refreshClientCredentialsToken(userId, { force = false } = {}) {
  const { getUserConfig } = require('../utils/users');
  const tokenCache   = require('../utils/token-cache');
  const config       = getUserConfig(userId);
  const clientId     = config.XERO_CLIENT_ID;
  const clientSecret = config.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Xero credentials not configured — go to Setup to add your Client ID and Secret.');
  }

  const fingerprint = credentialFingerprint(clientId, clientSecret);
  const health = tokenCache.getHealth(userId);
  if (!force && health.needsReconnect && health.fingerprint === fingerprint) {
    throw new XeroReconnectError(health.reason);
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let res;
  try {
    res = await axios.post(
      'https://identity.xero.com/connect/token',
      new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPES }),
      {
        headers: {
          Authorization:  `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );
  } catch (err) {
    const reason = reconnectReason(err);
    if (!reason) throw err;
    tokenCache.markNeedsReconnect(userId, { method: 'custom', reason, fingerprint });
    logger.warn('Xero refused the Custom Connection credentials', { userId, oauthError: tokenErrorCode(err) });
    throw new XeroReconnectError(reason, { cause: err, oauthError: tokenErrorCode(err) });
  }

  tokenCache.markRefreshed(userId, { method: 'custom' });

  return {
    access_token: res.data.access_token,
    expires_at:   new Date(Date.now() + res.data.expires_in * 1000),
  };
}

async function autoConnect(userId, { force = false } = {}) {
  logger.info('Connecting to Xero via client credentials...', { userId });
  const tokenCache = require('../utils/token-cache').forUser(userId);

  const { access_token, expires_at } = await refreshClientCredentialsToken(userId, { force });

  const connRes = await axios.get('https://api.xero.com/connections', {
    headers: { Authorization: `Bearer ${access_token}` },
    timeout: 10000,
  });

  const tenants = connRes.data;
  if (!tenants.length) {
    throw new Error(
      'No Xero organisations connected. ' +
      'Go to developer.xero.com → your Custom Connection app → Connection management → add your Xero org.'
    );
  }

  for (const tenant of tenants) {
    tokenCache.cacheToken(tenant.tenantId, tenant.tenantName, access_token, expires_at, 'custom');
    logger.info('Xero org connected', { tenantName: tenant.tenantName, userId });
  }
  tokenCache.pruneTenants(tenants.map(t => t.tenantId));

  // Records Custom Connection as the method when none is on file yet, but never
  // takes over from an OAuth connection. This used to set 'custom' on every
  // success, so pressing Test in Setup quietly switched an OAuth user to
  // whichever Custom Connection credentials happened to be saved. Moving from
  // OAuth to Custom Connection is a Disconnect first.
  const users = require('../utils/users');
  if (users.getUserConfig(userId).XERO_CONNECTION_TYPE !== 'oauth') {
    users.saveUserConfig(userId, { XERO_CONNECTION_TYPE: 'custom' });
  }

  return tenants;
}

module.exports = { autoConnect, refreshClientCredentialsToken, SCOPES };
