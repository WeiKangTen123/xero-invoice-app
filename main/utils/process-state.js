// Per-user in-memory activity state.
// Running status is authoritative from watcher-registry; this only tracks timestamps
// and a running invoice counter so getStatus() never hits the disk.
const _state = new Map(); // userId → { startedAt, lastActivity, invoiceCount, lastScan }

function _get(userId) {
  if (!_state.has(userId)) {
    _state.set(userId, { startedAt: null, lastActivity: null, invoiceCount: 0, lastScan: null });
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

  // Records the outcome of an IMAP unseen-mail check (periodic poll or manual
  // rescan) so the UI can show "found N emails" / "no new emails" instead of
  // going quiet after a scan that turned up nothing.
  function notifyScan(emailsFound) {
    _get(userId).lastScan = { checkedAt: new Date().toISOString(), emailsFound };
  }

  function getStatus(running) {
    const s = _get(userId);
    return {
      running,
      startedAt:    s.startedAt,
      lastActivity: s.lastActivity,
      invoiceCount: s.invoiceCount,
      lastScan:     s.lastScan,
    };
  }

  // Sync the in-memory count from disk on first load (e.g. after server restart)
  // so the dashboard shows the real count, not 0.
  function syncCount(count) {
    _get(userId).invoiceCount = count;
  }

  return { notifyStarted, notifyStopped, addInvoice, notifyScan, getStatus, syncCount };
}

module.exports = { forUser };
