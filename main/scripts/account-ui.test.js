const fs   = require('fs');
const path = require('path');

// The Account page on the screen side: the person's own password, their
// sessions, and the sign-ins recorded on the account. There is no React test
// setup in this project (see cash-manager-ui.test.js), so the decisions —
// what each sign-in event is called, when the page is in set-password mode,
// the password rules the card mirrors — are plain functions in files with no
// imports, loaded whole and run here; the wiring (the cards and their order,
// the set-password heading and field, the re-read of the user and the leave
// for the dashboard, the confirm before Sign out everywhere, the routes each
// card calls) is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function loadHelpers(rel) {
  const src = read(rel);
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const h     = loadHelpers('pages/account/account.js');
const rules = loadHelpers('pages/account/password-rules.js');

describe('what each recorded sign-in is called (signInLabel)', () => {
  test('one label per action the server records', () => {
    expect(h.signInLabel({ action: 'login.success' })).toBe('Signed in');
    expect(h.signInLabel({ action: 'login.failed' })).toBe('Wrong password');
    expect(h.signInLabel({ action: 'login.unlocked' })).toBe('Unlocked');
  });

  test('a lock says how long when the event carries the minutes', () => {
    expect(h.signInLabel({ action: 'login.locked', lockMinutes: 15 })).toBe('Locked 15 min');
    expect(h.signInLabel({ action: 'login.locked', minutes: 30 })).toBe('Locked 30 min');
    expect(h.signInLabel({ action: 'login.locked', details: { lockMinutes: 60 } })).toBe('Locked 60 min');
    expect(h.signInLabel({ action: 'login.locked' })).toBe('Locked');
    expect(h.signInLabel({ action: 'login.locked', lockMinutes: 0 })).toBe('Locked');
  });

  test('an action this code does not know is shown as it is, never dropped', () => {
    expect(h.signInLabel({ action: 'login.something' })).toBe('login.something');
    expect(h.signInLabel({})).toBe('Unknown');
    expect(h.signInLabel(null)).toBe('Unknown');
  });

  test('a colour each, grey for the rest', () => {
    expect(['login.success', 'login.failed', 'login.locked', 'login.unlocked', 'other'].map(h.signInTone))
      .toEqual(['badge badge-green', 'badge badge-yellow', 'badge badge-red', 'badge badge-blue', 'badge badge-gray']);
  });

  test('the events as the server sends them, or none', () => {
    const events = [{ at: '2026-10-16T01:12:00.000Z', action: 'login.success', ip: '203.0.113.5' }];
    expect(h.signInEvents({ events })).toEqual(events);
    expect(h.signInEvents({ events: [null, ...events] })).toEqual(events);
    expect(h.signInEvents(events)).toEqual(events);
    expect(h.signInEvents({})).toEqual([]);
    expect(h.signInEvents(null)).toEqual([]);
  });
});

describe('set-password mode (setPasswordMode)', () => {
  test('from the address, where the login page and the API client send someone', () => {
    expect(h.setPasswordMode('?set-password=1', null)).toBe(true);
    expect(h.setPasswordMode('?tab=x&set-password=1', { mustChangePassword: false })).toBe(true);
    expect(h.setPasswordMode('?set-password=0', null)).toBe(false);
    expect(h.setPasswordMode('', null)).toBe(false);
    expect(h.setPasswordMode(undefined, undefined)).toBe(false);
  });

  test('from the user, so a reload lands the same way', () => {
    expect(h.setPasswordMode('', { mustChangePassword: true })).toBe(true);
    expect(h.setPasswordMode('', { mustChangePassword: false })).toBe(false);
    expect(h.setPasswordMode('', {})).toBe(false);
  });
});

describe('the password rules the card mirrors', () => {
  test('the server\'s three rules, in its words, and nothing else', () => {
    expect(rules.passwordProblem('short', 'me@test.com')).toBe('Password must be at least 12 characters');
    expect(rules.passwordProblem('ME@TEST.COM!', 'me@test.com')).toBeNull();
    expect(rules.passwordProblem('ME@TEST.COMX', 'me@test.comx')).toBe('Password must not be your email address');
    expect(rules.passwordProblem('firstname.last', 'firstname.last@test.com')).toBe('Password must not be your email address');
    expect(rules.passwordProblem('passwordpassword', 'me@test.com')).toBe('That password is too common; choose another');
    // No complexity rule: twelve plain letters pass.
    expect(rules.passwordProblem('plainletters', 'me@test.com')).toBeNull();
  });

  // As users.js shortPasswordAllowed: an admin can switch to Xero at any
  // time, so an admin on sample data has the full-length rule.
  test('the short demo password is for a demo account that is not an admin', () => {
    expect(rules.shortPasswordAllowed({ demo: true, role: 'user' })).toBe(true);
    expect(rules.shortPasswordAllowed({ demo: true })).toBe(true);
    expect(rules.shortPasswordAllowed({ demo: true, role: 'admin' })).toBe(false);
    expect(rules.shortPasswordAllowed({ demo: false, role: 'user' })).toBe(false);
    expect(rules.shortPasswordAllowed({ demo: false, role: 'admin' })).toBe(false);
    // Read strictly, and nothing at all is no demo account.
    expect(rules.shortPasswordAllowed({ demo: 'true', role: 'user' })).toBe(false);
    expect(rules.shortPasswordAllowed(null)).toBe(false);
    expect(rules.shortPasswordAllowed(undefined)).toBe(false);
  });

  test('asked through it, a demo admin needs the full length and a demo user six', () => {
    const ask = account => rules.passwordProblem('demo123', 'demo@gmail.com', { demo: rules.shortPasswordAllowed(account) });
    expect(ask({ demo: true, role: 'user' })).toBeNull();
    expect(ask({ demo: true, role: 'admin' })).toBe('Password must be at least 12 characters');
    expect(ask({ demo: false, role: 'user' })).toBe('Password must be at least 12 characters');
    expect(rules.passwordHint({ demo: rules.shortPasswordAllowed({ demo: true, role: 'admin' }) })).toBe('Min. 12 characters');
    expect(rules.passwordHint({ demo: rules.shortPasswordAllowed({ demo: true, role: 'user' }) })).toBe('Min. 6 characters');
  });
});

describe('the Account page is wired to them', () => {
  const page     = read('pages/Account.jsx');
  const card     = read('pages/account/ChangePasswordCard.jsx');
  const sessions = read('pages/account/SessionsCard.jsx');
  const signIns  = read('pages/account/SignInsCard.jsx');
  const auth     = read('context/AuthContext.jsx');

  test('the page: the title, the three cards in order, the mode from the address or the user', () => {
    expect(page).toMatch(/<h1>Account<\/h1>/);
    expect(page).toMatch(/const settingPassword = setPasswordMode\(location\.search, user\);/);
    const order = ['<ChangePasswordCard', '<SessionsCard', '<SignInsCard'].map(s => page.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('the card: twelve characters, the server\'s messages before sending, the button off until it would pass', () => {
    expect(card).toMatch(/import \{ passwordProblem, passwordHint, PASSWORD_MIN_LENGTH \} from '\.\/password-rules';/);
    expect(card).toMatch(/const problem\s+= next \? passwordProblem\(next, user\?\.email\) : null;/);
    expect(card).toMatch(/const mismatch = again && next !== again \? 'The new passwords do not match' : '';/);
    expect(card).toMatch(/const valid\s+= !!current && !!next && !problem && again === next;/);
    expect(card).toMatch(/disabled=\{saving \|\| !valid\}/);
    expect(card).toContain('{passwordHint()}, no other rules.');
    expect(card).toMatch(/minLength: PASSWORD_MIN_LENGTH, placeholder: passwordHint\(\)/);
  });

  test('set-password mode: the heading, the temporary-password field, and on success the user is re-read and the dashboard opened', () => {
    expect(card).toMatch(/\{setPassword \? 'Set a new password' : 'Change password'\}/);
    expect(card).toContain('Your administrator gave you a temporary password. Choose your own to go on.');
    expect(card).toMatch(/label: setPassword \? 'Temporary password' : 'Current password'/);
    expect(card).toMatch(/if \(onPasswordSet\) \{ await onPasswordSet\(\); return; \}/);
    expect(page).toMatch(/onPasswordSet=\{settingPassword \? onPasswordSet : undefined\}/);
    expect(page).toMatch(/await refreshUser\(\);\s+navigate\('\/dashboard', \{ replace: true \}\);/);
    // The one control the server would refuse meanwhile is left out.
    expect(page).toMatch(/\{!settingPassword && <SessionsCard idx=\{1\} \/>\}/);
  });

  test('Sessions: the sentence, a confirm first, the route, the token kept, the note', () => {
    expect(sessions).toContain('Other devices are signed out when you change your password.');
    expect(sessions).toMatch(/const confirm = useConfirm\(\);/);
    expect(sessions).toMatch(/const ok = await confirm\(\{[\s\S]*?\}\);\s+if \(!ok\) return;/);
    expect(sessions).toMatch(/await signOutEverywhere\(\);\s+setMsg\(\{ ok: true, text: 'Every other device is signed out\.' \}\);/);
    expect(auth).toMatch(/const data = await api\.post\('\/auth\/sign-out-everywhere', \{\}\);\s+if \(data\.token\) localStorage\.setItem\('token', data\.token\);/);
    expect(auth).toMatch(/changePassword, signOutEverywhere \}\}>/);
  });

  test('Recent sign-ins: the route, the time in the app\'s format, a label and the IP per row, the empty and failed states', () => {
    expect(signIns).toMatch(/api\.get\('\/auth\/sign-ins'\)/);
    expect(signIns).toMatch(/import \{ formatDateTime \} from '\.\.\/\.\.\/utils\/formatDate';/);
    expect(signIns).toMatch(/\{formatDateTime\(e\.at, user\?\.timezone\)\}/);
    expect(signIns).toMatch(/<span className=\{signInTone\(e\.action\)\}>\{signInLabel\(e\)\}<\/span>/);
    expect(signIns).toMatch(/\{e\.ip \|\| '—'\}/);
    expect(signIns).toContain('No sign-ins recorded yet.');
    expect(signIns).toMatch(/<RetryAlert message=\{`Could not load the sign-ins\. \$\{error\}`\} onRetry=\{load\}/);
    // The table scrolls sideways in its own box on a phone.
    expect(signIns).toMatch(/overflowX: 'auto'/);
  });
});
