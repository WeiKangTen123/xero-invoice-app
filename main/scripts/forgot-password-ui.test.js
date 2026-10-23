const fs   = require('fs');
const path = require('path');

// "Forgot your password?" on the screen side: the sign-in page leads to a
// reset by email where the server can send it (GET /auth/status → mail), and
// the forgot-password page asks for an address and says the same whatever the
// server found. There is no React test setup in this project (see
// login-ui.test.js), so the words and the timing are plain functions in files
// with no imports (pages/login/forgot-password.js, pages/login/login.js),
// loaded whole and run here; the wiring is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const fp    = load('pages/login/forgot-password.js');
const login = load('pages/login/login.js');

const NOW = Date.parse('2026-10-22T06:00:00.000Z');

describe('Send another link waits a minute (resendWait, resendLabel)', () => {
  test('sixty seconds from the last link, counted down, rounded up', () => {
    expect(fp.RESEND_SECONDS).toBe(60);
    expect(fp.resendWait(NOW, NOW)).toBe(60);
    expect(fp.resendWait(NOW, NOW + 500)).toBe(60);
    expect(fp.resendWait(NOW, NOW + 59001)).toBe(1);
    expect(fp.resendWait(NOW, NOW + 60000)).toBe(0);
    expect(fp.resendWait(NOW, NOW + 3600000)).toBe(0);
  });

  test('nothing sent yet: nothing to wait for', () => {
    expect(fp.resendWait(null, NOW)).toBe(0);
    expect(fp.resendWait(undefined, NOW)).toBe(0);
    expect(fp.resendWait('soon', NOW)).toBe(0);
  });

  test('the button says how long, then comes on', () => {
    expect(fp.resendLabel(42)).toBe('Send another link (42 s)');
    expect(fp.resendLabel(0)).toBe('Send another link');
  });
});

describe('the address (emailProblem)', () => {
  test('only what is plainly not an address is held back', () => {
    expect(fp.emailProblem('')).toBe('Enter your email address');
    expect(fp.emailProblem('   ')).toBe('Enter your email address');
    expect(fp.emailProblem(undefined)).toBe('Enter your email address');
    expect(fp.emailProblem('ana')).toBe('Enter the whole address, such as you@company.com');
    expect(fp.emailProblem('ana @co.sg')).toBe('Enter the whole address, such as you@company.com');
    expect(fp.emailProblem(' ana@co.sg ')).toBeNull();
    expect(fp.emailProblem('ana+sg@mail.co.sg')).toBeNull();
  });
});

describe('what the page says', () => {
  test('before: reset your password, with the way back', () => {
    expect(fp.FORM_TEXT).toEqual({
      title: 'Reset your password',
      subtitle: 'We\'ll email you a link to set a new one.',
      button: 'Email me a link',
      back: '← Back to sign in',
    });
  });

  test('after: the same words whether or not an account uses the address', () => {
    expect(fp.sentText(' ana@co.sg ')).toEqual({
      title: 'Check your email',
      text: 'If an account uses ana@co.sg, we\'ve sent it a link. It works once, for 30 minutes.',
      hint: 'Nothing? Check spam, or',
    });
    expect(fp.sentText('').text).toBe('If an account uses that address, we\'ve sent it a link. It works once, for 30 minutes.');
  });
});

describe('the sign-in page\'s side (login.js)', () => {
  test('reset by email only when the status says the server can send it', () => {
    expect(login.resetByEmail({ hasUsers: true, mail: true })).toBe(true);
    for (const body of [{ hasUsers: true, mail: false }, { hasUsers: true }, { mail: 'true' }, {}, null, undefined]) {
      expect(login.resetByEmail(body)).toBe(false);
    }
  });

  test('without it, a reset link from an administrator', () => {
    expect(login.ASK_ADMIN_TEXT).toBe('Ask your administrator for a reset link.');
  });

  test('the link carries the address typed so far, when it is one', () => {
    expect(login.forgotPath('ana@co.sg')).toBe('/forgot-password?email=ana%40co.sg');
    expect(login.forgotPath(' ana+sg@co.sg ')).toBe('/forgot-password?email=ana%2Bsg%40co.sg');
    for (const e of ['', 'ana', 'a b@co.sg', undefined, null]) expect(login.forgotPath(e)).toBe('/forgot-password');
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────────
describe('the sign-in page is wired to them', () => {
  const page = read('pages/Login.jsx');

  test('the status answer says whether reset by email is on, and the form is decided as before', () => {
    expect(page).toMatch(/\.then\(d => \{ setMail\(resetByEmail\(d\)\); setSignup\(signupOpen\(d\)\); return d; \}\)\s+\.then\(d => setForm\(formFromStatus\(d\)\)\)/);
    expect(page).toMatch(/const \[mail, setMail\]\s+= useState\(false\);/);
  });

  test('"Forgot your password?" links to the forgot page with email on, and opens the note to ask an admin without', () => {
    expect(page).toMatch(/\{mail \? \(\s+<Link\s+to=\{forgotPath\(email\)\}[\s\S]*?Forgot your password\?\s+<\/Link>\s+\) : \(\s+<button[\s\S]*?onClick=\{\(\) => setForgot\(v => !v\)\}[\s\S]*?Forgot your password\?\s+<\/button>\s+\)\}/);
    expect(page).toMatch(/\{!mail && forgot && \(/);
    expect(page).toMatch(/import \{ Link, useNavigate, useLocation \} from 'react-router-dom';/);
  });
});

describe('the forgot-password page is wired to them', () => {
  const page = read('pages/ForgotPassword.jsx');

  test('starts from the address the sign-in page passed along', () => {
    expect(page).toContain('const [email, setEmail]     = useState(() => emailFromSearch(location.search));');
    expect(page).toContain('autoComplete="username"');
  });

  test('asks the status first: no email here, no form, and who to ask instead', () => {
    expect(page).toMatch(/api\.get\('\/auth\/status'\)\s+\.then\(d => \{ if \(live\) setMail\(resetByEmail\(d\)\); \}\)/);
    expect(page).toMatch(/if \(mail === false\) \{[\s\S]*?This server can&apos;t send email yet\. \{ASK_ADMIN_TEXT\}/);
  });

  test('sends the address, then says the same thing whatever the answer', () => {
    expect(page).toContain("await api.post('/auth/forgot-password', { email: address });");
    expect(page).toMatch(/if \(problem\) return;\s+send\(email\.trim\(\)\);/);
    expect(page).toMatch(/const text = sentText\(sentTo\);/);
    expect(page).toMatch(/\{text\.text\}/);
  });

  test('Send another link is off for a minute, the clock ticking only while it waits', () => {
    expect(page).toContain('const wait    = resendWait(sentAt, now);');
    expect(page).toMatch(/useEffect\(\(\) => \{\s+if \(!waiting\) return undefined;\s+const tick = setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\);/);
    expect(page).toMatch(/disabled=\{waiting \|\| sending\} onClick=\{\(\) => send\(sentTo\)\}/);
    expect(page).toMatch(/\{sending \? 'Sending…' : resendLabel\(wait\)\}/);
  });

  test('a way back to sign in on every screen but the first load', () => {
    expect(page).toMatch(/<Link to="\/login" style=\{BACK\}>\{FORM_TEXT\.back\}<\/Link>/);
    expect((page.match(/\{back\}/g) || []).length).toBe(3);
  });
});
