// What a demo account is told wherever a Xero connection would be made,
// tested or dropped (routes/xero-oauth.js, routes/setup.js): it has none, by
// design, and its data is the generated Demo Company (xero/demo/api.js).
const DEMO_NO_XERO_MESSAGE = 'Demo account: sample data, no Xero connection.';

// Whether this is a demo account (users.js isDemoUser). users.js is required
// at call time, as everywhere in this file, and several tests stub it with
// only what they need: a stub without isDemoUser is a real account.
function _isDemo(userId) {
  const users = require('../utils/users');
  return typeof users.isDemoUser === 'function' && users.isDemoUser(userId);
}

// Dispatches to whichever Xero connection method a user actually has active, so
// callers that just need "make sure this user has a live Xero connection" (invoice
// submission's reconnect-on-empty-cache path) don't need to know or care which one.
// A demo account is always connected, to the Demo Company, with nothing to
// call: the token cache never asks for it to be reconnected, and anything
// else that does gets the company list a reconnect would give.
async function reconnectXero(userId) {
  const { getUserConfig } = require('../utils/users');
  if (_isDemo(userId)) return [{ ...require('./demo/api').DEMO_TENANT }];
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
 *   refusedScopes   scopes Xero would not let this app ask for at consent
 *                   (xero/oauth.js retryAuthorizeUrl); never in missingScopes,
 *                   since reconnecting cannot gain them
 *   refusedMessage  what to say about them, or null when there are none
 *   optional        for an OAuth connection, each optional group (xero-utils
 *                   OPTIONAL_SCOPE_GROUPS) as { label, scopes, status }; see
 *                   _groupStatus. null for Custom Connection, which never
 *                   asks for them
 *   probe           what Xero's authorize page last said this app may ask
 *                   for ({ at, base, groups }), or null
 */
const REFUSED_SCOPES_MESSAGE = 'Xero refused these permissions for this app';

// What became of one optional group, in the order that settles it:
//   granted   the connection carries every scope of the group
//   refused   Xero will not let this app ask for it (seen at consent, or
//             found by the probe) — no reconnect can add it
//   declined  the last Connect left it unticked — the person's choice
//   missing   never granted, and the probe found Xero would allow it: a
//             reconnect with it ticked adds it
//   unknown   not granted, and nothing says whether Xero would allow it —
//             asking might land on Xero's "invalid_scope" page, so nothing
//             nags anyone to try
function _groupStatus(scopes, health, probed) {
  const granted = Array.isArray(health.grantedScopes) ? new Set(health.grantedScopes) : null;
  if (granted && scopes.every(s => granted.has(s))) return 'granted';
  if (scopes.some(s => (health.refusedScopes || []).includes(s))) return 'refused';
  if (scopes.some(s => (health.declinedScopes || []).includes(s))) return 'declined';
  if (probed === 'refused')   return 'refused';
  if (probed === 'available') return 'missing';
  return 'unknown';
}

// A demo account's status: method 'demo', connected, nothing missing,
// refused or declined, every optional group granted (the Demo Company
// answers every report), and no probe, since there is no Web app to ask
// about. Whatever its config says: a Client ID typed into a demo account's
// Setup must not turn it into a Custom Connection.
function _demoStatus() {
  const { OPTIONAL_SCOPE_GROUPS } = require('./xero-utils');
  const optional = {};
  for (const [key, group] of Object.entries(OPTIONAL_SCOPE_GROUPS)) {
    optional[key] = { label: group.label, scopes: [...group.scopes], status: 'granted' };
  }
  return {
    method: 'demo', connected: true, needsReconnect: false, reason: null, missingScopes: [], refusedScopes: [], refusedMessage: null,
    optional, probe: null,
  };
}

function getConnectionStatus(userId) {
  const { getUserConfig } = require('../utils/users');
  const tokenCache = require('../utils/token-cache');
  if (_isDemo(userId)) return _demoStatus();
  const config = getUserConfig(userId) || {};
  const method = connectionMethod(config);
  const none = {
    method: null, connected: false, needsReconnect: false, reason: null, missingScopes: [], refusedScopes: [], refusedMessage: null,
    optional: null, probe: null,
  };
  if (!method) return none;

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

  // A refused scope is one no reconnect can gain, so it is not "missing" in
  // the sense the banner means (reconnect to get it); it is reported apart.
  const refusedScopes = method === 'oauth' && Array.isArray(health.refusedScopes) ? [...health.refusedScopes] : [];
  // Declined is the person's choice, so not "missing" either: a reconnect
  // would only add it if they tick it again.
  const declined = new Set(method === 'oauth' && Array.isArray(health.declinedScopes) ? health.declinedScopes : []);
  let missingScopes = [];
  if (method === 'oauth' && Array.isArray(health.grantedScopes)) {
    const granted = new Set(health.grantedScopes), refused = new Set(refusedScopes);
    missingScopes = require('./oauth').SCOPES.split(' ').filter(s => s && !granted.has(s) && !refused.has(s) && !declined.has(s));
  }

  let optional = null, probe = null;
  if (method === 'oauth') {
    const { OPTIONAL_SCOPE_GROUPS } = require('./xero-utils');
    const p = health.scopeProbe && typeof health.scopeProbe === 'object' ? health.scopeProbe : null;
    probe = p ? { at: p.at || null, base: p.base || 'unknown', groups: { ...(p.groups || {}) } } : null;
    optional = {};
    for (const [key, group] of Object.entries(OPTIONAL_SCOPE_GROUPS)) {
      optional[key] = {
        label:  group.label,
        scopes: [...group.scopes],
        status: _groupStatus(group.scopes, health, probe ? probe.groups[key] : null),
      };
    }
  }

  const needsReconnect = !!reason;
  return {
    method,
    connected: !needsReconnect && tenants.length > 0,
    needsReconnect,
    reason,
    missingScopes,
    refusedScopes,
    refusedMessage: refusedScopes.length ? REFUSED_SCOPES_MESSAGE : null,
    optional,
    probe,
  };
}

// Setup's "Test" button: a real round trip to Xero on whichever method is
// active, without changing which one that is. It used to run Custom
// Connection only and set the type to 'custom' on success, so an OAuth user
// pressing Test was moved off OAuth. `force` asks Xero even when it refused
// these credentials before — a person pressing Test wants a fresh answer.
async function testConnection(userId) {
  const { getUserConfig } = require('../utils/users');
  // Nothing to test, and nothing a test could set: a demo account's Setup
  // must not record a Custom Connection on it.
  if (_isDemo(userId)) throw new Error(DEMO_NO_XERO_MESSAGE);
  const method = connectionMethod(getUserConfig(userId) || {});
  const tenants = method === 'oauth'
    ? await require('./oauth').reconnect(userId, { force: true })
    : await require('./connect').autoConnect(userId, { force: true });
  return { method: method || 'custom', tenants };
}

module.exports = {
  reconnectXero, getConnectionStatus, testConnection, connectionMethod, REFUSED_SCOPES_MESSAGE, DEMO_NO_XERO_MESSAGE,
};
