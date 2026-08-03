const axios  = require('axios');
const logger = require('../utils/logger');

const SCOPES = 'accounting.invoices accounting.contacts accounting.settings.read';

async function refreshClientCredentialsToken(userId) {
  const { getUserConfig } = require('../utils/users');
  const config       = getUserConfig(userId);
  const clientId     = config.XERO_CLIENT_ID;
  const clientSecret = config.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Xero credentials not configured — go to Setup to add your Client ID and Secret.');
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res   = await axios.post(
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

  return {
    access_token: res.data.access_token,
    expires_at:   new Date(Date.now() + res.data.expires_in * 1000),
  };
}

async function autoConnect(userId) {
  logger.info('Connecting to Xero via client credentials...', { userId });
  const tokenCache = require('../utils/token-cache').forUser(userId);

  const { access_token, expires_at } = await refreshClientCredentialsToken(userId);

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

  // A successful Custom Connection means this is now the active method — flips a
  // user back from 'oauth' if they'd previously connected that way and are now
  // re-testing/using Custom Connection instead.
  require('../utils/users').saveUserConfig(userId, { XERO_CONNECTION_TYPE: 'custom' });

  return tenants;
}

module.exports = { autoConnect, refreshClientCredentialsToken };
