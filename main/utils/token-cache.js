const logger = require('./logger');
const db     = require('../db');

// Per-user in-memory token cache.
// Keyed by userId → { tokens: { [tenantId]: { access_token, expires_at } }, tenants: [...] }
const _userCaches = new Map();

// De-dupes concurrent cold-cache reconnects per user. Access tokens are never
// persisted (see getPersistedTenants below), so every restart starts with an
// empty cache even for an already-connected user — and Insights alone fires
// 4+ requests on page load, all racing to notice the same cold cache. Xero
// rotates the refresh token on every use, so firing reconnectXero() once per
// request would have the 2nd..nth calls redeem an already-rotated (now
// stale) refresh token and fail. Sharing one in-flight promise per user
// keyed here means only the first caller actually reconnects; the rest just
// await the same result.
const _reconnecting = new Map(); // userId -> Promise

function _getCache(userId) {
  if (!_userCaches.has(userId)) {
    _userCaches.set(userId, { tokens: {}, tenants: [] });
  }
  return _userCaches.get(userId);
}

// userId -> in-flight refresh promise; see getValidToken.
const _refreshing = new Map();

function forUser(userId) {
  const cache = _getCache(userId);

  function cacheToken(tenantId, tenantName, access_token, expires_at, connectionType = 'custom') {
    cache.tokens[tenantId] = {
      access_token,
      expires_at:      new Date(expires_at).getTime(),
      connection_type: connectionType, // 'custom' | 'oauth' — which refresh mechanism applies on expiry
    };
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
    let mem = cache.tokens[tenantId];
    if (!mem) {
      let inFlight = _reconnecting.get(userId);
      if (!inFlight) {
        inFlight = require('../xero/reconnect').reconnectXero(userId).finally(() => _reconnecting.delete(userId));
        _reconnecting.set(userId, inFlight);
      }
      try {
        await inFlight;
      } catch (err) {
        // A connection Xero has refused already says, in plain words, what to
        // do about it; wrapping it would bury that and hide needsReconnect
        // from the caller.
        if (err && err.needsReconnect) throw err;
        throw new Error(`No Xero token for tenant ${tenantId} — reconnect Xero first (${err.message})`);
      }
      mem = cache.tokens[tenantId];
      if (!mem) throw new Error(`No Xero token for tenant ${tenantId} — reconnect Xero first`);
    }
    if (Date.now() < mem.expires_at - 60_000) return mem.access_token;

    // One refresh per user at a time, shared by everyone who hits the expiry
    // together — the same shape as the cold-cache reconnect above. An OAuth
    // refresh ROTATES the refresh token, so a second concurrent refresh with
    // the same token failed with invalid_grant and surfaced as 500s on the
    // dashboard. One connection means one token: every tenant on it gets the
    // new one, not only the tenant that happened to ask.
    let refreshing = _refreshing.get(userId);
    if (!refreshing) {
      logger.info('Token expired — refreshing', { tenantId, userId, connectionType: mem.connection_type });
      const refresh = mem.connection_type === 'oauth'
        ? require('../xero/oauth').refreshAuthCodeToken
        : require('../xero/connect').refreshClientCredentialsToken;
      refreshing = refresh(userId).then(({ access_token, expires_at }) => {
        for (const [tid, m] of Object.entries(cache.tokens)) {
          if (m.connection_type === mem.connection_type) cacheToken(tid, null, access_token, expires_at, m.connection_type);
        }
        return access_token;
      }).finally(() => _refreshing.delete(userId));
      _refreshing.set(userId, refreshing);
    }
    return refreshing;
  }

  // Drops every org Xero no longer lists for this connection, in memory and
  // in xero_tenants. Rows were only ever removed by an explicit disconnect,
  // so an org removed on Xero's side stayed "connected" here and could be
  // picked as the default tenant forever.
  function pruneTenants(keepTenantIds) {
    const keep = new Set((keepTenantIds || []).map(String));
    for (const tid of Object.keys(cache.tokens)) if (!keep.has(tid)) delete cache.tokens[tid];
    cache.tenants = cache.tenants.filter(t => keep.has(String(t.tenant_id)));
    try {
      const rows = db.prepare('SELECT tenant_id FROM xero_tenants WHERE user_id = ?').all(userId);
      const del  = db.prepare('DELETE FROM xero_tenants WHERE user_id = ? AND tenant_id = ?');
      for (const r of rows) if (!keep.has(String(r.tenant_id))) { del.run(userId, r.tenant_id); logger.info('Tenant no longer listed by Xero — removed', { tenantId: r.tenant_id, userId }); }
    } catch (err) {
      logger.warn('Failed to prune xero_tenants rows', { error: err.message, userId });
    }
  }

  function getAllTenants() { return cache.tenants; }

  function clear() { cache.tokens = {}; cache.tenants = []; }

  return { cacheToken, removeTenant, getValidToken, getAllTenants, pruneTenants, clear };
}

// Read-only: the last-known connected orgs for a user, persisted across restarts.
// Used only for display (Admin Monitoring tab) — never for deciding whether a live
// token is available, since access tokens themselves are never persisted.
function getPersistedTenants(userId) {
  return db.prepare('SELECT tenant_id AS tenantId, tenant_name AS tenantName, connected_at AS connectedAt FROM xero_tenants WHERE user_id = ? ORDER BY connected_at')
    .all(userId);
}

// ── Connection health ─────────────────────────────────────────────────────────
//
// Whether Xero still accepts this user's connection, which scopes it granted,
// and when its token was last refreshed. One OAuth connection is one refresh
// token covering every organisation the user authorised, so this is kept per
// user and applies to all of that user's tenants.
//
// Persisted, unlike the tokens: after a restart the banner should still say a
// connection needs reconnecting rather than "connected" until the first
// request fails again, and the keep-alive job (jobs/xero-keepalive.js) needs
// to know how long ago a token was refreshed. A memory copy backs every read
// and write, so a failed write (no users row, as in some tests) loses nothing
// within the process.
//
// The table is created here rather than in db/schema.sql so this change stays
// inside the Xero connection files; CREATE TABLE IF NOT EXISTS is safe on
// every boot, and the foreign key removes the row with the user.
const _health = new Map(); // userId -> record
let _healthTableReady = false;

function _ensureHealthTable() {
  if (_healthTableReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS xero_connection_health (
      user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      method             TEXT,
      needs_reconnect    INTEGER NOT NULL DEFAULT 0,
      reason             TEXT,
      fingerprint        TEXT,
      granted_scopes     TEXT,
      last_refreshed_at  TEXT,
      updated_at         TEXT NOT NULL
    )
  `);
  _healthTableReady = true;
}

const EMPTY_HEALTH = Object.freeze({
  method: null, needsReconnect: false, reason: null, fingerprint: null, grantedScopes: null, lastRefreshedAt: null,
});

function _rowToHealth(row) {
  return {
    method:          row.method || null,
    needsReconnect:  !!row.needs_reconnect,
    reason:          row.reason || null,
    fingerprint:     row.fingerprint || null,
    grantedScopes:   row.granted_scopes ? row.granted_scopes.split(' ').filter(Boolean) : null,
    lastRefreshedAt: row.last_refreshed_at || null,
  };
}

/**
 * This user's connection health: { method, needsReconnect, reason, fingerprint,
 * grantedScopes (array or null when unknown), lastRefreshedAt (ISO or null) }.
 */
function getHealth(userId) {
  if (_health.has(userId)) return { ..._health.get(userId) };
  let record = { ...EMPTY_HEALTH };
  try {
    _ensureHealthTable();
    const row = db.prepare('SELECT * FROM xero_connection_health WHERE user_id = ?').get(userId);
    if (row) record = _rowToHealth(row);
  } catch (err) {
    logger.warn('Failed to read Xero connection health', { error: err.message, userId });
  }
  _health.set(userId, record);
  return { ...record };
}

function _saveHealth(userId, record) {
  _health.set(userId, record);
  try {
    _ensureHealthTable();
    db.prepare(`
      INSERT INTO xero_connection_health
        (user_id, method, needs_reconnect, reason, fingerprint, granted_scopes, last_refreshed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        method = excluded.method, needs_reconnect = excluded.needs_reconnect, reason = excluded.reason,
        fingerprint = excluded.fingerprint, granted_scopes = excluded.granted_scopes,
        last_refreshed_at = excluded.last_refreshed_at, updated_at = excluded.updated_at
    `).run(
      userId, record.method, record.needsReconnect ? 1 : 0, record.reason, record.fingerprint,
      record.grantedScopes ? record.grantedScopes.join(' ') : null, record.lastRefreshedAt, new Date().toISOString(),
    );
  } catch (err) {
    logger.warn('Failed to persist Xero connection health', { error: err.message, userId });
  }
  return { ...record };
}

// Xero refused these credentials. `fingerprint` (xero-utils
// credentialFingerprint) is what lets a later attempt with different
// credentials through without anyone clearing this first.
function markNeedsReconnect(userId, { method = null, reason, fingerprint = null } = {}) {
  const prev = getHealth(userId);
  return _saveHealth(userId, { ...prev, method: method || prev.method, needsReconnect: true, reason: reason || null, fingerprint });
}

// A token was issued: the connection works, whatever was recorded before.
// Scopes are replaced only when the token response said which were granted.
function markRefreshed(userId, { method = null, grantedScopes = null, at = new Date() } = {}) {
  const prev = getHealth(userId);
  return _saveHealth(userId, {
    ...prev,
    method:          method || prev.method,
    needsReconnect:  false,
    reason:          null,
    fingerprint:     null,
    grantedScopes:   Array.isArray(grantedScopes) ? grantedScopes : prev.grantedScopes,
    lastRefreshedAt: new Date(at).toISOString(),
  });
}

// Disconnect: nothing about the old connection applies to the next one.
function clearHealth(userId) {
  _health.delete(userId);
  try {
    _ensureHealthTable();
    db.prepare('DELETE FROM xero_connection_health WHERE user_id = ?').run(userId);
  } catch (err) {
    logger.warn('Failed to clear Xero connection health', { error: err.message, userId });
  }
}

module.exports = { forUser, getPersistedTenants, getHealth, markNeedsReconnect, markRefreshed, clearHealth };
