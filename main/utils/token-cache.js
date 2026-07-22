const logger = require('./logger');
const db     = require('../db');

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
    if (tenantName) {
      // Persist just the connected-org record (never the token itself) so the
      // Admin Monitoring tab can show "connected" across a server restart.
      try {
        db.prepare(`
          INSERT INTO xero_tenants (user_id, tenant_id, tenant_name, connected_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, tenant_id) DO UPDATE SET tenant_name = excluded.tenant_name
        `).run(userId, tenantId, tenantName, new Date().toISOString());
      } catch (err) {
        logger.warn('Failed to persist xero_tenants row', { error: err.message, userId });
      }
    }
  }

  function removeTenant(tenantId) {
    delete cache.tokens[tenantId];
    const idx = cache.tenants.findIndex(t => t.tenant_id === tenantId);
    if (idx > -1) cache.tenants.splice(idx, 1);
    try {
      db.prepare('DELETE FROM xero_tenants WHERE user_id = ? AND tenant_id = ?').run(userId, tenantId);
    } catch (err) {
      logger.warn('Failed to remove persisted xero_tenants row', { error: err.message, userId });
    }
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

// Read-only: the last-known connected orgs for a user, persisted across restarts.
// Used only for display (Admin Monitoring tab) — never for deciding whether a live
// token is available, since access tokens themselves are never persisted.
function getPersistedTenants(userId) {
  return db.prepare('SELECT tenant_id AS tenantId, tenant_name AS tenantName, connected_at AS connectedAt FROM xero_tenants WHERE user_id = ?')
    .all(userId);
}

module.exports = { forUser, getPersistedTenants };
