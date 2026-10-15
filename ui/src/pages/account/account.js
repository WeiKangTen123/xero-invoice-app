// The Account page's decisions that need no React: what each recorded sign-in
// is called, and whether the page is in set-password mode (a temporary
// password from an administrator must be replaced before anything else). The
// page cannot be rendered on every machine this is worked on, so they live
// here, import nothing, and main/scripts/account-ui.test.js runs them as they
// are.

// One line per action the server records (GET /api/auth/sign-ins). A lock
// says how long it was for when the event carries the minutes; the server
// may send only the action, and then it is just "Locked".
export function signInLabel(event) {
  const action = event?.action;
  switch (action) {
    case 'login.success':  return 'Signed in';
    case 'login.failed':   return 'Wrong password';
    case 'login.unlocked': return 'Unlocked';
    case 'login.locked': {
      const minutes = Number(event.lockMinutes ?? event.minutes ?? event.details?.lockMinutes);
      return Number.isFinite(minutes) && minutes > 0 ? `Locked ${minutes} min` : 'Locked';
    }
    default: return typeof action === 'string' && action ? action : 'Unknown';
  }
}

// The badge colour beside the label: green for a sign-in, yellow for a wrong
// password, red for a lock, blue for an unlock, grey for anything else.
export function signInTone(action) {
  switch (action) {
    case 'login.success':  return 'badge badge-green';
    case 'login.failed':   return 'badge badge-yellow';
    case 'login.locked':   return 'badge badge-red';
    case 'login.unlocked': return 'badge badge-blue';
    default:               return 'badge badge-gray';
  }
}

// The events as the server sends them ({ events: [...] }), newest first, or
// nothing for an answer with none.
export function signInEvents(data) {
  const events = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];
  return events.filter(e => e && typeof e === 'object');
}

// Set-password mode: the address says so (?set-password=1, where the login
// page and the API client send someone who must change theirs) or the user
// does (mustChangePassword from /api/auth/me, so a reload lands the same way).
export function setPasswordMode(search, user) {
  if (user && user.mustChangePassword === true) return true;
  try {
    return new URLSearchParams(search || '').get('set-password') === '1';
  } catch (_) {
    return false;
  }
}
