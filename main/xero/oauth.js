const axios  = require('axios');
const logger = require('../utils/logger');
const oauthState = require('../utils/oauth-state');
const {
  OAUTH_SCOPES, BASE_OAUTH_SCOPES, OPTIONAL_SCOPE_GROUPS, OPTIONAL_REPORT_SCOPES, XeroReconnectError, reconnectReason,
  tokenErrorCode, credentialFingerprint, grantedScopesFrom, xeroErrMsg,
} = require('./xero-utils');

// offline_access is what actually grants a refresh token — without it Xero only
// ever hands back a 30-minute access token with no way to renew it silently.
//
// All granular (post-March-2026) scopes — Xero split the old broad
// accounting.transactions/accounting.reports.read into per-resource scopes and
// apps created after that cutoff can't request the broad ones at all, so this
// app only ever uses the granular names. Adding banktransactions/reports scopes
// here means anyone who already connected under the old, narrower list needs to
// click "Connect to Xero" again — Xero fixes scopes at consent time, an existing
// token doesn't retroactively gain new permissions.
// budgetsummary.read backs the Budget vs Actual report's budget columns —
// Reports/BudgetSummary returns the OVERALL budget as a sectioned report tree,
// the same shape as ProfitAndLoss, which is what makes the two mergeable
// column-for-column. budgets.read isn't needed for that report, but it's the
// only way to enumerate budgets or read tracking-category ones, and requesting
// it now avoids a SECOND reconnect later for anyone who reconnects today.
// accounting.attachments (in OAUTH_SCOPES) lets a posted bill carry its PDF and
// a claim its receipt; a connection made before it was added must reconnect
// once for attachments to work, and posts without them until then. The scopes
// Xero granted are recorded at connect and on every refresh, so
// GET /api/xero/connection can name what such a connection is missing.
const SCOPES = `offline_access ${OAUTH_SCOPES}`;
// What every consent asks for whatever is ticked in Setup: the scopes the app
// cannot work without, plus attachments, which every Web app may ask for.
const BASE_SCOPES = `offline_access ${BASE_OAUTH_SCOPES}`;
const GROUP_KEYS  = Object.keys(OPTIONAL_SCOPE_GROUPS);
const AUTHORIZE_URL  = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL      = 'https://identity.xero.com/connect/token';
const REVOCATION_URL = 'https://identity.xero.com/connect/revocation';

// Each user brings their own Xero "Web app" (own Client ID/Secret), same per-user
// model as Custom Connection. Xero counts its rate limits per app (and per
// organisation within it), so per-user apps give each user their own allowance
// instead of every user drawing on one deployment-wide app. Only the redirect URI
// is shared — it's a property of this server's deployment, not of any one user
// (see routes/setup.js GLOBAL_SECTIONS.xeroOAuth), and every user's Web app
// registers the same one.
function _appCreds(userId) {
  const { getUserConfig } = require('../utils/users');
  const config       = getUserConfig(userId);
  const clientId     = config.XERO_OAUTH_CLIENT_ID;
  const clientSecret = config.XERO_OAUTH_CLIENT_SECRET;
  const redirectUri  = process.env.XERO_OAUTH_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error('Xero OAuth redirect URI is not configured — an admin needs to set XERO_OAUTH_REDIRECT_URI in Setup.');
  }
  if (!clientId || !clientSecret) {
    throw new Error('Xero OAuth is not configured — add your Xero Web app\'s Client ID and Secret in Setup.');
  }
  return { clientId, clientSecret, redirectUri };
}

function _basicAuth(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

// The scopes of the named optional groups (xero-utils OPTIONAL_SCOPE_GROUPS),
// in the order the groups are defined; an unknown key contributes nothing.
function groupScopes(keys) {
  return GROUP_KEYS.filter(k => (keys || []).includes(k)).flatMap(k => OPTIONAL_SCOPE_GROUPS[k].scopes);
}

// The scopes a consent link asks for: the base set plus the given optional
// groups — every group when none is named, as before groups existed — less
// any scope Xero has refused this app. Asking for a refused one again would
// send the person to Xero's own "invalid_scope" page, which never comes back.
function _scopesFor(userId, groups) {
  const refused = new Set(require('../utils/token-cache').getHealth(userId).refusedScopes || []);
  const wanted  = [...BASE_SCOPES.split(' '), ...groupScopes(groups === undefined ? GROUP_KEYS : groups)];
  return [...new Set(wanted)].filter(s => s && !refused.has(s)).join(' ');
}

// The consent link. `groups` names the optional groups to ask for; the state
// carries them, so the callback knows which ones were asked for this time and
// can tell a group the person left out from one Xero refused.
function buildAuthorizeUrl(userId, { groups } = {}) {
  const { clientId, redirectUri } = _appCreds(userId);
  const asked = groups === undefined ? [...GROUP_KEYS] : GROUP_KEYS.filter(k => groups.includes(k));
  const state = oauthState.create(userId, { groups: asked });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope:         _scopesFor(userId, asked),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ── Which optional scopes this app may ask for ───────────────────────────────
// An app Xero will not let ask for a scope is not told so at the callback:
// Xero's authorize page answers on its own site ("Error: invalid_scope,
// Error code: 500") and the browser never comes back, so Connect simply
// looked broken. Confirmed against Xero on 2026-10-11: the authorize endpoint
// answers an unauthenticated GET with a 302 — to /identity/user/login when it
// accepts the request (the scopes included), to /identity/error?errorId=…
// when it does not. That is the same request the browser makes when a person
// presses Connect, with no secret, no cookie and nothing signed in, so it can
// be asked in advance: the base set first (a refusal there is a problem with
// the app's own settings, such as its redirect URI, and says nothing about
// the optional scopes), then the base set plus each optional group.

const PROBE_TTL_MS     = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;

// Pure. What one answer from the authorize endpoint says: 'available',
// 'refused' or 'unknown'. Only a redirect is read as an answer; anything else
// — a challenge page, an outage, a changed site — is unknown, never refused.
function classifyAuthorizeAnswer(status, location, body = '') {
  const loc = String(location || '');
  if (status >= 300 && status < 400) {
    if (/\/identity\/user\/login\b|[?&]ReturnUrl=/i.test(loc)) return 'available';
    if (/\/identity\/error\b|[?&]errorId=|invalid_scope/i.test(loc)) return 'refused';
    return 'unknown';
  }
  if (/invalid_scope|invalid scope/i.test(String(body || ''))) return 'refused';
  return 'unknown';
}

async function _askAuthorize(clientId, redirectUri, scope) {
  try {
    const res = await axios.get(AUTHORIZE_URL, {
      params:         { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope, state: 'probe' },
      maxRedirects:   0,
      validateStatus: () => true,
      timeout:        PROBE_TIMEOUT_MS,
      headers:        { Accept: 'text/html' },
    });
    return classifyAuthorizeAnswer(res.status, res.headers?.location, typeof res.data === 'string' ? res.data : '');
  } catch (_) {
    return 'unknown';
  }
}

// Asks Xero's authorize page which optional groups this user's Web app may
// ask for, and records the answer: { at, fingerprint, base, groups: { live,
// balance } }, each 'available' | 'refused' | 'unknown'. A group found
// refused has its scopes recorded as refused (left out of every later link
// and of the "missing" list); one found available has any old refusal lifted.
// Reused for a day per Client ID and redirect URI; `force` asks again.
// userId -> the probe running for them, so a Setup page and the banner
// polling at the same moment ask Xero once, not twice.
const _probing = new Map();

async function probeOptionalScopes(userId, { force = false } = {}) {
  const tokenCache = require('../utils/token-cache');
  const { clientId, redirectUri } = _appCreds(userId);
  const fingerprint = credentialFingerprint(clientId, redirectUri);
  const last = tokenCache.getHealth(userId).scopeProbe;
  const fresh = last && last.fingerprint === fingerprint && Date.now() - Date.parse(last.at) < PROBE_TTL_MS;
  if (!force && fresh) return last;

  let running = _probing.get(userId);
  if (!running) {
    running = _probe(userId, clientId, redirectUri, fingerprint).finally(() => _probing.delete(userId));
    _probing.set(userId, running);
  }
  return running;
}

async function _probe(userId, clientId, redirectUri, fingerprint) {
  const tokenCache = require('../utils/token-cache');
  const base = await _askAuthorize(clientId, redirectUri, BASE_SCOPES);
  const groups = {};
  for (const key of GROUP_KEYS) {
    groups[key] = base === 'available'
      ? await _askAuthorize(clientId, redirectUri, `${BASE_SCOPES} ${groupScopes([key]).join(' ')}`)
      : 'unknown';
  }
  for (const key of GROUP_KEYS) {
    if (groups[key] === 'refused')   tokenCache.markScopesRefused(userId, groupScopes([key]), { reason: 'refused at the authorize page' });
    if (groups[key] === 'available') tokenCache.markScopesAllowed(userId, groupScopes([key]));
  }
  const probe = { at: new Date().toISOString(), fingerprint, base, groups };
  tokenCache.saveScopeProbe(userId, probe);
  logger.info('Asked Xero which optional permissions this app may request', { userId, base, ...groups });
  return probe;
}

// The consent link for Connect, with what it asks for. `extras` is the list
// of optional groups ticked in Setup; null means the person has not said, and
// then every group the probe found available is asked for. A group the probe
// found refused is never asked for, ticked or not — it is reported in
// `excluded` instead — and a group it could not settle is asked for only when
// ticked. Never throws over the probe: a probe that fails is 'unknown'.
async function authorizeFor(userId, { extras = null, force = false } = {}) {
  let probe = null;
  try {
    probe = await probeOptionalScopes(userId, { force });
  } catch (err) {
    // _appCreds refusing (no Client ID, no redirect URI) is said by
    // buildAuthorizeUrl below, in the words the Setup page already shows.
    if (!/not configured/i.test(err.message)) logger.warn('Could not ask Xero which permissions this app may request', { userId, error: err.message });
  }
  const status = key => (probe && probe.groups && probe.groups[key]) || 'unknown';
  const wanted = Array.isArray(extras)
    ? GROUP_KEYS.filter(k => extras.includes(k))
    : GROUP_KEYS.filter(k => status(k) === 'available');
  const excluded = {};
  for (const key of wanted) if (status(key) === 'refused') excluded[key] = 'refused';
  const requested = wanted.filter(k => !excluded[k]);
  return { url: buildAuthorizeUrl(userId, { groups: requested }), requested, excluded, probe };
}

// ── A consent Xero refuses for its scopes ───────────────────────────────────
// The balance sheet and trial balance scopes are granular ones not every Xero
// app may ask for. When an app may not, Xero does not show the consent screen
// at all: the browser comes straight back to the callback with
// error=invalid_scope (sometimes with an error_description naming the scope),
// and before this the person saw a bare "connection failed" with no way past
// it. So the callback asks once more without those two scopes — never the
// required ones, which cannot be dropped, and never attachments or journals,
// which Xero has not refused — and records what was dropped so the next link
// and the connection status know.

// Pure. The scopes to drop for the error Xero sent back to the callback, or
// null when the error is not about scopes (a person declining consent is
// access_denied, and that is their answer, not something to retry). An
// error_description naming a scope counts whatever the error code, since
// Xero's wording has varied; one naming only a required scope is still a
// refusal, but there is nothing optional to drop for it, so it is null too.
//
// `requested` is the optional scopes that link asked for, when known (the
// state carries the groups). A refusal naming no scope then drops all of
// them, since any could be the one; with no record of what was asked, the
// report scopes are dropped, as before groups existed.
function scopeRefusal(query, requested = null) {
  const error = String(query?.error || '');
  const description = String(query?.error_description || '');
  const named = description.match(/[a-z]+\.[a-z.]+/gi) || [];
  const aboutScopes = error === 'invalid_scope' || named.some(s => /^(accounting|offline_access|payroll|files|assets|projects)\b/i.test(s));
  if (!aboutScopes) return null;
  const optional = groupScopes(GROUP_KEYS);
  const namedOptional = named.map(s => s.toLowerCase()).filter(s => optional.includes(s));
  if (named.length && !namedOptional.length) return null;
  // A group is asked for and refused as one: the Balance Sheet tab needs both
  // of its scopes, so naming either drops both.
  const whole = scopes => groupScopes(GROUP_KEYS.filter(k => OPTIONAL_SCOPE_GROUPS[k].scopes.some(s => scopes.includes(s))));
  if (Array.isArray(requested)) {
    const asked = requested.filter(s => optional.includes(s));
    const drop  = (namedOptional.length ? whole(namedOptional) : asked).filter(s => asked.includes(s));
    return drop.length ? drop : null;
  }
  if (namedOptional.length) return whole(namedOptional);
  return [...OPTIONAL_REPORT_SCOPES];
}

// Records `scopes` as refused and returns a consent link without them, or
// null when they were already recorded — which is how the retry happens at
// most once: the link that came back refused was itself built without them,
// so asking a third time would ask the same question. Nothing privileged
// happens here: the link is the same one GET /oauth/connect mints for this
// user, and completing it still takes POST /oauth/complete as that user.
// `groups` is what the refused link asked for; the retry asks for the same
// less the refused ones.
function retryAuthorizeUrl(userId, scopes, groups = undefined) {
  const tokenCache = require('../utils/token-cache');
  const already = new Set(tokenCache.getHealth(userId).refusedScopes || []);
  if (scopes.every(s => already.has(s))) return null;
  tokenCache.markScopesRefused(userId, scopes, { reason: 'refused at the callback' });
  logger.warn('Xero refused optional scopes for this app — asking for consent again without them', { userId, scopes });
  const keep = groups === undefined ? undefined : groups.filter(k => !groupScopes([k]).some(s => scopes.includes(s)));
  return buildAuthorizeUrl(userId, { groups: keep });
}

async function exchangeCodeForTokens(userId, code) {
  const { clientId, clientSecret, redirectUri } = _appCreds(userId);

  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    {
      headers: { Authorization: _basicAuth(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    }
  );

  return {
    access_token:   res.data.access_token,
    refresh_token:  res.data.refresh_token,
    expires_at:     new Date(Date.now() + res.data.expires_in * 1000),
    granted_scopes: grantedScopesFrom(res.data),
  };
}

// userId -> in-flight refresh. Xero rotates the refresh token on every use, so
// two refreshes racing with the same token (the token cache's expiry refresh,
// its cold-cache reconnect, the keep-alive job, a Setup test) could have the
// loser refused with invalid_grant — and a refusal now marks the connection as
// needing a reconnect, so a lost race must not look like one. Everyone in this
// process who wants a refresh while one is running shares its result.
const _refreshing = new Map();

// Xero rotates the refresh token on EVERY use — the previous one stops working the
// instant a new one is issued. The new token must be persisted before this function
// returns, or the connection silently breaks the next time a refresh is needed.
//
// A refusal that only a person can fix (invalid_grant: revoked, or 60 days
// without a refresh) is recorded and thrown as XeroReconnectError. After that,
// automatic attempts with the same credentials fail at once without asking
// Xero again; `force` (the Setup test, a person asking) tries regardless.
function refreshAuthCodeToken(userId, { force = false } = {}) {
  let inFlight = _refreshing.get(userId);
  if (!inFlight) {
    inFlight = _refresh(userId, { force }).finally(() => _refreshing.delete(userId));
    _refreshing.set(userId, inFlight);
  }
  return inFlight;
}

async function _refresh(userId, { force }) {
  const { getUserConfig, saveUserConfig } = require('../utils/users');
  const tokenCache = require('../utils/token-cache');
  const { clientId, clientSecret } = _appCreds(userId);
  const refreshToken = getUserConfig(userId).XERO_OAUTH_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('No Xero OAuth connection on file — reconnect via Setup.');
  }

  const fingerprint = credentialFingerprint(clientId, clientSecret, refreshToken);
  const health = tokenCache.getHealth(userId);
  if (!force && health.needsReconnect && health.fingerprint === fingerprint) {
    throw new XeroReconnectError(health.reason);
  }

  let res;
  try {
    res = await axios.post(
      TOKEN_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      {
        headers: { Authorization: _basicAuth(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );
  } catch (err) {
    const reason = reconnectReason(err);
    if (!reason) throw err;
    tokenCache.markNeedsReconnect(userId, { method: 'oauth', reason, fingerprint });
    logger.warn('Xero refused the stored OAuth credentials — the connection needs reconnecting', {
      userId, oauthError: tokenErrorCode(err),
    });
    throw new XeroReconnectError(reason, { cause: err, oauthError: tokenErrorCode(err) });
  }

  saveUserConfig(userId, { XERO_OAUTH_REFRESH_TOKEN: res.data.refresh_token });
  tokenCache.markRefreshed(userId, { method: 'oauth', grantedScopes: grantedScopesFrom(res.data) });

  return {
    access_token: res.data.access_token,
    expires_at:   new Date(Date.now() + res.data.expires_in * 1000),
  };
}

// Disconnect: tells Xero to revoke the refresh token, which also ends the
// app's access to every organisation it covered. Clearing it only locally left
// the grant alive on Xero's side — still listed under the user's connected
// apps, and usable by anyone holding a copy of the token. Best-effort: a
// failure is logged and answered with false, never thrown, because the local
// disconnect must go ahead regardless.
async function revokeRefreshToken(userId) {
  // A refresh still in flight would otherwise save a fresh token after this
  // revoked the old one.
  const inFlight = _refreshing.get(userId);
  if (inFlight) await inFlight.catch(() => {});

  try {
    const { getUserConfig } = require('../utils/users');
    const config       = getUserConfig(userId);
    const refreshToken = config.XERO_OAUTH_REFRESH_TOKEN;
    const clientId     = config.XERO_OAUTH_CLIENT_ID;
    const clientSecret = config.XERO_OAUTH_CLIENT_SECRET;
    if (!refreshToken) return false;
    if (!clientId || !clientSecret) {
      logger.warn('Xero OAuth token not revoked — no Client ID/Secret on file to authenticate the revocation', { userId });
      return false;
    }
    await axios.post(
      REVOCATION_URL,
      new URLSearchParams({ token: refreshToken }),
      {
        headers: { Authorization: _basicAuth(clientId, clientSecret), 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );
    logger.info('Xero OAuth refresh token revoked', { userId });
    return true;
  } catch (err) {
    logger.warn('Xero OAuth token revocation failed — disconnecting locally anyway', { userId, error: xeroErrMsg(err) });
    return false;
  }
}

async function _listAndCacheTenants(userId, access_token, expires_at) {
  const tokenCache = require('../utils/token-cache').forUser(userId);

  const connRes = await axios.get('https://api.xero.com/connections', {
    headers: { Authorization: `Bearer ${access_token}` },
    timeout: 10000,
  });

  const tenants = connRes.data;
  if (!tenants.length) {
    throw new Error('Xero OAuth succeeded but no organisations were authorized — try connecting again and select at least one organisation.');
  }

  for (const tenant of tenants) {
    tokenCache.cacheToken(tenant.tenantId, tenant.tenantName, access_token, expires_at, 'oauth');
    logger.info('Xero org connected via OAuth', { tenantName: tenant.tenantName, userId });
  }
  tokenCache.pruneTenants(tenants.map(t => t.tenantId));
  return tenants;
}

// Called once, right after the user completes Xero's consent screen and the
// callback route receives a `code`.
//
// `groups` is the optional groups the consent link asked for (from its
// state). A group it did not ask for, and the token does not carry, is
// recorded as declined: the person's choice, which the connection status
// reports as such rather than as something a reconnect would fix.
async function completeConnection(userId, code, { groups } = {}) {
  const { saveUserConfig } = require('../utils/users');
  const tokenCache = require('../utils/token-cache');
  logger.info('Completing Xero OAuth connection...', { userId });

  const { access_token, refresh_token, expires_at, granted_scopes } = await exchangeCodeForTokens(userId, code);

  saveUserConfig(userId, {
    XERO_OAUTH_REFRESH_TOKEN: refresh_token,
    XERO_CONNECTION_TYPE:     'oauth',
    XERO_OAUTH_CONNECTED_AT:  new Date().toISOString(),
  });
  // A fresh consent replaces whatever was wrong with the old connection, and
  // says which scopes this one has.
  tokenCache.markRefreshed(userId, { method: 'oauth', grantedScopes: granted_scopes });
  if (Array.isArray(groups)) {
    const granted = new Set(Array.isArray(granted_scopes) ? granted_scopes : []);
    const left = groupScopes(GROUP_KEYS.filter(k => !groups.includes(k))).filter(s => !granted.has(s));
    if (left.length) tokenCache.markScopesDeclined(userId, left);
  }

  return _listAndCacheTenants(userId, access_token, expires_at);
}

// The OAuth analogue of connect.js's autoConnect() — used when the in-memory token
// cache is empty (e.g. after a server restart) but a refresh token is on file, so
// the connection can be silently re-established without the user doing anything.
// `force` is for a person testing the connection (see refreshAuthCodeToken).
async function reconnect(userId, { force = false } = {}) {
  logger.info('Reconnecting to Xero via stored refresh token...', { userId });
  const { access_token, expires_at } = await refreshAuthCodeToken(userId, { force });
  return _listAndCacheTenants(userId, access_token, expires_at);
}

module.exports = {
  buildAuthorizeUrl, authorizeFor, probeOptionalScopes, classifyAuthorizeAnswer, groupScopes, scopeRefusal, retryAuthorizeUrl,
  exchangeCodeForTokens, refreshAuthCodeToken, revokeRefreshToken, completeConnection, reconnect,
  SCOPES, BASE_SCOPES, GROUP_KEYS, PROBE_TTL_MS, REVOCATION_URL,
};
