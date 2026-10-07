// The audit trail on screen: who acted, and the Activity tab's query. No
// imports, so main/scripts/audit-ui.test.js can run this file as it is.

// Who acted on a record, as its History says it. The server says what kind
// of actor it was (the account owner, an admin on someone else's account, or
// background work); whether that was the person looking is the page's to say.
export function actorLabel(e, me) {
  if (!e || e.actorType === 'system') return 'System';
  const mine = !!me && e.actorId != null && String(e.actorId) === String(me.id);
  if (e.actorType === 'admin') return mine ? 'You (as admin)' : `Admin ${e.actorEmail || ''}`.trim();
  return mine ? 'You' : (e.actorEmail || 'The account owner');
}

// The query string for GET /api/admin/events. The dates are days on this
// browser's calendar, from the start of `from` to the end of `to`, sent as
// instants (the end as the next day's start, which the server excludes), so
// the server need not guess a timezone.
export function activityQuery(filters, before = null) {
  const f = filters || {};
  const p = new URLSearchParams();
  if (f.userId) p.set('userId', f.userId);
  if (f.action) p.set('action', f.action);
  if (f.from) {
    const start = new Date(`${f.from}T00:00`);
    if (!Number.isNaN(start.getTime())) p.set('from', start.toISOString());
  }
  if (f.to) {
    const end = new Date(`${f.to}T00:00`);
    if (!Number.isNaN(end.getTime())) { end.setDate(end.getDate() + 1); p.set('to', end.toISOString()); }
  }
  if (before) p.set('before', String(before));
  return p.toString();
}
