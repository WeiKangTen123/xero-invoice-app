const fs   = require('fs');
const path = require('path');

// The set-password page on the screen side: where an invite or a reset link
// lands, /set-password#t=<token>. There is no React test setup in this
// project (see login-ui.test.js), so the decisions — the token read from the
// fragment, which screen the server's answer leads to, the words on each, the
// checklist under the password, when a problem is said — are plain functions
// in files with no imports (pages/login/set-password.js and
// pages/account/password-rules.js), loaded whole and run here; the wiring
// (the route outside the sign-in guard, the fragment taken out of the address,
// the autocomplete attributes a password manager reads, the API client
// leaving the page alone on a 401) is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const sp    = load('pages/login/set-password.js');
const rules = load('pages/account/password-rules.js');
const login = load('pages/login/login.js');

describe('the token in the address (tokenFromHash)', () => {
  test('#t=<token>, alone or among other parameters', () => {
    expect(sp.tokenFromHash('#t=abc123DEF_-x')).toBe('abc123DEF_-x');
    expect(sp.tokenFromHash('t=abc123')).toBe('abc123');
    expect(sp.tokenFromHash('#x=1&t=abc123&y=2')).toBe('abc123');
  });

  test('read by hand: a "+" stays a "+", and an escaped character is decoded', () => {
    expect(sp.tokenFromHash('#t=ab+cd/ef=')).toBe('ab+cd/ef=');
    expect(sp.tokenFromHash('#t=ab%2Bcd')).toBe('ab+cd');
  });

  test('nothing a token could be is no token', () => {
    for (const hash of ['', '#', '#t=', '#token=abc', '#t=%E0%A4%A', '#t=has%20space', `#t=${'a'.repeat(513)}`, undefined, null]) {
      expect(sp.tokenFromHash(hash)).toBe('');
    }
    expect(sp.tokenFromHash(`#t=${'a'.repeat(512)}`)).toHaveLength(512);
  });
});

describe('which screen the server\'s answer leads to', () => {
  test('a link the server knows opens the form, an invite unless it says reset', () => {
    expect(sp.linkFromAnswer({ purpose: 'invite', email: 'ana@co.sg', invitedBy: 'owner@co.sg', expiresAt: '2026-10-29T06:05:00.000Z' }))
      .toEqual({ state: sp.LINK_FORM, purpose: 'invite', email: 'ana@co.sg', invitedBy: 'owner@co.sg', expiresAt: '2026-10-29T06:05:00.000Z' });
    expect(sp.linkFromAnswer({ purpose: 'reset', email: 'ana@co.sg', invitedBy: null, expiresAt: null }))
      .toMatchObject({ state: sp.LINK_FORM, purpose: 'reset', invitedBy: null });
    expect(sp.linkFromAnswer({ email: 'ana@co.sg', invitedBy: '  ' })).toMatchObject({ purpose: 'invite', invitedBy: null });
    expect(sp.linkFromAnswer(null)).toMatchObject({ state: sp.LINK_FORM, purpose: 'invite', email: '' });
  });

  test('a 410 is the link itself: its reason, and the server\'s words as given', () => {
    const err = (status, body) => Object.assign(new Error(body?.error || `HTTP ${status}`), { status, body });
    expect(sp.linkFromError(err(410, { error: 'This link has expired. Request a new one.', reason: 'expired' })))
      .toEqual({ state: sp.LINK_DEAD, reason: 'expired', purpose: null, message: 'This link has expired. Request a new one.' });
    expect(sp.linkFromError(err(410, { error: 'This link has already been used. If you set your password, sign in.', reason: 'used' })))
      .toMatchObject({ state: sp.LINK_DEAD, reason: 'used', message: 'This link has already been used. If you set your password, sign in.' });
    // A reason it does not know reads as invalid; a purpose, when sent, is kept.
    expect(sp.linkFromError(err(410, { error: 'Nope', reason: 'stolen', purpose: 'reset' })))
      .toEqual({ state: sp.LINK_DEAD, reason: 'invalid', purpose: 'reset', message: 'Nope' });
    expect(sp.linkFromError(err(410, {})).message).toBe('This link cannot be used.');
    expect(sp.linkFromError(err(404, { error: 'Not found' }))).toMatchObject({ state: sp.LINK_DEAD, reason: 'invalid' });
  });

  test('anything else is not the link\'s fault: the page offers to ask again', () => {
    const err = (status, message) => Object.assign(new Error(message), { status, body: {} });
    expect(sp.linkFromError(err(429, 'Too many requests'))).toEqual({ state: sp.LINK_FAILED, message: 'Too many requests' });
    expect(sp.linkFromError(err(500, 'HTTP 500'))).toEqual({ state: sp.LINK_FAILED, message: 'HTTP 500' });
    expect(sp.linkFromError(new TypeError('Failed to fetch'))).toEqual({ state: sp.LINK_FAILED, message: 'Failed to fetch' });
    expect(sp.linkFromError(null)).toEqual({ state: sp.LINK_FAILED, message: 'Could not reach the server.' });
    // A 400 about the password is the form's, not the link's.
    expect(sp.linkFromError(err(400, 'Password must be at least 12 characters')).state).toBe(sp.LINK_FAILED);
  });

  test('no token at all says to open the whole link again', () => {
    expect(sp.NO_TOKEN).toMatchObject({ state: sp.LINK_DEAD, reason: 'invalid', purpose: null });
    expect(sp.NO_TOKEN.message).toMatch(/whole link/);
  });

  test('five states, each its own name', () => {
    expect(new Set([sp.LINK_CHECKING, sp.LINK_FORM, sp.LINK_DEAD, sp.LINK_FAILED, sp.LINK_DONE]).size).toBe(5);
  });
});

describe('a link that cannot be used: the heading and the ways on (deadLinkView)', () => {
  test('used: sign in', () => {
    expect(sp.deadLinkView('used', null)).toMatchObject({ title: 'This link has already been used', forgot: false, signIn: true });
  });

  test('expired: a reset can be asked for again; an invite needs whoever sent it', () => {
    expect(sp.deadLinkView('expired', 'reset')).toEqual({ title: 'This link has expired', forgot: true, signIn: false, hint: '' });
    expect(sp.deadLinkView('expired', 'invite')).toMatchObject({ title: 'This invite has expired', forgot: false, hint: 'Ask whoever invited you to send a new one.' });
    // The server does not say which kind ran out: both ways are offered.
    expect(sp.deadLinkView('expired', null)).toMatchObject({ forgot: true, hint: 'For an invite, ask whoever invited you to send a new one.' });
  });

  test('invalid: sign in, or ask for a new one', () => {
    expect(sp.deadLinkView('invalid', null)).toMatchObject({ title: 'This link doesn\'t work', forgot: false, signIn: true });
    expect(sp.deadLinkView(undefined, undefined)).toEqual(sp.deadLinkView('invalid', null));
  });
});

describe('the form\'s words (formText)', () => {
  test('an invite welcomes, and says who invited them when the server knows', () => {
    expect(sp.formText({ purpose: 'invite', invitedBy: 'owner@co.sg' }))
      .toEqual({ title: 'Welcome — set your password', subtitle: 'Invited by owner@co.sg', button: 'Set password' });
    expect(sp.formText({ purpose: 'invite', invitedBy: null }).subtitle).toBe('You have been invited to Financial Automation.');
  });

  test('a reset asks for a new password', () => {
    expect(sp.formText({ purpose: 'reset' })).toMatchObject({ title: 'Choose a new password', button: 'Set new password' });
    expect(sp.formText(null).title).toBe('Welcome — set your password');
  });
});

describe('the checklist under the password (passwordChecklist)', () => {
  const email = 'ana.tan@co.sg';
  const marks = (pw, e = email) => rules.passwordChecklist(pw, e).map(c => `${c.ok ? '✓' : '○'} ${c.label}`);

  test('three rules, all open until the password is long enough', () => {
    expect(marks('')).toEqual(['○ At least 12 characters', '○ Not your email address', '○ Not a commonly used password']);
    expect(marks('short')).toEqual(['○ At least 12 characters', '○ Not your email address', '○ Not a commonly used password']);
    expect(marks(undefined)).toEqual(marks(''));
  });

  test('a good password ticks all three', () => {
    expect(marks('correct horse battery')).toEqual(['✓ At least 12 characters', '✓ Not your email address', '✓ Not a commonly used password']);
  });

  test('the account\'s own address fails that rule only; a common password fails that one only', () => {
    expect(marks('ana.tan@co.sg')).toEqual(['✓ At least 12 characters', '○ Not your email address', '✓ Not a commonly used password']);
    expect(marks('ANA.TAN@CO.SG')).toEqual(['✓ At least 12 characters', '○ Not your email address', '✓ Not a commonly used password']);
    expect(marks('password1234')).toEqual(['✓ At least 12 characters', '✓ Not your email address', '○ Not a commonly used password']);
    expect(marks('Xero2026!!!!')).toEqual(['✓ At least 12 characters', '✓ Not your email address', '○ Not a commonly used password']);
  });

  test('counted as the server counts (characters, in NFC), with the upper limit said when it is passed', () => {
    expect(marks('😀'.repeat(11))[0]).toBe('○ At least 12 characters');
    expect(marks('🐱🐶'.repeat(6))[0]).toBe('✓ At least 12 characters');
    expect(marks('🐱🐶'.repeat(65))).toEqual(['○ At most 128 characters', '○ Not your email address', '○ Not a commonly used password']);
  });

  test('every password the list ticks through, the message passes too', () => {
    for (const pw of ['', 'short', 'correct horse battery', 'ana.tan@co.sg', 'password1234', 'aaaaaaaaaaaa', '🐱🐶'.repeat(65), 'café au lait']) {
      const allOk = rules.passwordChecklist(pw, email).every(c => c.ok);
      expect([pw, allOk]).toEqual([pw, rules.passwordProblem(pw, email) === null]);
    }
  });
});

describe('when the password\'s problem is said (shownProblem)', () => {
  const problem = 'Password must be at least 12 characters';

  test('not on the first keystroke: only once the field is left, or the form sent', () => {
    expect(sp.shownProblem(problem, {})).toBe('');
    expect(sp.shownProblem(problem)).toBe('');
    expect(sp.shownProblem(problem, { touched: true })).toBe(problem);
    expect(sp.shownProblem(problem, { submitted: true })).toBe(problem);
  });

  test('gone as soon as the password passes', () => {
    expect(sp.shownProblem(null, { touched: true, submitted: true })).toBe('');
  });
});

describe('once the password is set', () => {
  test('sign in with it, the address filled in', () => {
    expect(sp.signInPath('ana@co.sg')).toBe('/login?email=ana%40co.sg');
    expect(sp.signInPath(' ana+sg@co.sg ')).toBe('/login?email=ana%2Bsg%40co.sg');
    expect(sp.signInPath('')).toBe('/login');
    expect(sp.signInPath(undefined)).toBe('/login');
  });

  test('says so, and warns someone signed in here as another account', () => {
    expect(sp.doneText('ana@co.sg', null)).toEqual({
      title: 'Password set', text: 'Password set. Sign in with your new password.', button: 'Sign in', note: '',
    });
    expect(sp.doneText('ana@co.sg', 'ANA@co.sg').note).toBe('');
    expect(sp.doneText('ana@co.sg', 'owner@co.sg').note).toBe('You are signed in here as owner@co.sg. Signing in as ana@co.sg signs that session out.');
  });

  test('the sign-in page takes the address from ?email=, only when it is one', () => {
    expect(login.emailFromSearch('?email=ana%40co.sg')).toBe('ana@co.sg');
    expect(login.emailFromSearch('?next=%2Finvoices&email=ana%2Bsg%40co.sg')).toBe('ana+sg@co.sg');
    for (const search of ['', '?email=', '?email=ana', '?email=a%40b%2Cc%40d', `?email=${'a'.repeat(250)}%40co.sg`, '?email=a%20b%40co.sg', undefined]) {
      expect(login.emailFromSearch(search)).toBe('');
    }
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────────
describe('the route', () => {
  const app = read('App.jsx');

  test('/set-password and /forgot-password are outside the signed-in layout, open signed in or not', () => {
    expect(app).toMatch(/const SetPassword\s+= lazy\(\(\) => import\('\.\/pages\/SetPassword'\)\);/);
    expect(app).toMatch(/const ForgotPassword = lazy\(\(\) => import\('\.\/pages\/ForgotPassword'\)\);/);
    expect(app).toContain('<Route path="/set-password" element={<SetPassword />} />');
    expect(app).toContain('<Route path="/forgot-password" element={<ForgotPassword />} />');
    // Before the guarded layout's route, at the top level like /login and /capture.
    const layout = app.indexOf('<PrivateRoute>\n                <Layout />');
    expect(layout).toBeGreaterThan(0);
    expect(app.indexOf('<Route path="/set-password"')).toBeLessThan(app.indexOf('path="/"'));
    expect(app.indexOf('<Route path="/forgot-password"')).toBeLessThan(app.indexOf('path="/"'));
    // Not wrapped in the guard, and not sent away when someone is signed in.
    expect(app).not.toMatch(/path="\/set-password" element=\{user \?/);
    expect(app).not.toMatch(/<PrivateRoute>\s*<SetPassword/);
  });
});

describe('the page', () => {
  const page = read('pages/SetPassword.jsx');

  test('reads the token from the fragment once, then takes it out of the address before the first paint', () => {
    expect(page).toContain('const [token] = useState(() => tokenFromHash(window.location.hash));');
    expect(page).toMatch(/useLayoutEffect\(\(\) => \{\s+if \(window\.location\.hash\) \{\s+window\.history\.replaceState\(window\.history\.state, '', window\.location\.pathname \+ window\.location\.search\);/);
    expect(page).toMatch(/import \{ useState, useEffect, useLayoutEffect, useCallback \} from 'react';/);
  });

  test('asks link-info with the token held, and Retry asks again with it', () => {
    expect(page).toMatch(/if \(!token\) \{ setLink\(NO_TOKEN\); return \(\) => \{\}; \}/);
    expect(page).toContain("api.post('/auth/link-info', { token })");
    expect(page).toContain('.then(d => { if (live) setLink(linkFromAnswer(d)); })');
    expect(page).toContain('.catch(err => { if (live) setLink(linkFromError(err)); });');
    expect(page).toMatch(/onClick=\{check\}/);
  });

  test('a hidden username a password manager pairs with the one new password, shown with a Show toggle', () => {
    expect(page).toContain('<input type="email" autoComplete="username" value={email} readOnly hidden />');
    expect((page.match(/autoComplete="new-password"/g) || []).length).toBe(1);
    expect((page.match(/type=\{show \? 'text' : 'password'\}/g) || []).length).toBe(1);
    expect(page).toMatch(/onClick=\{\(\) => setShow\(v => !v\)\}\s+aria-pressed=\{show\}/);
    expect(page).toMatch(/\{show \? 'Hide' : 'Show'\}/);
  });

  test('the checklist is the field\'s description, and the problem joins it once said', () => {
    expect(page).toContain('const checklist = passwordChecklist(password, email);');
    expect(page).toContain("aria-describedby={shown ? 'sp-rules sp-problem' : 'sp-rules'}");
    expect(page).toContain('<ul id="sp-rules"');
    expect(page).toMatch(/\{c\.ok \? '✓' : '○'\}/);
    expect(page).toContain('const shown     = shownProblem(problem, { touched, submitted });');
    expect(page).toMatch(/onBlur=\{\(\) => \{ if \(password\) setTouched\(true\); \}\}/);
    expect(page).toMatch(/<div id="sp-problem" role="alert"/);
  });

  test('sends the token and the password; a 410 meanwhile shows the dead link; nothing signs in', () => {
    expect(page).toContain("const d = await api.post('/auth/set-password', { token, password });");
    expect(page).toMatch(/if \(problem\) return;/);
    expect(page).toMatch(/if \(err\.status === 410\) \{ setLink\(linkFromError\(err\)\); return; \}/);
    expect(page).not.toMatch(/localStorage\.setItem|login\(/);
  });

  test('done: sign in with the new password, the address filled in, after signing out any session here', () => {
    expect(page).toMatch(/async function goSignIn\(\) \{\s+if \(user\) await logout\(\);\s+navigate\(signInPath\(doneEmail \|\| email\), \{ replace: true \}\);/);
    expect(page).toMatch(/\{done\.text\}/);
  });

  test('a dead link shows the server\'s message as given, with the way on', () => {
    expect(page).toMatch(/const view = deadLinkView\(link\.reason, link\.purpose\);/);
    expect(page).toMatch(/<div className="alert alert-error" role="alert">\s+<span className="alert-icon">✕<\/span>\s+\{link\.message\}/);
    expect(page).toMatch(/\{view\.forgot && \(\s+<Link to="\/forgot-password"/);
    expect(page).toMatch(/\{view\.signIn && \(\s+<Link to="\/login"/);
  });
});

describe('the sign-in page takes the address along', () => {
  const page = read('pages/Login.jsx');

  test('?email= fills the address, and the password field takes the focus', () => {
    expect(page).toContain('const [prefilled]           = useState(() => emailFromSearch(location.search));');
    expect(page).toContain('const [email, setEmail]     = useState(prefilled);');
    expect(page).toContain('autoFocus={!prefilled}');
    expect(page).toContain('autoFocus={!!prefilled}');
  });
});

// The API client runs whole here (as in session-renewal-ui.test.js): a 401
// on a page open without a session must not send it to the sign-in page, and
// above all not carry the address, fragment and all, into ?next=.
describe('the API client leaves the public pages alone', () => {
  const src = read('api/client.js');

  function loadClient({ pathname, hash = '', fetch }) {
    const store = new Map([['token', 'expired.token.here']]);
    const localStorage = {
      getItem:    k => (store.has(k) ? store.get(k) : null),
      setItem:    (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
    };
    const window = { location: { pathname, search: '', hash, href: `${pathname}${hash}` } };
    const body = `${src.replace(/^export /gm, '')}\nreturn { api, isPublicPath };`;
    return { ...new Function('fetch', 'localStorage', 'window', 'atob', body)(fetch, localStorage, window, atob), window, store };
  }
  const refused = async () => new Response(JSON.stringify({ error: 'Session expired' }), { status: 401 });

  test('a 401 on /set-password#t=… drops the token but stays, with the link out of any URL', async () => {
    const c = loadClient({ pathname: '/set-password', hash: '#t=secret-token', fetch: refused });
    await expect(c.api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(c.store.has('token')).toBe(false);
    expect(c.window.location.href).toBe('/set-password#t=secret-token');
  });

  test('the same on /forgot-password; any other page still goes to sign in', async () => {
    const f = loadClient({ pathname: '/forgot-password', fetch: refused });
    await expect(f.api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(f.window.location.href).toBe('/forgot-password');
    const d = loadClient({ pathname: '/invoices', fetch: refused });
    await expect(d.api.get('/invoices')).rejects.toMatchObject({ status: 401 });
    expect(d.window.location.href).toBe('/login?next=%2Finvoices');
  });

  test('isPublicPath: the four pages and below, nothing that only starts like them', () => {
    const { isPublicPath } = loadClient({ pathname: '/', fetch: refused });
    for (const p of ['/login', '/capture/abc', '/set-password', '/forgot-password', '/login?next=x']) expect(isPublicPath(p)).toBe(true);
    for (const p of ['/', '/invoices', '/set-passwords', '/account', '', undefined]) expect(isPublicPath(p)).toBe(false);
  });

  test('a 403 password_change_required on a public page does not take it to the Account page', () => {
    const fn = src.slice(src.indexOf('function requirePasswordChange('), src.indexOf('async function request('));
    expect(fn).toMatch(/if \(path\.startsWith\('\/account'\) \|\| isPublicPath\(path\)\) return;/);
  });
});
