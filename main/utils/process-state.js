// Per-user in-memory activity state.
// Running status is authoritative from watcher-registry; this only tracks timestamps
// and a running invoice counter so getStatus() never hits the disk.
const _state = new Map(); // userId → { startedAt, lastActivity, invoiceCount }

function _get(userId) {
  if (!_state.has(userId)) {
    _state.set(userId, { startedAt: null, lastActivity: null, invoiceCount: 0 });
  }
  return _state.get(userId);
}

function forUser(userId) {
  function notifyStarted() {
    const s = _get(userId);
    s.startedAt    = new Date().toISOString();
    s.lastActivity = s.startedAt;
  }

  function notifyStopped() {
    _get(userId).startedAt = null;
  }

  function addInvoice() {
    const s = _get(userId);
    s.lastActivity = new Date().toISOString();
    s.invoiceCount++;
  }

  function getStatus(running) {
    const s = _get(userId);
    return {
      running,
      startedAt:    s.startedAt,
      lastActivity: s.lastActivity,
      invoiceCount: s.invoiceCount,
    };
  }

  // Sync the in-memory count from disk on first load (e.g. after server restart)
  // so the dashboard shows the real count, not 0.
  function syncCount(count) {
    _get(userId).invoiceCount = count;
  }

  return { notifyStarted, notifyStopped, addInvoice, getStatus, syncCount };
}

module.exports = { forUser };
