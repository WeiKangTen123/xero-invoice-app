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
    // Any length of straight run, and nothing but the words of this app.
    for (const p of ['0123456789012345678901', 'Password@123', 'Xero2026!!!!', 'FinancialAutomation1', 'invoices4finance']) {
      expect(rules.passwordProblem(p, email)).toBe('That password is too common; choose another');
    }
    expect(rules.passwordProblem('xero is my accountant', email)).toBeNull();
  });

  // As the server counts: in NFC, by character, so an emoji is one and e with
  // an accent is one; and no more than 128.
  test('counted in characters, twelve to 128', () => {
    expect(rules.PASSWORD_MAX_LENGTH).toBe(128);
    expect(rules.passwordProblem('😀'.repeat(6), email)).toBe('Password must be at least 12 characters');
    expect(rules.passwordProblem('café au lai', email)).toBe('Password must be at least 12 characters');
    expect(rules.passwordProblem('café au lait', email)).toBeNull();
    expect(rules.passwordProblem('🐱🐶'.repeat(64), email)).toBeNull();
    expect(rules.passwordProblem('🐱🐶'.repeat(65), email)).toBe('Password must be at most 128 characters');
    expect(rules.passwordProblem('josé@nexsoss.com', 'JOSÉ@nexsoss.com')).toBe('Password must not be your email address');
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

  // A forgotten password: reset by email where the server can send it
  // (forgot-password-ui.test.js), otherwise a reset link from an administrator.
  // No Register tab: creating an account is its own address (/signup), and
  // offered only while the server takes one (signup); otherwise accounts come
  // from an administrator.
  test('after first run there is no Register tab; accounts come from an administrator, and a reset link from them without email', () => {
    expect(page).not.toMatch(/\['login', 'register'\]/);
    expect(page).not.toMatch(/switchMode|'Register'/);
    expect(page).toMatch(/const signingUp = !firstRun && isSignupPath\(location\.pathname\);/);
    expect(page).toMatch(/const creating  = signingUp && signup;/);
    expect(page).toMatch(/const mode = firstRun \|\| creating \? 'register' : 'login';/);
    expect(page).toMatch(/\{!firstRun && !creating && \(/);
    expect(page).toContain('Need an account? Ask your administrator.');
    expect(page).toContain('Forgot your password?');
    expect(login.ASK_ADMIN_TEXT).toBe('Ask your administrator for a reset link.');
    expect(page).toMatch(/\{!mail && forgot && \([\s\S]*?\{ASK_ADMIN_TEXT\}/);
    expect(page).toMatch(/onClick=\{\(\) => setForgot\(v => !v\)\}/);
    // The temporary password an administrator once set is not offered any more.
    expect(page).not.toMatch(/temporary password to sign in with|reset it from Users/);
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

  // requiredPath (api/client.js): the set-password form first, then 2-step
  // set-up for an admin without it (mfa-ui.test.js runs it).
  test('a sign-in that must change its password goes to the form; the rest go back where they came from', () => {
    expect(page).toMatch(/import \{ api, requiredPath \} from '\.\.\/api\/client';/);
    expect(page).toMatch(/navigate\(requiredPath\(user\) \|\| returnPathFrom\(location\), \{ replace: true \}\)/);
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
    expect(app).toMatch(/import \{ SET_PASSWORD_PATH\b[^}]*\} from '\.\/api\/client';/);
    expect(app).toMatch(/if \(user\.mustChangePassword && !location\.pathname\.startsWith\('\/account'\)\) return <Navigate to=\{SET_PASSWORD_PATH\} replace \/>;/);
    expect(app).toMatch(/<Navigate to=\{requiredPath\(user\) \|\| returnPathFrom\(location\)\} replace \/>/);
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
    // The demo-account helpers (demo-ui.test.js) share the import.
    expect(admin).toMatch(/import \{ lockBadge, failedNote, mustSetNote\b[^}]*\} from '\.\/admin\/users';/);
    expect(admin).toMatch(/const lock\s+= lockBadge\(u, now, \{ timeZone: me\?\.timezone \}\);/);
    expect(admin).toMatch(/const failed\s+= failedNote\(u, now\);/);
    expect(admin).toMatch(/const mustSet = mustSetNote\(u\);/);
    expect(admin).toMatch(/\{lock && \(\s+<span className="badge badge-red" title=\{lock\.title\}>\{lock\.text\}<\/span>/);
    expect(admin).toMatch(/\{failed && \(\s+<span style=\{\{ fontSize: 11, color: 'var\(--text-muted\)' \}\}[^>]*>\{failed\}<\/span>/);
    expect(admin).toMatch(/\{mustSet && \(\s+<span style=\{\{ fontSize: 11, color: 'var\(--text-muted\)' \}\}[^>]*>\{mustSet\}<\/span>/);
    expect(admin).toMatch(/Last sign-in \{formatDateTime\(u\.lastLoginAt, me\?\.timezone\)\}/);
  });

  test('Unlock is offered on a locked account, calls the route, refetches the list and says so in a toast', () => {
    expect(admin).toMatch(/const toast\s+= useToast\(\);/);
    expect(admin).toMatch(/api\.post\(`\/admin\/users\/\$\{u\.id\}\/unlock`, \{\}\)/);
    expect(admin).toMatch(/if \(await control\('unlock', u, [^\n]*\)\) \{\s+toast\.success\(/);
    // The button is in the account's detail panel, offered while it is
    // locked (user-detail.js panelActions, run in user-detail-ui.test.js),
    // and is this page's handler.
    expect(admin).toMatch(/unlock: handleUnlock,/);
    expect(read('pages/admin/UserDetailPanel.jsx')).toMatch(/unlock:\s+\(\) => actions\.unlock\(user\),/);
    expect(read('pages/admin/user-detail.js')).toMatch(/if \(isLocked\(u, now\)\) \{\s+account\.push\(\{ key: 'unlock', busyKey: 'unlock', label: '🔓 Unlock'/);
    // control() says whether the request went through, for the toast.
    expect(admin).toMatch(/await fetchUsers\(\);\s+return true;/);
  });

  // The temporary passwords an administrator set are gone from this page: an
  // account is invited, and a reset is a link, so the person chooses their
  // own password and nobody else ever knows it (invite-ui.test.js).
  test('no form here sets a password: the invite and the reset are links', () => {
    expect(admin).not.toMatch(/They sign in with it within 24 hours/);
    expect(admin).not.toMatch(/from '\.\/account\/password-rules'/);
    expect(admin).not.toMatch(/autoComplete="new-password"/);
    expect(admin).not.toMatch(/api\.patch\(`\/admin\/users\/\$\{[^}]+\}\/password`/);
    expect(admin).toMatch(/api\.post\(`\/admin\/users\/\$\{u\.id\}\/reset-link`, \{\}\)/);
    // Invite is held while one is on its way, and while a demo account's
    // mailbox copy has no sender (demo-ui.test.js).
    expect(admin).toMatch(/disabled=\{inviting \|\| !!createProblem\}/);
  });
});

test('nothing in the touched files still says eight characters', () => {
  for (const rel of ['pages/Login.jsx', 'pages/Admin.jsx', 'pages/Account.jsx', 'pages/account/ChangePasswordCard.jsx']) {
    expect(read(rel)).not.toMatch(/Min\. 8|minLength=\{8\}|minLength: 8|length < 8/);
  }
});

// Demo accounts were once allowed a six-character permanent password; the
// one used turned up in this public repository. The rules are now the same
// for every account, and the Users page asks them the same way.
describe('the password rules for a demo account', () => {
  test('there is no short demo rule any more: twelve characters for every account', () => {
    expect(rules.DEMO_PASSWORD_MIN_LENGTH).toBeUndefined();
    expect(rules.shortPasswordAllowed).toBeUndefined();
    expect(rules.passwordProblem('demo456', 'demo.fixture@gmail.com', { demo: true })).toBe('Password must be at least 12 characters');
    expect(rules.passwordProblem('demo-fixture-2026', 'demo.fixture@gmail.com')).toBeNull();
    expect(rules.passwordHint({ demo: true })).toBe('Min. 12 characters');
    expect(rules.passwordHint()).toBe('Min. 12 characters');
  });

  test('the Users page sets no password for any account, and never calls one permanent', () => {
    const admin = read('pages/Admin.jsx');
    expect(admin).not.toMatch(/passwordProblem\(/);
    expect(admin).not.toMatch(/demoRule|DEMO_PASSWORD_MIN_LENGTH|shortPasswordAllowed|permanent/);
    // The person sets theirs on the set-password page, by the same rules.
    expect(read('pages/SetPassword.jsx')).toMatch(/const problem\s+= passwordProblem\(password, email\);/);
  });
});
