const fs   = require('fs');
const path = require('path');

// The sign-in page's flow: which form it shows (asked of the server first,
// with a Retry when it cannot be), what a refused first-run registration
// turns into, the password cleared after a failed sign-in, registration
// signing in with its own answer, the footer telling the truth, and the
// motion stilled for anyone who asks for less. There is no React test setup
// in this project (see login-ui.test.js): the decisions are plain functions
// in pages/login/login.js, which imports nothing and is run here as it is;
// the wiring is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function loadHelpers(rel) {
  const src = read(rel);
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const login = loadHelpers('pages/login/login.js');

describe('which form (formFromStatus)', () => {
  test('the first-run form only for a plain "no accounts yet"; anything else signs in', () => {
    expect(login.formFromStatus({ hasUsers: false })).toBe(login.FORM_FIRST_RUN);
    expect(login.formFromStatus({ hasUsers: true })).toBe(login.FORM_SIGN_IN);
    for (const body of [{}, null, undefined, { hasUsers: 0 }, { hasUsers: 'false' }]) {
      expect(login.formFromStatus(body)).toBe(login.FORM_SIGN_IN);
    }
  });

  test('four states, each its own name', () => {
    const states = [login.FORM_CHECKING, login.FORM_FIRST_RUN, login.FORM_SIGN_IN, login.FORM_UNREACHABLE];
    expect(new Set(states).size).toBe(4);
    expect(login.STATUS_FAILED_MESSAGE).toMatch(/Could not reach the server/);
  });
});

describe('a refused first-run registration (registerRefusal)', () => {
  test('403 and 409 turn the form into a sign-in form, each with its reason', () => {
    expect(login.registerRefusal({ status: 403 })).toMatch(/already has an administrator/);
    expect(login.registerRefusal({ status: 409 })).toMatch(/account with this email already exists/);
  });

  test('anything else is shown as it came', () => {
    for (const err of [{ status: 400 }, { status: 500 }, { status: 429 }, {}, null, undefined]) {
      expect(login.registerRefusal(err)).toBeNull();
    }
  });
});

describe('the sign-in page is wired to them', () => {
  const page = read('pages/Login.jsx');

  test('it starts by checking, and shows no form until the server has said which', () => {
    expect(page).toMatch(/const \[form, setForm\]\s+= useState\(FORM_CHECKING\);/);
    expect(page).toMatch(/const firstRun = form === FORM_FIRST_RUN;/);
    expect(page).toMatch(/\.then\(d => setForm\(formFromStatus\(d\)\)\)\s+\.catch\(\(\) => setForm\(FORM_UNREACHABLE\)\)/);
    expect(page).toMatch(/\{form === FORM_CHECKING \? \(\s+<p role="status"/);
    // The old start: sign-in first, switched to first run if the answer said so.
    expect(page).not.toMatch(/setFirstRun|useState\(false\);\s*\n\s*const \[email/);
  });

  test('a check that fails says so, with a Retry that asks again', () => {
    expect(page).toMatch(/\) : form === FORM_UNREACHABLE \? \(\s+<>\s+<div className="alert alert-error" role="alert">[\s\S]*?\{STATUS_FAILED_MESSAGE\}/);
    expect(page).toMatch(/onClick=\{retryForm\}[^>]*>\s+Retry\s+<\/button>/);
    expect(page).toMatch(/function retryForm\(\) \{\s+setForm\(FORM_CHECKING\);\s+loadForm\(\);\s+\}/);
  });

  test('a 403 or 409 from registration asks again which form, and says why it changed', () => {
    expect(page).toMatch(/const refusal = mode === 'register' \? registerRefusal\(err\) : null;/);
    expect(page).toMatch(/if \(refusal\) \{\s+setPassword\(''\);\s+setNotice\(refusal\);\s+await loadForm\(\);\s+return;\s+\}/);
    expect(page).toMatch(/<div className="alert alert-info" role="status"[^>]*>\s+<span className="alert-icon">ℹ<\/span>\s+\{notice\}/);
  });

  test('a failed sign-in clears the password and keeps the address; so does a lock', () => {
    expect(page).toMatch(/if \(mode === 'login'\) setPassword\(''\);\s+triggerError\(err\.message\);/);
    expect(page).toMatch(/if \(l\) \{ setLock\(l\); setNow\(Date\.now\(\)\); setPassword\(''\); shake\(\); return; \}/);
    expect(page).not.toMatch(/setEmail\(''\)/);
  });

  test('the error box is announced; the address field is not spell-checked or capitalised', () => {
    expect(page).toMatch(/<div className="alert alert-error" role="alert">\s+<span className="alert-icon">✕<\/span>\s+\{error\}/);
    expect(page).not.toMatch(/<div className="alert alert-error">/);
    const input = page.slice(page.indexOf('<input id="login-email"'), page.indexOf('/>', page.indexOf('<input id="login-email"')));
    expect(input).toMatch(/spellCheck=\{false\}/);
    expect(input).toMatch(/autoCapitalize="none"/);
    expect(input).toMatch(/autoComplete="username"/);
    expect(input).toMatch(/inputMode="email"/);
  });

  test('the footer says where documents go', () => {
    expect(page).toContain('Invite-only · Documents are read by Google Gemini and posted to your Xero');
    expect(page).not.toMatch(/No data shared externally/);
  });

  test('the orbs and the shake are stilled for anyone who asks for less motion', () => {
    expect((page.match(/<div className="login-orb" style=\{\{/g) || []).length).toBe(4);
    expect(page).toMatch(/<div className="login-card" style=\{\{[\s\S]*?animation:\s+shaking \? 'shake 0\.55s ease' : undefined,/);
    const css = read('styles/globals.css');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+\.login-orb,\s+\.login-card \{\s+animation: none !important;\s+\}\s+\}/);
  });
});

describe('registration signs in with its own answer', () => {
  const auth = read('context/AuthContext.jsx');
  const fn = auth.slice(auth.indexOf('async function register('), auth.indexOf('return (', auth.indexOf('async function register(')));

  test('the token and user come from /auth/register; /auth/login is not asked', () => {
    expect(fn).toMatch(/const data = await api\.post\('\/auth\/register', \{ email, password \}\);\s+localStorage\.setItem\('token', data\.token\);\s+setUser\(data\.user\);/);
    expect(fn).not.toMatch(/\/auth\/login/);
  });

  test('a session check whose token was replaced meanwhile checks the new one, once', () => {
    expect(auth).toMatch(/for \(let attempt = 0; attempt < 2; attempt\+\+\)/);
    expect(auth).toMatch(/if \(replaced && attempt === 0\) continue;/);
    expect(auth).toMatch(/if \(!replaced\) localStorage\.removeItem\('token'\);/);
  });
});

test('the API client asks nothing under /auth twice (behaviour: session-renewal-ui.test.js)', () => {
  const client = read('api/client.js');
  expect(client).toMatch(/if \(!retried && !isAuthPath\(path\)\) return request\(path, options, true\);/);
});
