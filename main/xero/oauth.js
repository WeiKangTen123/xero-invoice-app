const axios  = require('axios');
const logger = require('../utils/logger');
const oauthState = require('../utils/oauth-state');

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
const SCOPES = 'offline_access accounting.invoices accounting.contacts accounting.settings.read '
  + 'accounting.banktransactions.read accounting.reports.profitandloss.read accounting.reports.banksummary.read '
  + 'accounting.payments.read accounting.reports.budgetsummary.read accounting.budgets.read';
const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL      = 'https://identity.xero.com/connect/token';

// Each user brings their own Xero "Web app" (own Client ID/Secret), same per-user
// model as Custom Connection — Xero's 60-calls/minute rate limit is per-app, so
// per-user apps give each user an independent budget instead of every user sharing
// one deployment-wide pool. Only the redirect URI is shared — it's a property of
// this server's deployment, not of any one user (see routes/setup.js
// GLOBAL_SECTIONS.xeroOAuth), and every user's Web app registers the same one.
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

function buildAuthorizeUrl(userId) {
  const { clientId, redirectUri } = _appCreds(userId);
  const state = oauthState.create(userId);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope:         SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(userId, code) {
  const { clientId, clientSecret, redirectUri } = _appCreds(userId);
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    {
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    }
  );

  return {
    access_token:  res.data.access_token,
    refresh_token: res.data.refresh_token,
    expires_at:    new Date(Date.now() + res.data.expires_in * 1000),
  };
}

// Xero rotates the refresh token on EVERY use — the previous one stops working the
// instant a new one is issued. The new token must be persisted before this function
// returns, or the connection silently breaks the next time a refresh is needed.
async function refreshAuthCodeToken(userId) {
  const { getUserConfig, saveUserConfig } = require('../utils/users');
  const { clientId, clientSecret } = _appCreds(userId);
  const refreshToken = getUserConfig(userId).XERO_OAUTH_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('No Xero OAuth connection on file — reconnect via Setup.');
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    {
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    }
  );

  saveUserConfig(userId, { XERO_OAUTH_REFRESH_TOKEN: res.data.refresh_token });

  return {
    access_token: res.data.access_token,
    expires_at:   new Date(Date.now() + res.data.expires_in * 1000),
  };
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
  return tenants;
}

// Called once, right after the user completes Xero's consent screen and the
// callback route receives a `code`.
async function completeConnection(userId, code) {
  const { saveUserConfig } = require('../utils/users');
  logger.info('Completing Xero OAuth connection...', { userId });

  const { access_token, refresh_token, expires_at } = await exchangeCodeForTokens(userId, code);

  saveUserConfig(userId, {
    XERO_OAUTH_REFRESH_TOKEN: refresh_token,
    XERO_CONNECTION_TYPE:     'oauth',
    XERO_OAUTH_CONNECTED_AT:  new Date().toISOString(),
  });

  return _listAndCacheTenants(userId, access_token, expires_at);
}

// The OAuth analogue of connect.js's autoConnect() — used when the in-memory token
// cache is empty (e.g. after a server restart) but a refresh token is on file, so
// the connection can be silently re-established without the user doing anything.
async function reconnect(userId) {
  logger.info('Reconnecting to Xero via stored refresh token...', { userId });
  const { access_token, expires_at } = await refreshAuthCodeToken(userId);
  return _listAndCacheTenants(userId, access_token, expires_at);
}

module.exports = { buildAuthorizeUrl, exchangeCodeForTokens, refreshAuthCodeToken, completeConnection, reconnect };
