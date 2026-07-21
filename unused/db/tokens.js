const pool = require('./pool');
const logger = require('../utils/logger');
const xero = require('../xero/client');

async function saveTokens({ userId, tenantId, tenantName, tokenSet, scopes }) {
  const expiresAt = new Date(tokenSet.expires_at * 1000);
  await pool.query(
    `INSERT INTO xero_tenants
       (user_id, tenant_id, tenant_name, access_token, refresh_token, token_expires_at, id_token, scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id) DO UPDATE SET
       access_token    = EXCLUDED.access_token,
       refresh_token   = EXCLUDED.refresh_token,
       token_expires_at= EXCLUDED.token_expires_at,
       id_token        = EXCLUDED.id_token,
       scopes          = EXCLUDED.scopes,
       updated_at      = NOW()`,
    [userId, tenantId, tenantName,
     tokenSet.access_token, tokenSet.refresh_token,
     expiresAt, tokenSet.id_token || null,
     scopes ? scopes.join(' ') : null]
  );
  logger.info('Tokens saved', { tenantId, tenantName });
}

// In-memory cache — used when DB is unavailable (client credentials flow)
const _memTokens = {};
const _memTenants = [];

function cacheToken(tenantId, tenantName, access_token, expires_at) {
  _memTokens[tenantId] = { access_token, expires_at: new Date(expires_at).getTime() };
  // Keep tenant list in sync (only add new entries; don't overwrite existing name with null)
  if (tenantName && !_memTenants.find(t => t.tenant_id === tenantId)) {
    _memTenants.push({ tenant_id: tenantId, tenant_name: tenantName, user_id: 'system' });
  }
}

async function getValidToken(tenantId) {
  // Try DB first
  try {
    const { rows } = await pool.query(
      'SELECT * FROM xero_tenants WHERE tenant_id = $1', [tenantId]
    );
    if (rows.length) {
      const row = rows[0];
      const expiresAt = new Date(row.token_expires_at).getTime();
      const needsRefresh = Date.now() > expiresAt - 60_000;
      if (!needsRefresh) return row.access_token;

      // Client credentials — re-fetch fresh token
      logger.info('Re-fetching client credentials token', { tenantId });
      const { refreshClientCredentialsToken } = require('../xero/connect');
      const { access_token, expires_at } = await refreshClientCredentialsToken();
      await pool.query(
        `UPDATE xero_tenants SET access_token=$1, token_expires_at=$2, updated_at=NOW()
         WHERE tenant_id=$3`,
        [access_token, expires_at, tenantId]
      );
      cacheToken(tenantId, null, access_token, expires_at);
      return access_token;
    }
  } catch (_) { /* DB unavailable — fall through to memory cache */ }

  // Fall back to in-memory cache (set during autoConnect)
  const mem = _memTokens[tenantId];
  if (mem) {
    if (Date.now() < mem.expires_at - 60_000) return mem.access_token;
    // Expired — re-fetch
    logger.info('Re-fetching client credentials token (no DB)', { tenantId });
    const { refreshClientCredentialsToken } = require('../xero/connect');
    const { access_token, expires_at } = await refreshClientCredentialsToken();
    cacheToken(tenantId, null, access_token, expires_at);
    return access_token;
  }

  throw new Error(`No token found for tenant: ${tenantId}`);
}

async function getAllTenants() {
  try {
    const { rows } = await pool.query(
      'SELECT tenant_id, tenant_name, user_id FROM xero_tenants ORDER BY connected_at'
    );
    if (rows.length) return rows;
  } catch (_) { /* DB unavailable — fall through to memory */ }
  return _memTenants;
}

async function getTenantsByUser(userId) {
  const { rows } = await pool.query(
    'SELECT tenant_id, tenant_name FROM xero_tenants WHERE user_id = $1', [userId]
  );
  return rows;
}

async function deleteTenant(tenantId) {
  await pool.query('DELETE FROM xero_tenants WHERE tenant_id = $1', [tenantId]);
  logger.info('Tenant disconnected', { tenantId });
}

module.exports = { saveTokens, getValidToken, cacheToken, getAllTenants, getTenantsByUser, deleteTenant };
