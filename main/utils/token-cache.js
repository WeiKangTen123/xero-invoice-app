const logger = require('./logger');

// Per-user in-memory token cache.
// Keyed by userId → { tokens: { [tenantId]: { access_token, expires_at } }, tenants: [...] }
const _userCaches = new Map();

function _getCache(userId) {
  if (!_userCaches.has(userId)) {
    _userCaches.set(userId, { tokens: {}, tenants: [] });
  }
  return _userCaches.get(userId);
}

function forUser(userId) {
  const cache = _getCache(userId);

  function cacheToken(tenantId, tenantName, access_token, expires_at) {
    cache.tokens[tenantId] = { access_token, expires_at: new Date(expires_at).getTime() };
    if (tenantName && !cache.tenants.find(t => t.tenant_id === tenantId)) {
      cache.tenants.push({ tenant_id: tenantId, tenant_name: tenantName });
    }
  }

  function removeTenant(tenantId) {
    delete cache.tokens[tenantId];
    const idx = cache.tenants.findIndex(t => t.tenant_id === tenantId);
    if (idx > -1) cache.tenants.splice(idx, 1);
    logger.info('Tenant removed from cache', { tenantId, userId });
  }

  async function getValidToken(tenantId) {
    const mem = cache.tokens[tenantId];
    if (!mem) throw new Error(`No Xero token for tenant ${tenantId} — reconnect Xero first`);
    if (Date.now() < mem.expires_at - 60_000) return mem.access_token;

    logger.info('Token expired — refreshing', { tenantId, userId });
    const { refreshClientCredentialsToken } = require('../xero/connect');
    const { access_token, expires_at } = await refreshClientCredentialsToken(userId);
    cacheToken(tenantId, null, access_token, expires_at);
    return access_token;
  }

  function getAllTenants() { return cache.tenants; }

  function clear() { cache.tokens = {}; cache.tenants = []; }

  return { cacheToken, removeTenant, getValidToken, getAllTenants, clear };
}

module.exports = { forUser };
