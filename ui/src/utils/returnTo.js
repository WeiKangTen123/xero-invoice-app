// Where to send someone once they have signed in: back to the page that sent
// them to the login screen, rather than always to the dashboard. A session that
// expired halfway through reviewing a bill used to drop the reader on the
// dashboard after signing in again, with the bill, its tab and its filters gone.
//
// Two ways in. A redirect inside the app carries the location in router state
// (`state.from`); the API client, which navigates the hard way to wipe every
// piece of React state, can only carry it in the address, as `?next=`.
//
// Only a path on this site is accepted. `?next=` is part of a URL anyone can
// write and send, and following it to another origin would make the login page
// a launch pad for phishing ("sign in here" → somewhere that looks like it).
// So it must start with a single "/", and once resolved against this origin it
// must still be this origin. The login and phone-capture pages are refused too:
// landing back on the form you just filled in reads as a failed sign-in.
const FALLBACK = '/dashboard';

export function safeReturnPath(candidate) {
  if (typeof candidate !== 'string' || !candidate.startsWith('/')) return null;
  // "//evil.example" and "/\evil.example" are both read by browsers as another host.
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return null;
  try {
    const url = new URL(candidate, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (url.pathname === '/login' || url.pathname.startsWith('/capture')) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    return null;
  }
}

export function returnPathFrom(location) {
  const from = location?.state?.from;
  const fromState = from && typeof from === 'object'
    ? `${from.pathname || ''}${from.search || ''}${from.hash || ''}`
    : null;
  const fromQuery = new URLSearchParams(location?.search || '').get('next');
  return safeReturnPath(fromState) || safeReturnPath(fromQuery) || FALLBACK;
}
