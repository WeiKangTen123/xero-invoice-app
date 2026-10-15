const fs   = require('fs');
const path = require('path');

// Sign-in lockout on the screen side. There is no React test setup in this
// project (see cash-manager-ui.test.js), so the decisions — what the alert
// says for a 423, the countdown on the button, the password rules a form
// mirrors, the lock badge on Admin › Users — are plain functions in files
// with no imports, loaded whole and run here against a fixed clock; the
// wiring (no Register tab after first run, the 423 branch, the must-change
// gate, the Unlock call, the /account route, the sidebar link) is checked in
// the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function loadHelpers(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const login = loadHelpers('pages/login/login.js');
const rules = loadHelpers('pages/account/password-rules.js');
const users = loadHelpers('pages/admin/users.js');

// 10:30 on 16 Oct 2026 in Singapore. The browser would use its own clock
// setting; the tests name the zone so they read the same on any machine.
const NOW   = Date.parse('2026-10-16T02:30:00.000Z');
const SG    = 'Asia/Singapore';
const inMin = n => new Date(NOW + n * 60000).toISOString();
const LOCK_423 = { error: 'Too many failed attempts. This account is locked.', lockedUntil: inMin(15), lockMinutes: 15 };

describe('the lockout alert (lockMessage)', () => {
  test('until HH:MM in the reader\'s own time, the minutes left, and the sentence', () => {
    const l = login.lockMessage(LOCK_423, NOW, { timeZone: SG });
    expect(l).toMatchObject({ until: NOW + 15 * 60000, minutes: 15, time: '10:45' });
    expect(l.text).toBe('Too many failed attempts. This account is locked until 10:45 (15 minutes). '
      + 'If this wasn\'t you, or you can\'t wait, ask your administrator to unlock it.');
    expect(login.lockMessage(LOCK_423, NOW, { timeZone: 'UTC' }).time).toBe('02:45');
  });

  test('minutes are rounded up, and never below one while the lock lasts', () => {
    expect(login.lockMessage({ lockedUntil: inMin(14.2) }, NOW, { timeZone: SG })).toMatchObject({ minutes: 15 });
    expect(login.lockMessage({ lockedUntil: new Date(NOW + 20000).toISOString() }, NOW, { timeZone: SG }).text).toMatch(/\(1 minute\)\./);
  });

  test('a lock already past is no lock, and so is a body with no end', () => {
    expect(login.lockMessage({ ...LOCK_423, lockedUntil: inMin(-1) }, NOW)).toBeNull();
    expect(login.lockMessage({ lockedUntil: inMin(0) }, NOW)).toBeNull();
    expect(login.lockMessage({ lockedUntil: 'soon' }, NOW)).toBeNull();
    expect(login.lockMessage({ error: 'Invalid email or password' }, NOW)).toBeNull();
    expect(login.lockMessage(null, NOW)).toBeNull();
    expect(login.lockMessage(undefined, NOW)).toBeNull();
  });

  test('now may be a Date; a server that sends only lockMinutes is counted from now', () => {
    expect(login.lockMessage({ lockedUntil: inMin(5) }, new Date(NOW), { timeZone: SG }).time).toBe('10:35');
    expect(login.lockMessage({ lockMinutes: 15 }, NOW, { timeZone: SG })).toMatchObject({ until: NOW + 15 * 60000, minutes: 15, time: '10:45' });
  });
});

describe('the countdown on the button (lockCountdown)', () => {
  test('m:ss to go, seconds rounded up', () => {
    expect(login.lockCountdown(NOW + 15 * 60000, NOW)).toEqual({ locked: true, text: '15:00' });
    expect(login.lockCountdown(NOW + 14 * 60000 + 59 * 1000 + 1, NOW)).toEqual({ locked: true, text: '15:00' });
    expect(login.lockCountdown(NOW + 61 * 1000, NOW)).toEqual({ locked: true, text: '1:01' });
    expect(login.lockCountdown(NOW + 500, NOW)).toEqual({ locked: true, text: '0:01' });
  });

  test('at lockedUntil, and after, the button is a Sign in button again', () => {
    expect(login.lockCountdown(NOW, NOW)).toEqual({ locked: false, text: '' });
    expect(login.lockCountdown(NOW - 1, NOW)).toEqual({ locked: false, text: '' });
    expect(login.lockCountdown(NaN, NOW)).toEqual({ locked: false, text: '' });
  });
});

describe('the password rules a form mirrors (passwordProblem)', () => {
  const email = 'Jane@Nexsoss.com';

  test('twelve characters at least, in the server\'s words', () => {
    expect(rules.PASSWORD_MIN_LENGTH).toBe(12);
    expect(rules.passwordProblem('elevenchars', email)).toBe('Password must be at least 12 characters');
    expect(rules.passwordProblem('', email)).toBe('Password must be at least 12 characters');
    expect(rules.passwordProblem(undefined, email)).toBe('Password must be at least 12 characters');
    expect(rules.passwordProblem('twelve chars', email)).toBeNull();
  });

  test('not the account\'s own email, however it is cased, nor the part before the @', () => {
    expect(rules.passwordProblem('jane@nexsoss.com', email)).toBe('Password must not be your email address');
    expect(rules.passwordProblem('JANE@NEXSOSS.COM', ' jane@nexsoss.com ')).toBe('Password must not be your email address');
    expect(rules.passwordProblem('accounts.payable', 'Accounts.Payable@nexsoss.com')).toBe('Password must not be your email address');
    // As the server compares them: the password as typed, so a trailing space is another password.
    expect(rules.passwordProblem('jane@nexsoss.com ', email)).toBeNull();
    expect(rules.passwordProblem('jane@nexsoss.com', undefined)).toBeNull();
    expect(rules.passwordProblem('jane@nexsoss.com', '')).toBeNull();
  });

  test('not a password everyone tries first', () => {
    for (const p of ['password1234', 'Password1234', 'administrator', 'qwertyuiop12', '123456789012', '987654321098', 'aaaaaaaaaaaa']) {
      expect(rules.passwordProblem(p, email)).toBe('That password is too common; choose another');
    }
    expect(rules.passwordProblem('correct horse battery', email)).toBeNull();
  });

  test('the hint names the minimum', () => {
    expect(rules.passwordHint()).toBe('Min. 12 characters');
  });
});

describe('Admin › Users: the lock badge (lockBadge) and the notes beside it', () => {
  const row = { id: 'u2', email: 'jane@nexsoss.com', failedLogins: 5, lockedUntil: inMin(15), mustChangePassword: false, lastLoginAt: null };

  test('locked: until HH:MM in the admin\'s timezone, and how many wrong passwords', () => {
    const badge = users.lockBadge(row, NOW, { timeZone: SG });
    expect(badge).toMatchObject({ text: '🔒 Locked until 10:45 · 5 failed', until: NOW + 15 * 60000, failed: 5 });
    expect(badge.title).toMatch(/Unlock/);
    expect(users.lockBadge({ ...row, failedLogins: 0 }, NOW, { timeZone: 'UTC' }).text).toBe('🔒 Locked until 02:45');
  });

  test('a lock that has passed, or none, is no badge', () => {
    expect(users.lockBadge({ ...row, lockedUntil: inMin(-1) }, NOW)).toBeNull();
    expect(users.lockBadge({ ...row, lockedUntil: null }, NOW)).toBeNull();
    expect(users.lockBadge({}, NOW)).toBeNull();
    expect(users.lockBadge(null, NOW)).toBeNull();
    expect(users.isLocked(row, NOW)).toBe(true);
    expect(users.isLocked(row, NOW + 15 * 60000)).toBe(false);
  });

  test('wrong passwords on an unlocked row are a quiet note; on a locked row the badge counts them', () => {
    expect(users.failedNote({ ...row, lockedUntil: null, failedLogins: 3 }, NOW)).toBe('3 failed attempts');
    expect(users.failedNote({ ...row, lockedUntil: null, failedLogins: 1 }, NOW)).toBe('1 failed attempt');
    expect(users.failedNote({ ...row, lockedUntil: null, failedLogins: 0 }, NOW)).toBe('');
    expect(users.failedNote({ ...row, lockedUntil: inMin(-1), failedLogins: 2 }, NOW)).toBe('2 failed attempts');
    expect(users.failedNote(row, NOW)).toBe('');
  });

  test('a temporary password still to be replaced', () => {
    expect(users.mustSetNote({ mustChangePassword: true })).toBe('must set a password at next sign-in');
    expect(users.mustSetNote({ mustChangePassword: false })).toBe('');
    expect(users.mustSetNote({})).toBe('');
  });
});

describe('the sign-in page is wired to them', () => {
  const page = read('pages/Login.jsx');

  test('after first run there is no Register tab; accounts and resets come from an administrator', () => {
    expect(page).not.toMatch(/\['login', 'register'\]/);
    expect(page).not.toMatch(/switchMode|'Register'/);
    expect(page).toMatch(/const mode = firstRun \? 'register' : 'login';/);
    expect(page).toMatch(/\{!firstRun && \(/);
    expect(page).toContain('Need an account? Ask your administrator.');
    expect(page).toContain('Forgot your password?');
    expect(page).toContain('Ask your administrator to reset it from Users. You&apos;ll get a temporary password to sign in with, then set your own.');
    expect(page).toMatch(/onClick=\{\(\) => setForgot\(v => !v\)\}/);
  });

  test('first run still sets up the admin account, at twelve characters', () => {
    expect(page).toContain('Set up your admin account to get started');
    expect(page).toMatch(/minLength=\{mode === 'register' \? PASSWORD_MIN_LENGTH : 1\}/);
    expect(page).toMatch(/placeholder=\{mode === 'register' \? passwordHint\(\) : 'Enter your password'\}/);
    expect(page).toMatch(/const problem = passwordProblem\(password, email\);/);
  });

  test('a 423 locks the button until lockedUntil, counting down, and the alert says so', () => {
    expect(page).toMatch(/if \(err\.status === 423\) \{\s+const l = lockMessage\(err\.body, Date\.now\(\)\);/);
    expect(page).toMatch(/const countdown = lock \? lockCountdown\(lock\.until, now\)/);
    expect(page).toMatch(/disabled=\{loading \|\| locked\}/);
    expect(page).toMatch(/`Locked · \$\{countdown\.text\}`/);
    expect(page).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
    expect(page).toMatch(/if \(lock && !locked\) setLock\(null\);/);
    expect(page).toMatch(/\{lock && locked \? \(\s+<div className="alert alert-warning" role="alert">[\s\S]*?\{lock\.text\}/);
    // The wrong-password alert is as it was: the server's message, no count.
    expect(page).toMatch(/triggerError\(err\.message\);/);
  });

  test('a sign-in that must change its password goes to the form; the rest go back where they came from', () => {
    expect(page).toMatch(/import \{ api, SET_PASSWORD_PATH \} from '\.\.\/api\/client';/);
    expect(page).toMatch(/navigate\(user\?\.mustChangePassword \? SET_PASSWORD_PATH : returnPathFrom\(location\), \{ replace: true \}\)/);
  });
});

describe('the must-change gate', () => {
  test('the API client: a 403 password_change_required leads to the form, keeps the token, and every error carries its body', () => {
    const client = read('api/client.js');
    expect(client).toMatch(/export const SET_PASSWORD_PATH = '\/account\?set-password=1';/);
    expect(client).toMatch(/\} else if \(res\.status === 403 && data\.code === 'password_change_required'\) \{\s+requirePasswordChange\(\);/);
    const fn = client.slice(client.indexOf('function requirePasswordChange('), client.indexOf('async function request('));
    expect(fn).not.toMatch(/removeItem|clearSession/);
    expect(fn).toMatch(/if \(path\.startsWith\('\/account'\)/);
    expect(fn).toMatch(/window\.location\.href = SET_PASSWORD_PATH;/);
    expect(client).toMatch(/err\.code\s+= data\.code;\s+err\.body\s+= data;/);
  });

  test('the route guard sends every page but Account to the form; the login route too; /account exists', () => {
    const app = read('App.jsx');
    expect(app).toMatch(/import \{ SET_PASSWORD_PATH \} from '\.\/api\/client';/);
    expect(app).toMatch(/if \(user\.mustChangePassword && !location\.pathname\.startsWith\('\/account'\)\) return <Navigate to=\{SET_PASSWORD_PATH\} replace \/>;/);
    expect(app).toMatch(/user\.mustChangePassword \? SET_PASSWORD_PATH : returnPathFrom\(location\)/);
    expect(app).toMatch(/const Account\s+= lazy\(\(\) => import\('\.\/pages\/Account'\)\);/);
    expect(app).toMatch(/<Route path="account"\s+element=\{page\(<Account \/>\)\} \/>/);
  });

  test('the user is read from /auth/me, so mustChangePassword survives a reload', () => {
    const auth = read('context/AuthContext.jsx');
    expect(auth).toMatch(/const d = await api\.get\('\/auth\/me'\);\s+setUser\(d\.user\);/);
    expect(auth).toMatch(/setUser\(\(await api\.get\('\/auth\/me'\)\)\.user\)/);
  });

  test('the sidebar\'s user block leads to Account, Sign out stays, and the header names the page', () => {
    const sidebar = read('components/layout/Sidebar.jsx');
    expect(sidebar).toMatch(/<NavLink\s+to="\/account"\s+onClick=\{handleNavClick\}\s+title="Account"\s+aria-label="Account"/);
    expect(sidebar).toContain('Account ›');
    expect(sidebar).toContain('⎋ Sign out');
    expect(read('components/layout/Header.jsx')).toMatch(/if \(pathname === '\/account'\)\s+return \[\{ label: 'Account' \}\];/);
  });
});

describe('Admin › Users is wired to them', () => {
  const admin = read('pages/Admin.jsx');

  test('the badge, the notes and the last sign-in on each row', () => {
    expect(admin).toMatch(/import \{ lockBadge, failedNote, mustSetNote \} from '\.\/admin\/users';/);
    expect(admin).toMatch(/const lock\s+= lockBadge\(u, now, \{ timeZone: me\?\.timezone \}\);/);
    expect(admin).toMatch(/const failed\s+= failedNote\(u, now\);/);
    expect(admin).toMatch(/const mustSet = mustSetNote\(u\);/);
    expect(admin).toMatch(/\{lock && \(\s+<span className="badge badge-red" title=\{lock\.title\}>\{lock\.text\}<\/span>/);
    expect(admin).toMatch(/\{failed && \(\s+<span style=\{\{ fontSize: 11, color: 'var\(--text-muted\)' \}\}[^>]*>\{failed\}<\/span>/);
    expect(admin).toMatch(/\{mustSet && \(\s+<span style=\{\{ fontSize: 11, color: 'var\(--text-muted\)' \}\}[^>]*>\{mustSet\}<\/span>/);
    expect(admin).toMatch(/Last sign-in \{formatDateTime\(u\.lastLoginAt, me\?\.timezone\)\}/);
  });

  test('Unlock is offered on a locked row, calls the route, refetches the list and says so in a toast', () => {
    expect(admin).toMatch(/const toast\s+= useToast\(\);/);
    expect(admin).toMatch(/api\.post\(`\/admin\/users\/\$\{u\.id\}\/unlock`, \{\}\)/);
    expect(admin).toMatch(/if \(await control\('unlock', u, [^\n]*\)\) \{\s+toast\.success\(/);
    expect(admin).toMatch(/\{lock && \(\s+<button className="btn btn-outline btn-sm" disabled=\{!!busy\}[^\n]*\n\s+onClick=\{\(\) => handleUnlock\(u\)\}>/);
    // control() says whether the request went through, for the toast.
    expect(admin).toMatch(/await fetchUsers\(\);\s+return true;/);
  });

  test('the reset and create forms set a temporary password of twelve characters, and say what it is', () => {
    expect((admin.match(/They sign in with this once, within 24 hours, then must choose their own\./g) || []).length).toBe(2);
    expect(admin).toMatch(/import \{ passwordProblem, passwordHint, PASSWORD_MIN_LENGTH \} from '\.\/account\/password-rules';/);
    expect(admin).toMatch(/required minLength=\{PASSWORD_MIN_LENGTH\} autoFocus autoComplete="new-password"/);
    expect(admin).toMatch(/required minLength=\{PASSWORD_MIN_LENGTH\}\s+style=/);
    expect(admin).toMatch(/disabled=\{saving \|\| !!problem\}/);
    expect(admin).toMatch(/disabled=\{!!passwordProblem\(pass, email\)\}/);
  });
});

test('nothing in the touched files still says eight characters', () => {
  for (const rel of ['pages/Login.jsx', 'pages/Admin.jsx', 'pages/Account.jsx', 'pages/account/ChangePasswordCard.jsx']) {
    expect(read(rel)).not.toMatch(/Min\. 8|minLength=\{8\}|minLength: 8|length < 8/);
  }
});
