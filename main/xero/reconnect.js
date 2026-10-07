// Dispatches to whichever Xero connection method a user actually has active, so
// callers that just need "make sure this user has a live Xero connection" (invoice
// submission's reconnect-on-empty-cache path) don't need to know or care which one.
async function reconnectXero(userId) {
  const { getUserConfig } = require('../utils/users');
  const config = getUserConfig(userId);
  return config.XERO_CONNECTION_TYPE === 'oauth'
    ? require('./oauth').reconnect(userId)
    : require('./connect').autoConnect(userId);
}

// Which method is in use: 'oauth' once a consent flow has completed (until a
// Disconnect), otherwise 'custom' when Custom Connection is recorded or its
// credentials are saved — the same rule reconnectXero follows — else null.
function connectionMethod(config = {}) {
  if (config.XERO_CONNECTION_TYPE === 'oauth') return 'oauth';
  if (config.XERO_CONNECTION_TYPE === 'custom' || (config.XERO_CLIENT_ID && config.XERO_CLIENT_SECRET)) return 'custom';
  return null;
}

const NO_OAUTH_TOKEN_REASON  = 'There is no Xero login on file for this account. Connect Xero in Setup.';
const NO_OAUTH_APP_REASON    = "Your Xero Web app's Client ID or Secret is missing. Add them in Setup, then connect again.";
const NO_CUSTOM_CREDS_REASON = 'Your Custom Connection Client ID or Secret is missing. Add them in Setup.';

/**
 * The state of this user's Xero connection, for the app-wide banner. Read from
 * what is on file — it never calls Xero, so it is cheap to poll.
 *
 *   method          'oauth' | 'custom' | null
 *   connected       true when the connection is believed to work: a method,
 *                   nothing Xero has refused, and at least one organisation
 *   needsReconnect  a person has to act (reconnect, or fix credentials)
 *   reason          why, in words for that person; null when nothing is wrong
 *   missingScopes   OAuth scopes the app asks for that this connection was
 *                   not granted (it predates them); always [] for Custom
 *                   Connection and when the granted scopes are not known yet
 */
function getConnectionStatus(userId) {
  const { getUserConfig } = require('../utils/users');
  const tokenCache = require('../utils/token-cache');
  const config = getUserConfig(userId) || {};
  const method = connectionMethod(config);
  if (!method) return { method: null, connected: false, needsReconnect: false, reason: null, missingScopes: [] };

  const health  = (typeof tokenCache.getHealth === 'function' && tokenCache.getHealth(userId)) || {};
  const tenants = tokenCache.getPersistedTenants(userId) || [];

  let reason = null;
  if (method === 'oauth') {
    if (!config.XERO_OAUTH_REFRESH_TOKEN) reason = NO_OAUTH_TOKEN_REASON;
    else if (!config.XERO_OAUTH_CLIENT_ID || !config.XERO_OAUTH_CLIENT_SECRET) reason = NO_OAUTH_APP_REASON;
  } else if (!config.XERO_CLIENT_ID || !config.XERO_CLIENT_SECRET) {
    reason = NO_CUSTOM_CREDS_REASON;
  }
  // A refusal recorded for the other method says nothing about this one, and
  // one recorded for credentials since replaced (a new secret saved, a fresh
  // consent) no longer applies — the next attempt will ask Xero again.
  if (!reason && health.needsReconnect && (!health.method || health.method === method)) {
    const { credentialFingerprint, DEFAULT_RECONNECT_REASON } = require('./xero-utils');
    const current = method === 'oauth'
      ? credentialFingerprint(config.XERO_OAUTH_CLIENT_ID, config.XERO_OAUTH_CLIENT_SECRET, config.XERO_OAUTH_REFRESH_TOKEN)
      : credentialFingerprint(config.XERO_CLIENT_ID, config.XERO_CLIENT_SECRET);
    if (!health.fingerprint || health.fingerprint === current) reason = health.reason || DEFAULT_RECONNECT_REASON;
  }

  let missingScopes = [];
  if (method === 'oauth' && Array.isArray(health.grantedScopes)) {
    const granted = new Set(health.grantedScopes);
    missingScopes = require('./oauth').SCOPES.split(' ').filter(s => s && !granted.has(s));
  }

  const needsReconnect = !!reason;
  return {
    method,
    connected: !needsReconnect && tenants.length > 0,
    needsReconnect,
    reason,
    missingScopes,
  };
}

// Setup's "Test" button: a real round trip to Xero on whichever method is
// active, without changing which one that is. It used to run Custom
// Connection only and set the type to 'custom' on success, so an OAuth user
// pressing Test was moved off OAuth. `force` asks Xero even when it refused
// these credentials before — a person pressing Test wants a fresh answer.
async function testConnection(userId) {
  const { getUserConfig } = require('../utils/users');
  const method = connectionMethod(getUserConfig(userId) || {});
  const tenants = method === 'oauth'
    ? await require('./oauth').reconnect(userId, { force: true })
    : await require('./connect').autoConnect(userId, { force: true });
  return { method: method || 'custom', tenants };
}

module.exports = { reconnectXero, getConnectionStatus, testConnection, connectionMethod };
