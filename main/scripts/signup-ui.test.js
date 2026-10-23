const fs   = require('fs');
const path = require('path');

// Creating an account (/signup): the sign-in card at that address creates an
// ordinary account with an email and a password and signs it straight in,
// only while the server takes one (GET /auth/status → signup, an admin's
// Setup › Sign-up). Otherwise it says sign-up is closed and signs in. There
// is no React test setup here (see login-ui.test.js): the decisions are plain
// functions in pages/login/login.js, run as they are; the wiring is checked
// in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function loadHelpers(rel) {
  const src = read(rel);
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const login = loadHelpers('pages/login/login.js');

describe('the helpers', () => {
  test('signupOpen: only a plain true from the server opens it', () => {
    expect(login.signupOpen({ hasUsers: true, signup: true })).toBe(true);
    for (const body of [{ signup: false }, { signup: 'true' }, { hasUsers: true }, {}, null, undefined]) {
      expect(login.signupOpen(body)).toBe(false);
    }
  });

  test('isSignupPath: /signup, with or without a trailing slash; nothing else', () => {
    expect(login.SIGNUP_PATH).toBe('/signup');
    expect(login.isSignupPath('/signup')).toBe(true);
    expect(login.isSignupPath('/signup/')).toBe(true);
    for (const p of ['/login', '/signups', '/', '', null, undefined]) expect(login.isSignupPath(p)).toBe(false);
  });

  test('signupRefusal: closed meanwhile, or the address has an account; anything else is not one', () => {
    expect(login.signupRefusal({ status: 403 })).toBe(login.SIGNUP_CLOSED_TEXT);
    expect(login.SIGNUP_CLOSED_TEXT).toMatch(/closed/);
    expect(login.signupRefusal({ status: 409 })).toBe('An account with this email already exists. Sign in with its password.');
    for (const err of [{ status: 400 }, { status: 500 }, null, undefined]) expect(login.signupRefusal(err)).toBeNull();
  });
});

describe('the wiring', () => {
  const page   = read('pages/Login.jsx');
  const app    = read('App.jsx');
  const client = read('api/client.js');
  const setup  = read('pages/Setup.jsx');

  test('/signup is its own public address, the same card, for anyone not signed in', () => {
    expect(app).toMatch(/<Route path="\/signup" element=\{user \? <Navigate to=\{requiredPath\(user\) \|\| returnPathFrom\(location\)\} replace \/> : <Login \/>\} \/>/);
    expect(client).toMatch(/const PUBLIC_PATHS = \[[^\]]*'\/signup'/);
  });

  test('the card creates an account only at /signup and only while the server takes one', () => {
    expect(page).toMatch(/setSignup\(signupOpen\(d\)\)/);
    expect(page).toMatch(/const signingUp = !firstRun && isSignupPath\(location\.pathname\);/);
    expect(page).toMatch(/const creating  = signingUp && signup;/);
    expect(page).toMatch(/const mode = firstRun \|\| creating \? 'register' : 'login';/);
    expect(page).toContain("creating ? 'Create your account'");
    expect(page).toContain("'Create an account to get started'");
  });

  test('"Create an account" is offered only when open; otherwise "ask your administrator"; and back to Sign in from the form', () => {
    expect(page).toMatch(/\{signup \? \(\s+<p[^>]*>\s+New here\?\{' '\}\s+<Link to=\{SIGNUP_PATH\}[^>]*>Create an account<\/Link>/);
    expect(page).toMatch(/\) : \(\s+<p[^>]*>Need an account\? Ask your administrator\.<\/p>\s+\)\}/);
    expect(page).toMatch(/\{creating && \(\s+<p[^>]*>\s+Already have an account\?\{' '\}\s+<Link to="\/login"/);
  });

  test('/signup on a closed site says so and signs in, instead of a form the server would refuse', () => {
    expect(page).toMatch(/\{signingUp && !signup && !notice && !error && \(/);
    expect(page).toContain('{SIGNUP_CLOSED_TEXT}');
  });

  test('the footer drops "Invite-only" while sign-up is open', () => {
    expect(page).toMatch(/\{signup\s+\? 'Documents are read by Google Gemini and posted to your Xero'\s+: 'Invite-only · Documents are read by Google Gemini and posted to your Xero'\}/);
  });

  test('Setup › Sign-up is a box to tick, kept as the words the server reads', () => {
    expect(setup).toMatch(/signup: \{\s+label: 'Sign-up \(admin\)'/);
    expect(setup).toMatch(/if \(name === 'ALLOW_REGISTRATION'\) \{/);
    expect(setup).toMatch(/type="checkbox" checked=\{on\}/);
    expect(setup).toMatch(/onChange=\{e => onChange\(name, e\.target\.checked \? 'true' : 'false'\)\}/);
    expect(setup).toMatch(/\{config\.signup && \(\s+<SectionCard\s+sectionKey="signup"/);
  });
});
