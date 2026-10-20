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

// ── Demo accounts ─────────────────────────────────────────────────────────────
//
// A demo account (users.is_demo) never has a Xero token: its token is
// 'demo:<userId>', which xero/api-client.js turns into the demo facade, and
// its one organisation is the Demo Company (xero/demo/api.js DEMO_TENANT),
// listed here without an xero_tenants row so nothing — a disconnect, a prune,
// a reconnect — can ever remove or replace it. Its connection health reads as
// a Web app connection granted every scope, so nothing asks it to reconnect,
// nothing refreshes it and every optional feature is on. An admin's account
// switched to sample data may still have a real connection underneath, kept
// as it was for when it is switched back; getHealth's `stored` reads that.
//
// The account row, or null for a real account (and for an id no account has,
// which the tests use freely). users.js is required at call time: several
// tests stub it with only what they need, and a stub without isDemoUser is a
// real account.
function _demoUser(userId) {
  const users = require('./users');
  if (typeof users.isDemoUser !== 'function' || !users.isDemoUser(userId)) return null;
  return users.findById(userId);
}

function _demoTenant() {
  return require('../xero/demo/api').DEMO_TENANT;
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
    // Before the cache is looked at: a demo account's cache is always cold,
    // and a cold cache is what starts a reconnect.
    if (_demoUser(userId)) return `${require('../xero/demo/api').DEMO_TOKEN_PREFIX}${userId}`;
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

  // The in-memory shape (tenant_id, tenant_name), which queue/processor.js
  // chooses the org from. A demo account's is the Demo Company, whatever
  // was cached or cleared.
  function getAllTenants() {
    if (_demoUser(userId)) {
      const t = _demoTenant();
      return [{ tenant_id: t.tenantId, tenant_name: t.tenantName }];
    }
    return cache.tenants;
  }

  function clear() { cache.tokens = {}; cache.tenants = []; }

  return { cacheToken, removeTenant, getValidToken, getAllTenants, pruneTenants, clear };
}

// Read-only: the last-known connected orgs for a user, persisted across restarts.
// Used only for display (Admin Monitoring tab) — never for deciding whether a live
// token is available, since access tokens themselves are never persisted.
// A demo account's is the Demo Company, connected since the account was made.
function getPersistedTenants(userId) {
  const demo = _demoUser(userId);
  if (demo) return [{ ..._demoTenant(), connectedAt: demo.created_at }];
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
      refused_scopes     TEXT,
      declined_scopes    TEXT,
      scope_probe        TEXT,
      last_refreshed_at  TEXT,
      updated_at         TEXT NOT NULL
    )
  `);
  _healthTableReady = true;
}

const EMPTY_HEALTH = Object.freeze({
  method: null, needsReconnect: false, reason: null, fingerprint: null, grantedScopes: null, refusedScopes: [], declinedScopes: [],
  scopeProbe: null, lastRefreshedAt: null,
});

function _scopeList(text) {
  return text ? text.split(' ').filter(Boolean) : [];
}

function _rowToHealth(row) {
  let scopeProbe = null;
  try {
    scopeProbe = row.scope_probe ? JSON.parse(row.scope_probe) : null;
  } catch (_) { /* an unreadable probe is the same as none: the next connect probes again */ }
  return {
    method:          row.method || null,
    needsReconnect:  !!row.needs_reconnect,
    reason:          row.reason || null,
    fingerprint:     row.fingerprint || null,
    grantedScopes:   row.granted_scopes ? _scopeList(row.granted_scopes) : null,
    refusedScopes:   _scopeList(row.refused_scopes),
    declinedScopes:  _scopeList(row.declined_scopes),
    scopeProbe:      scopeProbe && typeof scopeProbe === 'object' ? scopeProbe : null,
    lastRefreshedAt: row.last_refreshed_at || null,
  };
}

/**
 * This user's connection health: { method, needsReconnect, reason, fingerprint,
 * grantedScopes (array or null when unknown), refusedScopes (scopes Xero would
 * not let this app ask for; see markScopesRefused), declinedScopes (optional
 * scopes the person chose to connect without; see markScopesDeclined),
 * scopeProbe (what Xero's authorize page said this app may ask for, or null;
 * see saveScopeProbe), lastRefreshedAt (ISO or null) }.
 *
 * `stored` reads the record kept for the account's real connection even
 * while it is a demo account. An admin can switch their own account to
 * sample data and back (routes/setup.js data-source), and the real
 * connection waits underneath meanwhile; the keep-alive
 * (jobs/xero-keepalive.js) must judge that one, not the stand-in below,
 * which never needs reconnecting and always reads as refreshed when the
 * account was made.
 */
function getHealth(userId, { stored = false } = {}) {
  const demo = stored ? null : _demoUser(userId);
  if (demo) {
    // Every scope a Web app connection can carry, offline_access included,
    // as oauth.js records them from a token response; refreshed when the
    // account was made, which is the only connecting it ever did.
    const { OAUTH_SCOPES } = require('../xero/xero-utils');
    return {
      ...EMPTY_HEALTH, method: 'demo', grantedScopes: ['offline_access', ...OAUTH_SCOPES.split(' ').filter(Boolean)],
      lastRefreshedAt: demo.created_at,
    };
  }
  return _storedHealth(userId);
}

// The record itself, from memory or the table, whatever kind of account this
// is now. Every change below builds on this rather than on getHealth: built
// on the demo stand-in, a refresh of a dormant real connection (the
// keep-alive, for an admin on sample data) would have replaced its recorded
// scopes, refusals and probe with the stand-in's.
function _storedHealth(userId) {
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
        (user_id, method, needs_reconnect, reason, fingerprint, granted_scopes, refused_scopes, declined_scopes, scope_probe,
         last_refreshed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        method = excluded.method, needs_reconnect = excluded.needs_reconnect, reason = excluded.reason,
        fingerprint = excluded.fingerprint, granted_scopes = excluded.granted_scopes, refused_scopes = excluded.refused_scopes,
        declined_scopes = excluded.declined_scopes, scope_probe = excluded.scope_probe,
        last_refreshed_at = excluded.last_refreshed_at, updated_at = excluded.updated_at
    `).run(
      userId, record.method, record.needsReconnect ? 1 : 0, record.reason, record.fingerprint,
      record.grantedScopes ? record.grantedScopes.join(' ') : null,
      record.refusedScopes?.length ? record.refusedScopes.join(' ') : null,
      record.declinedScopes?.length ? record.declinedScopes.join(' ') : null,
      record.scopeProbe ? JSON.stringify(record.scopeProbe) : null,
      record.lastRefreshedAt, new Date().toISOString(),
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
  const prev = _storedHealth(userId);
  return _saveHealth(userId, { ...prev, method: method || prev.method, needsReconnect: true, reason: reason || null, fingerprint });
}

// A token was issued: the connection works, whatever was recorded before.
// Scopes are replaced only when the token response said which were granted,
// and a scope the token carries is neither refused nor declined any more,
// whatever was recorded: Xero granting it is the final word.
function markRefreshed(userId, { method = null, grantedScopes = null, at = new Date() } = {}) {
  const prev = _storedHealth(userId);
  const granted = new Set(Array.isArray(grantedScopes) ? grantedScopes : []);
  return _saveHealth(userId, {
    ...prev,
    method:          method || prev.method,
    needsReconnect:  false,
    reason:          null,
    fingerprint:     null,
    grantedScopes:   Array.isArray(grantedScopes) ? grantedScopes : prev.grantedScopes,
    refusedScopes:   (prev.refusedScopes || []).filter(s => !granted.has(s)),
    declinedScopes:  (prev.declinedScopes || []).filter(s => !granted.has(s)),
    lastRefreshedAt: new Date(at).toISOString(),
  });
}

function _without(list, scopes) {
  const drop = new Set(scopes || []);
  return (list || []).filter(s => !drop.has(s));
}

// Xero's authorize endpoint refused a consent that named these scopes
// (invalid_scope: the app may not ask for them). Kept until the next
// disconnect, or until a probe finds Xero accepts them (markScopesAllowed),
// so the next consent link leaves them out (oauth.js buildAuthorizeUrl) and
// the connection status does not go on listing them as missing. Added to
// what is recorded, never replacing it. A refused scope cannot also be one
// the person declined: Xero made that choice for them. `reason` is for the
// log — where the refusal was seen.
function markScopesRefused(userId, scopes, { reason = null } = {}) {
  const prev = _storedHealth(userId);
  const added = (scopes || []).filter(s => !(prev.refusedScopes || []).includes(s));
  if (added.length) logger.warn('Xero refused these scopes for this app', { userId, scopes: added, reason: reason || undefined });
  const refusedScopes = [...new Set([...(prev.refusedScopes || []), ...(scopes || [])])];
  return _saveHealth(userId, { ...prev, refusedScopes, declinedScopes: _without(prev.declinedScopes, scopes) });
}

// A probe found Xero's authorize page accepting these scopes (oauth.js
// probeOptionalScopes), so a refusal recorded for them no longer holds —
// without this, a forced re-probe could never let an app that Xero has since
// allowed ask for them again short of a disconnect.
function markScopesAllowed(userId, scopes) {
  const prev = _storedHealth(userId);
  if (!(scopes || []).some(s => (prev.refusedScopes || []).includes(s))) return { ...prev };
  return _saveHealth(userId, { ...prev, refusedScopes: _without(prev.refusedScopes, scopes) });
}

// The person connected without these optional scopes (the consent link left
// their group out). Recorded so the connection status reports them as their
// choice rather than as something missing that a reconnect would fix, and
// so nothing nags them to reconnect for a feature they did not want. Cleared
// for any scope a later consent grants (markRefreshed), and never recorded
// for a scope Xero refused, which is not a choice.
function markScopesDeclined(userId, scopes) {
  const prev = _storedHealth(userId);
  const refused = new Set(prev.refusedScopes || []);
  const declinedScopes = [...new Set([...(prev.declinedScopes || []), ...(scopes || []).filter(s => !refused.has(s))])];
  return _saveHealth(userId, { ...prev, declinedScopes });
}

// What Xero's authorize page said this app may ask for (oauth.js
// probeOptionalScopes): { at, fingerprint, base, groups }. Replaces the last
// probe; the probe itself decides when it is too old to trust.
function saveScopeProbe(userId, probe) {
  const prev = _storedHealth(userId);
  return _saveHealth(userId, { ...prev, scopeProbe: probe ? { ...probe } : null });
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

module.exports = {
  forUser, getPersistedTenants, getHealth, markNeedsReconnect, markRefreshed, markScopesRefused, markScopesAllowed, markScopesDeclined,
  saveScopeProbe, clearHealth,
};
