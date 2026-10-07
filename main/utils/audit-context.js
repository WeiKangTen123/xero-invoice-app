// Who is acting, for the audit trail (utils/audit-log.js), without passing it
// through every call between a route and the store.
//
// requireAuth opens a context for each signed-in request (auth-middleware.js)
// holding the person on it; anything that runs because of that request, its
// awaits and the timers and promises it starts included, sees the same
// person. Code with no context at all (the boot recoveries, the 3-hourly
// status check, the timers the mail watcher runs on) is the system acting.
//
// The catch is work a request starts but does not own: a mailbox watcher
// switched on from the Start button, a worker kicked by an upload, a receipt
// read off the response path. Each would otherwise carry the person who
// pressed the button into every record it writes for as long as it runs.
// Those entry points call runAsSystem, which cuts them loose.
const { AsyncLocalStorage } = require('async_hooks');

const _als = new AsyncLocalStorage();

// The person a context is about: id, email and role, never the token or the
// rest of the user row.
function _person(user) {
  if (!user || user.id === undefined || user.id === null) return null;
  return { id: String(user.id), email: user.email || null, role: user.role || 'user' };
}

// For requireAuth, once it has put the user on the request.
function runForRequest(req, next) {
  const person = _person(req.user);
  if (!person) return next();
  return _als.run({ person }, next);
}

// Runs fn as a given person: the phone capture route, which has no session,
// acts for the account that made its link.
function runAs(user, fn) {
  return _als.run({ person: _person(user) }, fn);
}

// Runs fn as the system. `via` names what the system was doing when it is
// worth saying ("Receipt read"), and is put in front of the event's summary.
function runAsSystem(fn, { via = null } = {}) {
  return _als.run({ system: true, via }, fn);
}

// Runs fn with this context plus a marker: { bulk } for a bulk action, so
// each record's event can say it was one of many; { via } to say what was
// going on ("Receipt read again") in front of each event's summary.
function withMarker(marker, fn) {
  return _als.run({ ...(_als.getStore() || {}), ...marker }, fn);
}

function current() {
  return _als.getStore() || null;
}

// Who is acting on a record that belongs to ownerUserId:
//   user    the owner, from their own session (or their phone link)
//   admin   an admin acting on someone else's account
//   system  nobody: background work, or a context with no person in it
function actorFor(ownerUserId) {
  const ctx = _als.getStore();
  const person = ctx && !ctx.system ? ctx.person : null;
  if (!person) return { type: 'system', id: null, email: null };
  if (ownerUserId !== undefined && ownerUserId !== null && String(ownerUserId) !== person.id && person.role === 'admin') {
    return { type: 'admin', id: person.id, email: person.email };
  }
  return { type: 'user', id: person.id, email: person.email };
}

const SYSTEM = Object.freeze({ type: 'system', id: null, email: null });

module.exports = { runForRequest, runAs, runAsSystem, withMarker, current, actorFor, SYSTEM };
