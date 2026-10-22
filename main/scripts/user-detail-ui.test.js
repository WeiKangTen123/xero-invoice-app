const fs   = require('fs');
const path = require('path');

// Admin › Users › an account's detail panel, on the screen side. There is no
// React test setup in this project (see login-ui.test.js), so what each line
// of the panel says, and which controls it offers, are plain functions in a
// file with no imports (pages/admin/user-detail.js), loaded whole and run
// here against a fixed clock; the wiring (rows open the panel, the panel
// fetches the detail and closes on Escape, Revoke asks first, the DB-IP
// credit is a link) is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const d = load('pages/admin/user-detail.js');

// 10:30 on 20 Oct 2026 in Singapore. The tests name the zone so they read
// the same on any machine.
const NOW  = Date.parse('2026-10-20T02:30:00.000Z');
const SG   = 'Asia/Singapore';
const ago  = ms => new Date(NOW - ms).toISOString();
const MIN  = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const inMin = n => new Date(NOW + n * MIN).toISOString();

describe('relativeTime', () => {
  test('just now, minutes, hours, days, months and years', () => {
    expect(d.relativeTime(ago(30 * 1000), NOW)).toBe('just now');
    expect(d.relativeTime(ago(2 * MIN), NOW)).toBe('2 min ago');
    expect(d.relativeTime(ago(59 * MIN), NOW)).toBe('59 min ago');
    expect(d.relativeTime(ago(HOUR), NOW)).toBe('1 h ago');
    expect(d.relativeTime(ago(23 * HOUR + 59 * MIN), NOW)).toBe('23 h ago');
    expect(d.relativeTime(ago(DAY), NOW)).toBe('1 d ago');
    expect(d.relativeTime(ago(29 * DAY), NOW)).toBe('29 d ago');
    expect(d.relativeTime(ago(30 * DAY), NOW)).toBe('1 mo ago');
    expect(d.relativeTime(ago(360 * DAY), NOW)).toBe('11 mo ago');
    expect(d.relativeTime(ago(400 * DAY), NOW)).toBe('1 y ago');
  });

  test('a time a little ahead of this clock is just now; no time is nothing', () => {
    expect(d.relativeTime(inMin(1), NOW)).toBe('just now');
    expect(d.relativeTime(null, NOW)).toBe('');
    expect(d.relativeTime(undefined, NOW)).toBe('');
    expect(d.relativeTime('soon', NOW)).toBe('');
    // A Date and a number are times too.
    expect(d.relativeTime(new Date(NOW - 5 * MIN), new Date(NOW))).toBe('5 min ago');
    expect(d.relativeTime(NOW - 5 * MIN, NOW)).toBe('5 min ago');
  });
});

describe('the dates, in the admin\'s timezone', () => {
  const o = { timeZone: SG, now: NOW };

  test('day and month, with the year only when it is not this one', () => {
    expect(d.shortDateTime('2026-10-19T15:53:00.000Z', o)).toBe('19 Oct 23:53');
    expect(d.shortDateTime('2025-06-01T00:00:00.000Z', o)).toBe('1 Jun 2025 08:00');
    // The zone decides the day, and so the year.
    expect(d.shortDateTime('2025-12-31T16:30:00.000Z', o)).toBe('1 Jan 00:30');
    expect(d.shortDateTime('2025-12-31T16:30:00.000Z', { timeZone: 'UTC', now: NOW })).toBe('31 Dec 2025 16:30');
    expect(d.shortDate('2026-10-16T09:11:00.000Z', o)).toBe('16 Oct');
    expect(d.fullDate('2026-09-03T01:00:00.000Z', o)).toBe('3 Sep 2026');
    expect(d.shortDateTime(null, o)).toBe('');
  });

  test('the time alone today, the date with it on any other day; midnight is 00, not 24', () => {
    expect(d.whenLabel('2026-10-20T01:12:00.000Z', o)).toBe('09:12');
    expect(d.whenLabel('2026-10-19T15:53:00.000Z', o)).toBe('19 Oct 23:53');
    expect(d.whenLabel('2026-10-19T16:05:00.000Z', o)).toBe('00:05');
    expect(d.whenLabel('2026-10-19T16:05:00.000Z', { timeZone: 'UTC', now: NOW })).toBe('19 Oct 16:05');
  });
});

describe('the head of the panel (statusLine)', () => {
  const jane = {
    id: 'u2', email: 'jane@nexsoss.com', role: 'user', demo: false,
    createdAt: '2026-09-03T01:00:00.000Z', lastLoginAt: '2026-10-20T01:12:00.000Z', lastSeenAt: ago(2 * MIN),
    online: false, disabledAt: null, mustChangePassword: false, tempPasswordExpiresAt: null,
    passwordChangedAt: '2026-10-16T09:11:00.000Z', failedLogins: 0, lockedUntil: null, lockCount: 0, lastLockedAt: null,
  };
  const line = (extra, opts = { timeZone: SG }) => d.statusLine({ ...jane, ...extra }, NOW, opts);

  test('an ordinary account: active, role and joined; last sign-in and when last about; password changed', () => {
    expect(line()).toEqual({
      state: { label: 'Active', tone: 'gray' },
      summary: 'Active · user · joined 3 Sep 2026',
      badges: [],
      seen: 'Last sign-in 20 Oct 09:12 · active 2 min ago',
      notes: [{ text: 'Password changed 16 Oct', tone: null }],
    });
  });

  test('online now', () => {
    const l = line({ online: true });
    expect(l.state).toEqual({ label: 'Online', tone: 'green' });
    expect(l.seen).toBe('Last sign-in 20 Oct 09:12 · online now');
  });

  test('locked: the state, and until when with the wrong passwords counted; no separate failed note', () => {
    const l = line({ failedLogins: 5, lockedUntil: inMin(15), lockCount: 2, lastLockedAt: '2026-10-19T15:54:00.000Z' });
    expect(l.state).toEqual({ label: 'Locked', tone: 'red' });
    expect(l.summary).toBe('Locked · user · joined 3 Sep 2026');
    expect(l.notes).toEqual([
      { text: 'Password changed 16 Oct', tone: null },
      { text: '🔒 Locked until 10:45 (5 failed)', tone: 'red' },
      { text: 'Locked 2 times, last 19 Oct', tone: null },
    ]);
    expect(line({ lockedUntil: inMin(15) }, { timeZone: 'UTC' }).notes).toContainEqual({ text: '🔒 Locked until 02:45', tone: 'red' });
  });

  test('a lock that has passed is no lock; its wrong passwords are a quiet warning', () => {
    const l = line({ failedLogins: 3, lockedUntil: inMin(-1) });
    expect(l.state.label).toBe('Active');
    expect(l.notes).toContainEqual({ text: '3 failed attempts since the last sign-in', tone: 'yellow' });
    expect(line({ failedLogins: 1 }).notes).toContainEqual({ text: '1 failed attempt since the last sign-in', tone: 'yellow' });
    expect(line({ lockCount: 1 }).notes).toContainEqual({ text: 'Locked 1 time', tone: null });
  });

  test('disabled wins over locked and online, and says since when', () => {
    const l = line({ disabledAt: '2026-10-18T04:00:00.000Z', lockedUntil: inMin(15), online: true });
    expect(l.state).toEqual({ label: 'Disabled', tone: 'red' });
    expect(l.summary).toBe('Disabled · user · joined 3 Sep 2026');
    expect(l.notes[0]).toEqual({ text: 'Disabled since 18 Oct', tone: 'red' });
  });

  test('a demo account and an admin carry their badges', () => {
    expect(line({ demo: true }).badges).toEqual([{ key: 'demo', text: 'demo', title: 'Demo account: sample data, no Xero connection' }]);
    const admin = line({ role: 'admin', demo: true });
    expect(admin.summary).toBe('Active · admin · joined 3 Sep 2026');
    expect(admin.badges.map(b => b.text)).toEqual(['sample data', '★ admin']);
    expect(line({ role: 'admin' }).badges.map(b => b.text)).toEqual(['★ admin']);
    expect(line({ demo: 'true' }).badges).toEqual([]);
  });

  // An admin switches their own account between Xero and sample data; the
  // panel says it is their choice, as the Users row does (demoBadge).
  test('an admin on sample data: their choice, their Xero connection kept', () => {
    expect(line({ role: 'admin', demo: true }).badges[0])
      .toEqual({ key: 'demo', text: 'sample data', title: 'On sample data by their own choice; their Xero connection is kept' });
  });

  test('a temporary password still to be replaced: when it expires, or that it has', () => {
    expect(line({ mustChangePassword: true, tempPasswordExpiresAt: '2026-10-21T01:12:00.000Z' }).notes)
      .toContainEqual({ text: 'Temporary password, expires 21 Oct 09:12', tone: 'yellow' });
    expect(line({ mustChangePassword: true, tempPasswordExpiresAt: '2026-10-19T01:12:00.000Z' }).notes)
      .toContainEqual({ text: 'Temporary password expired 19 Oct 09:12: send a reset link to let them in', tone: 'red' });
    // No expiry: their own password, which the rules now refuse (users.js
    // requirePasswordChange). It still signs in, to the change-password screen.
    expect(line({ mustChangePassword: true }).notes)
      .toContainEqual({ text: 'Must choose a new password: theirs no longer meets the rules', tone: 'yellow' });
    expect(line({ tempPasswordExpiresAt: '2026-10-21T01:12:00.000Z' }).notes.map(n => n.text).join()).not.toMatch(/Temporary/);
  });

  test('an account never signed in, and one the server says little about', () => {
    expect(line({ lastLoginAt: null, lastSeenAt: null, passwordChangedAt: null }))
      .toMatchObject({ seen: 'Never signed in', notes: [] });
    expect(d.statusLine(null, NOW)).toMatchObject({ state: { label: 'Active' }, summary: 'Active · user', seen: 'Never signed in', notes: [], badges: [] });
  });
});

describe('a sign-in row (signInRow)', () => {
  test('each result in plain words, with an icon and a tone', () => {
    expect(d.signInRow({ result: 'success' })).toEqual({ icon: '✓', label: 'Signed in', tone: 'green' });
    expect(d.signInRow({ result: 'failure' })).toEqual({ icon: '✕', label: 'Wrong password', tone: 'yellow' });
    expect(d.signInRow({ result: 'locked' })).toEqual({ icon: '🔒', label: 'Locked', tone: 'red' });
    expect(d.signInRow({ result: 'unlocked' })).toEqual({ icon: '🔓', label: 'Unlocked', tone: 'blue' });
    expect(d.signInRow({ result: 'logout' })).toEqual({ icon: '⇥', label: 'Signed out', tone: 'gray' });
    expect(d.signInRow({ result: 'revoked' })).toEqual({ icon: '⇥', label: 'Session ended by admin', tone: 'gray' });
  });

  test('a lock says how long it was for, wherever the record carries the minutes', () => {
    expect(d.signInRow({ result: 'locked', lockMinutes: 15 }).label).toBe('Locked 15 min');
    expect(d.signInRow({ result: 'locked', details: { lockMinutes: 30 } }).label).toBe('Locked 30 min');
    expect(d.signInRow({ result: 'locked', reason: '15' }).label).toBe('Locked 15 min');
    expect(d.signInRow({ result: 'locked', reason: 'too many' }).label).toBe('Locked');
    expect(d.signInRow({ result: 'locked', lockMinutes: 0 }).label).toBe('Locked');
  });

  test('a refused sign-in says why', () => {
    expect(d.signInRow({ result: 'refused', reason: 'locked' })).toEqual({ icon: '⛔', label: 'Refused: account locked', tone: 'red' });
    expect(d.signInRow({ result: 'refused', reason: 'disabled' }).label).toBe('Refused: account disabled');
    expect(d.signInRow({ result: 'refused', reason: 'expired_temporary' }).label).toBe('Refused: temporary password expired');
    expect(d.signInRow({ result: 'refused' }).label).toBe('Refused');
  });

  test('a record with only its action reads the same; anything else is named as recorded', () => {
    expect(d.signInRow({ action: 'login.success' }).label).toBe('Signed in');
    expect(d.signInRow({ action: 'login.failed' }).label).toBe('Wrong password');
    expect(d.signInRow({ action: 'login.locked', details: { lockMinutes: 15 } }).label).toBe('Locked 15 min');
    expect(d.signInRow({ action: 'login.unlocked' }).label).toBe('Unlocked');
    expect(d.signInRow({ action: 'login.refused', reason: 'disabled' }).label).toBe('Refused: account disabled');
    expect(d.signInRow({ action: 'logout' }).label).toBe('Signed out');
    expect(d.signInRow({ action: 'session.revoke' }).label).toBe('Session ended by admin');
    // The result wins over the action.
    expect(d.signInRow({ action: 'login.success', result: 'failure' }).label).toBe('Wrong password');
    expect(d.signInRow({ action: 'something.new' })).toEqual({ icon: '•', label: 'something.new', tone: 'gray' });
    expect(d.signInRow(null)).toEqual({ icon: '•', label: 'Unknown', tone: 'gray' });
  });

  test('where it came from: the device and the place, as the server labels them', () => {
    expect(d.whereLabel({ device: 'Chrome · Windows', location: 'Singapore · Singtel' })).toBe('Chrome · Windows · Singapore · Singtel');
    expect(d.whereLabel({ device: 'Chrome · Windows', location: '' })).toBe('Chrome · Windows');
    expect(d.whereLabel({ location: 'Private network' })).toBe('Private network');
    expect(d.whereLabel({})).toBe('');
  });
});

describe('sessions', () => {
  const o = { timeZone: SG };
  const mine = { sid: 's1', createdAt: '2026-10-20T01:12:00.000Z', lastSeenAt: ago(2 * MIN), ip: '203.0.113.5', location: 'Singapore · Singtel', device: 'Chrome · Windows', isNew: false, current: true };
  const phone = { sid: 's2', createdAt: '2026-10-19T15:53:00.000Z', lastSeenAt: ago(HOUR), ip: '116.88.4.20', location: 'Kuala Lumpur, Malaysia · Maxis', device: 'Safari · iPhone', isNew: true, current: false };

  test('this device: started today, seen just now, not revocable here', () => {
    expect(d.sessionRow(mine, NOW, o)).toEqual({
      device: 'Chrome · Windows', ip: '203.0.113.5', location: 'Singapore · Singtel',
      when: 'started 09:12 · seen 2 min ago', current: true, isNew: false, canRevoke: false,
    });
  });

  test('another device: new, started yesterday, revocable', () => {
    expect(d.sessionRow(phone, NOW, o)).toMatchObject({ when: 'started 19 Oct 23:53 · seen 1 h ago', isNew: true, current: false, canRevoke: true });
  });

  test('what the server did not say is not made up; no sid, nothing to revoke', () => {
    expect(d.sessionRow({}, NOW, o)).toEqual({ device: 'Unknown device', ip: '', location: '', when: '', current: false, isNew: false, canRevoke: false });
  });

  test('the heading counts them', () => {
    expect(d.sessionsHeading([mine, phone])).toBe('Sessions (2 active)');
    expect(d.sessionsHeading([])).toBe('Sessions');
    expect(d.sessionsHeading(undefined)).toBe('Sessions');
  });

  // A token from before sessions were kept is now refused, so every way in is
  // listed: an empty list is signed in nowhere, and there is nothing to add.
  test('an empty list needs no note: every token now belongs to a listed session', () => {
    expect(d.UNLISTED_SESSIONS_NOTE).toBe('');
    expect(d.sessionsNote([], { lastSeenAt: ago(3 * HOUR) }, NOW)).toBe('');
    expect(d.sessionsNote([], { online: true }, NOW)).toBe('');
    expect(d.sessionsNote([phone], { online: true }, NOW)).toBe('');
  });
});

describe('the Work lines', () => {
  test('the watcher and auto-submit on one line', () => {
    expect(d.watcherLine({ watcher: { running: true, state: 'watching', enabled: true }, autoSubmit: false })).toEqual({ text: 'Running · auto-submit off', tone: 'green' });
    expect(d.watcherLine({ watcher: { running: true }, autoSubmit: true }).text).toBe('Running · auto-submit on');
    expect(d.watcherLine({ watcher: { running: false, state: 'reconnecting', enabled: true }, autoSubmit: false })).toEqual({ text: 'Reconnecting · auto-submit off', tone: 'yellow' });
    expect(d.watcherLine({ watcher: { running: false, state: 'connecting', enabled: true }, autoSubmit: true }).text).toBe('Connecting · auto-submit on');
  });

  test('a stopped watcher says why, in words; one the mail server stopped is red; one switched off is Off', () => {
    expect(d.watcherLine({ watcher: { running: false, state: 'stopped', reason: 'auth-failed', enabled: true }, autoSubmit: false }))
      .toEqual({ text: 'Stopped (the mail server refused the password) · auto-submit off', tone: 'red' });
    expect(d.watcherLine({ watcher: { running: false, state: 'stopped', reason: 'max-retries', enabled: true }, autoSubmit: false }).tone).toBe('red');
    expect(d.watcherLine({ watcher: { running: false, state: 'stopped', reason: 'idle', enabled: true }, autoSubmit: false }))
      .toEqual({ text: 'Stopped (owner away) · auto-submit off', tone: 'gray' });
    expect(d.watcherLine({ watcher: { running: false, state: 'stopped', reason: 'manual', enabled: true }, autoSubmit: false }).text)
      .toBe('Stopped (stopped by hand) · auto-submit off');
    expect(d.watcherLine({ watcher: { running: false, state: 'stopped', reason: null, enabled: false }, autoSubmit: false }))
      .toEqual({ text: 'Off · auto-submit off', tone: 'gray' });
    // A state or reason this page does not know yet is said as it comes.
    expect(d.watcherLine({ watcher: { running: false, state: 'paused_for_quota', reason: 'quota', enabled: true }, autoSubmit: false }).text)
      .toBe('Paused for quota (quota) · auto-submit off');
    expect(d.watcherLine(null)).toEqual({ text: 'Stopped · auto-submit off', tone: 'gray' });
  });

  test('the mailbox', () => {
    expect(d.mailboxLine({ configured: true, address: 'jane@nexsoss.com' })).toBe('jane@nexsoss.com');
    expect(d.mailboxLine({ configured: true })).toBe('Set up');
    expect(d.mailboxLine({ configured: false, address: 'x@y.z' })).toBe('Not set up');
    expect(d.mailboxLine(undefined)).toBe('Not set up');
  });

  test('Xero connected: the companies, how, and when the token was refreshed', () => {
    expect(d.xeroLine({ connected: true, method: 'oauth', organisations: ['Nexsoss Pte Ltd'], lastRefreshedAt: ago(HOUR) }, { now: NOW }))
      .toEqual({ text: 'Nexsoss Pte Ltd · OAuth · refreshed 1 h ago', tone: 'green' });
    expect(d.xeroLine({ connected: true, method: 'custom', organisations: ['A', 'B', 'C', 'D'] }, { now: NOW }).text)
      .toBe('A, B +2 more · Custom Connection');
    expect(d.xeroLine({ connected: true }, { now: NOW }).text).toBe('Connected');
  });

  test('Xero not connected, or needing a reconnect, says why', () => {
    expect(d.xeroLine({ connected: false, reason: 'No credentials saved' }, { now: NOW })).toEqual({ text: 'Not connected · No credentials saved', tone: 'gray' });
    expect(d.xeroLine({ connected: false }, { now: NOW }).text).toBe('Not connected');
    expect(d.xeroLine(null, { now: NOW }).text).toBe('Not connected');
    expect(d.xeroLine({ connected: true, needsReconnect: true, reason: 'Refresh token expired', organisations: ['Nexsoss Pte Ltd'] }, { now: NOW }))
      .toEqual({ text: 'Nexsoss Pte Ltd · needs reconnecting: Refresh token expired', tone: 'yellow' });
  });

  test('a demo account names its Demo Company and says nothing goes to Xero', () => {
    const line = { text: 'Demo Company Pte Ltd · sample data, no Xero connection', tone: 'gray' };
    expect(d.xeroLine({ connected: true, method: 'demo', organisations: ['Demo Company Pte Ltd'] }, { now: NOW })).toEqual(line);
    expect(d.xeroLine({ connected: false }, { demo: true, now: NOW })).toEqual(line);
    expect(d.xeroLine({ connected: true, method: 'demo', organisations: ['Sample Co'] }, { now: NOW }).text).toBe('Sample Co · sample data, no Xero connection');
    expect(d.xeroLine({ connected: false }, { demo: true, role: 'user', now: NOW })).toEqual(line);
  });

  test('an admin on sample data: their choice, and nothing said of a missing connection', () => {
    const line = { text: 'Demo Company Pte Ltd · sample data (their choice)', tone: 'gray' };
    expect(d.xeroLine({ connected: true, method: 'demo', organisations: ['Demo Company Pte Ltd'] }, { role: 'admin', now: NOW })).toEqual(line);
    expect(d.xeroLine({ connected: false }, { demo: true, role: 'admin', now: NOW })).toEqual(line);
    // An admin on Xero reads as anyone on Xero.
    expect(d.xeroLine({ connected: true, method: 'oauth', organisations: ['Nexsoss Pte Ltd'] }, { demo: false, role: 'admin', now: NOW }).text)
      .toBe('Nexsoss Pte Ltd · OAuth');
  });

  test('documents: only the counts that are not zero, in the order a document moves', () => {
    expect(d.documentsLine({ pending: 12, reviewNeeded: 3, reviewed: 0, submitting: 0, posted: 140, error: 1, duplicate: 0, reported: 0, total: 156 }))
      .toBe('12 pending · 3 to review · 140 posted · 1 error');
    expect(d.documentsLine({ reviewed: 2, submitting: 1, error: 2, duplicate: 3, reported: 1 }))
      .toBe('2 reviewed · 1 submitting · 2 errors · 3 duplicates · 1 reported');
    expect(d.documentsLine({ duplicate: 1 })).toBe('1 duplicate');
    expect(d.documentsLine({ pending: 0, posted: 0, total: 0 })).toBe('None yet');
    expect(d.documentsLine(null)).toBe('None yet');
  });

  test('the queue: waiting, processing, and failed with the last error, cut short', () => {
    expect(d.queueLine({ pending: 0, processing: 0, dead: 0, lastError: null })).toEqual({ text: '0 waiting', tone: null, title: '' });
    expect(d.queueLine({ pending: 2, processing: 1, dead: 0 }).text).toBe('2 waiting · 1 processing');
    expect(d.queueLine({ pending: 0, dead: 1, lastError: 'Gemini quota exceeded' }))
      .toEqual({ text: '0 waiting · 1 failed: "Gemini quota exceeded"', tone: 'red', title: 'Gemini quota exceeded' });
    const long = 'x'.repeat(300);
    const q = d.queueLine({ dead: 2, lastError: long });
    expect(q.text).toBe(`0 waiting · 2 failed: "${'x'.repeat(119)}…"`);
    expect(q.title).toBe(long);
    expect(d.queueLine({ dead: 1 }).text).toBe('0 waiting · 1 failed');
  });

  test('storage in KB, MB and GB', () => {
    expect(d.formatBytes(0)).toBe('0 KB');
    expect(d.formatBytes(10)).toBe('0.1 KB');
    expect(d.formatBytes(512 * 1024)).toBe('512 KB');
    expect(d.formatBytes(1536)).toBe('1.5 KB');
    expect(d.formatBytes(48.2 * 1024 * 1024)).toBe('48.2 MB');
    expect(d.formatBytes(1024 * 1024)).toBe('1 MB');
    expect(d.formatBytes(1024 ** 3)).toBe('1 GB');
    expect(d.formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    for (const bad of [null, undefined, '', 'lots', -1, NaN]) expect(d.formatBytes(bad)).toBe('—');
  });

  test('the storage line, with the Gemini keys and what makes up the total', () => {
    expect(d.storageLine({ bytes: 48.2 * 1024 * 1024, receipts: 12 * 1024 * 1024, pdfs: 30 * 1024 * 1024, queue: 1024 }, 2))
      .toEqual({ text: '48.2 MB · Gemini keys 2', title: 'Receipts 12 MB · PDFs 30 MB · Queue 1 KB' });
    expect(d.storageLine({ bytes: 0 }, undefined)).toEqual({ text: '0 KB', title: '' });
    expect(d.storageLine(null, 0).text).toBe('— · Gemini keys 0');
  });
});

describe('an activity row (activityRow)', () => {
  test('a document plainly; something done to the account muted, with who did it', () => {
    expect(d.activityRow({ at: 'x', kind: 'document', summary: 'Posted INV-0412 to Xero', by: null }))
      .toEqual({ text: 'Posted INV-0412 to Xero', by: '', muted: false });
    expect(d.activityRow({ at: 'x', kind: 'account', summary: 'Password reset', by: 'weikangten@gmail.com' }))
      .toEqual({ text: 'Password reset', by: 'by weikangten@gmail.com', muted: true });
    expect(d.activityRow({ kind: 'account', summary: 'Unlocked' })).toEqual({ text: 'Unlocked', by: '', muted: true });
    expect(d.activityRow(null)).toEqual({ text: '', by: '', muted: false });
  });
});

describe('the controls the panel offers (panelActions)', () => {
  const jane = { id: 'u2', email: 'jane@nexsoss.com', role: 'user', disabledAt: null, lockedUntil: null };
  const keys = groups => groups.map(g => [g.key, g.actions.map(a => a.key)]);
  const find = (groups, key) => groups.flatMap(g => g.actions).find(a => a.key === key);

  test('another account: role and reset, then Disable and Delete last, in Danger', () => {
    const groups = d.panelActions({ user: jane, now: NOW });
    expect(keys(groups)).toEqual([['account', ['role', 'reset']], ['danger', ['disabled', 'delete']]]);
    expect(groups.map(g => g.label)).toEqual(['Account', 'Danger']);
    expect(find(groups, 'role').label).toBe('★ Make admin');
    expect(find(groups, 'reset').label).toBe('🔑 Send reset link');
    expect(find(groups, 'disabled').label).toBe('⏸ Disable');
    expect(find(groups, 'delete')).toMatchObject({ label: '✕ Delete', danger: true, blocked: null });
  });

  test('a locked account offers Unlock first; an admin Make user; a disabled one Enable', () => {
    const locked = d.panelActions({ user: { ...jane, lockedUntil: inMin(15) }, now: NOW });
    expect(locked[0].actions[0]).toMatchObject({ key: 'unlock', busyKey: 'unlock', label: '🔓 Unlock' });
    expect(keys(d.panelActions({ user: { ...jane, lockedUntil: inMin(-1) }, now: NOW }))[0][1]).not.toContain('unlock');
    expect(find(d.panelActions({ user: { ...jane, role: 'admin' }, now: NOW }), 'role').label).toBe('◦ Make user');
    expect(find(d.panelActions({ user: { ...jane, disabledAt: '2026-10-18T04:00:00.000Z' }, now: NOW }), 'disabled').label).toBe('✓ Enable');
  });

  // A reset is a link for the person to choose their own password, for
  // every account, a demo account's included: an admin no longer sets a
  // temporary one (invite-ui.test.js has the invited account's controls).
  test('Send reset link says it is a link, emailed or to copy, never a password the admin sets', () => {
    const title = user => find(d.panelActions({ user: { ...jane, ...user }, now: NOW }), 'reset').title;
    const said = 'A link to choose a new password: emailed to them, or for you to copy and send';
    expect(title({ demo: true })).toBe(said);
    expect(title({ demo: true, role: 'admin' })).toBe(said);
    expect(title({ demo: false })).toBe(said);
    expect(title({ role: 'admin' })).toBe(said);
    expect(said).not.toMatch(/temporary/i);
  });

  test('the last admin cannot be demoted, disabled or deleted, and each button says so', () => {
    const groups = d.panelActions({ user: { ...jane, role: 'admin' }, lastAdmin: true, now: NOW });
    expect(find(groups, 'role').blocked).toBe('Cannot demote the last admin');
    expect(find(groups, 'disabled').blocked).toBe('Cannot disable the last admin');
    expect(find(groups, 'delete').blocked).toBe('Cannot delete the last admin');
    expect(find(groups, 'reset').blocked).toBeUndefined();
  });

  test('automation once the detail says a watcher runs or auto-submit is on, named as control() marks it', () => {
    const work = { watcher: { running: true }, autoSubmit: true };
    const groups = d.panelActions({ user: jane, now: NOW, work });
    expect(keys(groups)).toEqual([
      ['account', ['role', 'reset']], ['automation', ['stopWatcher', 'autoSubmitOff']], ['danger', ['disabled', 'delete']],
    ]);
    expect(find(groups, 'stopWatcher')).toMatchObject({ busyKey: 'watcher', label: '■ Stop watcher' });
    expect(find(groups, 'autoSubmitOff')).toMatchObject({ busyKey: 'auto', label: '⏻ Turn off auto-submit' });
    expect(keys(d.panelActions({ user: jane, now: NOW, work: { watcher: { running: false }, autoSubmit: false } })).map(g => g[0])).not.toContain('automation');
    // A watcher in a backoff is not running, and can still be stopped.
    expect(keys(d.panelActions({ user: jane, now: NOW, work: { watcher: { running: false, state: 'reconnecting' }, autoSubmit: false } })))
      .toContainEqual(['automation', ['stopWatcher']]);
    expect(keys(d.panelActions({ user: jane, now: NOW, work: null })).map(g => g[0])).not.toContain('automation');
  });

  test('your own account: only what the server allows on yourself', () => {
    expect(d.panelActions({ user: jane, isMe: true, now: NOW })).toEqual([]);
    const groups = d.panelActions({ user: { ...jane, lockedUntil: inMin(15) }, isMe: true, now: NOW, work: { watcher: { running: true }, autoSubmit: true } });
    expect(keys(groups)).toEqual([['account', ['unlock']], ['automation', ['stopWatcher', 'autoSubmitOff']]]);
    expect(d.SELF_NOTE).toMatch(/Account page/);
  });
});

describe('the DB-IP credit (attributionOf)', () => {
  test('the server\'s, or the same link when it sends none', () => {
    const credit = { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' };
    expect(d.ATTRIBUTION).toEqual(credit);
    expect(d.attributionOf(null)).toEqual(credit);
    expect(d.attributionOf({ attribution: { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com/db/' } }))
      .toEqual({ text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com/db/' });
    // Never a link that is not https (javascript:, a bare word).
    expect(d.attributionOf({ attribution: { text: 'x', url: 'javascript:alert(1)' } })).toEqual(credit);
    expect(d.attributionOf({ attribution: { text: '', url: 'https://db-ip.com' } })).toEqual(credit);
    // A fresh object each time: nothing can change the default.
    expect(d.attributionOf(null)).not.toBe(d.ATTRIBUTION);
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────────
describe('Admin › Users opens the panel and shares its handlers with it', () => {
  const admin = read('pages/Admin.jsx');
  const fn = name => admin.slice(admin.indexOf(`async function ${name}(`), admin.indexOf('\n  }\n', admin.indexOf(`async function ${name}(`)));

  test('every row opens the panel, your own too, by click and by Enter or Space', () => {
    expect(admin).toMatch(/import UserDetailPanel from '\.\/admin\/UserDetailPanel';/);
    expect(admin).toMatch(/role="button"\s+tabIndex=\{0\}\s+aria-haspopup="dialog"\s+onClick=\{\(\) => openDetail\(u\.id\)\}/);
    expect(admin).toMatch(/if \(e\.key !== 'Enter' && e\.key !== ' '\) return;\s+\/\/[^\n]*\n\s+e\.preventDefault\(\);\s+openDetail\(u\.id\);/);
    // The row no longer keeps its own row closed, nor an inline strip of
    // controls: the only ones on a row are an invited account's New link
    // and Revoke (invite-ui.test.js), which keep their clicks and keys from
    // the row.
    expect(admin).not.toMatch(/role=\{isMe \? undefined : 'button'\}/);
    expect(admin).not.toMatch(/if \(!isMe\) setSelectedId/);
    expect(admin).not.toContain('selectedId');
    const onRow = [...admin.matchAll(/onClick=\{\(\) => (handle\w+)\(u\)\}/g)].map(m => m[1]).sort();
    expect(onRow).toEqual(['handleNewInvite', 'handleRevokeInvite']);
    expect(admin).toMatch(/<RowButton onClick=\{\(\) => handleNewInvite\(u\)\}/);
    expect(admin).toMatch(/<RowButton onClick=\{\(\) => handleRevokeInvite\(u\)\}/);
  });

  test('the panel is given the account, whether it is you, the last-admin rule, and the page\'s handlers', () => {
    expect(admin).toMatch(/\{tab === 'users' && detailUser && \(\s+<UserDetailPanel/);
    expect(admin).toContain('const detailUser = detailId ? users.find(u => u.id === detailId) : null;');
    expect(admin).toMatch(/isMe=\{detailUser\.id === me\?\.id\}/);
    expect(admin).toMatch(/lastAdmin=\{isLastAdmin\(detailUser\)\}/);
    expect(admin).toContain("const isLastAdmin = u => u.role === 'admin' && !u.disabledAt && admins.length <= 1;");
    expect(admin).toMatch(/busy=\{busy\}\s+error=\{actionError\}\s+refreshKey=\{detailRefresh\}\s+actions=\{userActions\}\s+onClose=\{closeDetail\}/);
    const actions = admin.slice(admin.indexOf('const userActions = {'), admin.indexOf('};', admin.indexOf('const userActions = {')));
    for (const pair of ['unlock: handleUnlock', 'role: handleRole', 'reset: handleResetLink', 'signOut: handleSignOut',
      'disabled: handleDisabled', 'remove: handleDelete', 'stopWatcher: handleStopWatcher',
      'autoSubmitOff: handleAutoSubmitOff', 'revokeSession: handleRevokeSession',
      'invite: handleNewInvite', 'revokeInvite: handleRevokeInvite']) {
      expect(actions).toContain(pair);
    }
  });

  test('a control refreshes the open panel, and says how it went where the panel shows it', () => {
    const control = admin.slice(admin.indexOf('async function control(key, u, send, done) {'), admin.indexOf('function openDetail('));
    // `done` is the toast, or a function making it from the server's answer.
    expect(control).toMatch(/const answer = await send\(\);\s+if \(done\) toast\.success\(typeof done === 'function' \? done\(answer \|\| \{\}\) : done\);\s+setDetailRefresh\(n => n \+ 1\);\s+await fetchUsers\(\);\s+return true;/);
    expect(control).toMatch(/setActionError\(err\.message\);/);
    // Send reset link and New link go through control() too, so they refresh
    // the panel; what came back opens in a dialog over it.
    expect(fn('handleResetLink')).toMatch(/const sent = await control\('reset', u, async \(\) => \{/);
    expect(fn('handleResetLink')).toMatch(/if \(sent\) setShownLink\(\{ kind: 'reset', email: u\.email, answer: answer\?\.reset \|\| \{\} \}\);/);
    expect(fn('handleNewInvite')).toMatch(/const sent = await control\('invite', u, async \(\) => \{/);
    // A control used from a row has no panel to say an error in: a toast does.
    expect(control).toMatch(/if \(detailId !== u\.id\) toast\.error\(err\.message\);/);
    // A deleted account's panel closes.
    expect(fn('handleDelete')).toMatch(/setDetailId\(id => \(id === u\.id \? null : id\)\);/);
  });

  test('Revoke asks first, then calls the session route', () => {
    const revoke = fn('handleRevokeSession');
    expect(revoke).toMatch(/await confirm\(\{/);
    expect(revoke).toMatch(/api\.post\(`\/admin\/users\/\$\{u\.id\}\/sessions\/\$\{encodeURIComponent\(s\.sid\)\}\/revoke`, \{\}\)/);
    expect(revoke.indexOf('await confirm(')).toBeLessThan(revoke.indexOf('api.post('));
    expect(revoke).toMatch(/if \(!\(await confirm\([\s\S]*?\)\)\) return;/);
    expect(revoke).toMatch(/await control\(`revoke:\$\{s\.sid\}`, u,/);
  });

  test('Revoke all is Sign out everywhere: asked first, then the sign-out route', () => {
    const signOut = fn('handleSignOut');
    expect(signOut).toMatch(/if \(!\(await confirm\(\{ title: `Sign \$\{u\.email\} out everywhere\?`/);
    expect(signOut).toMatch(/api\.post\(`\/admin\/users\/\$\{u\.id\}\/sign-out`, \{\}\)/);
  });

  test('Stop watcher and Turn off auto-submit are asked and sent the same way from Monitoring and from the panel', () => {
    expect((admin.match(/await confirm\(stopWatcherAsk\(u\)\)/g) || []).length).toBe(2);
    expect((admin.match(/=> stopWatcherSend\(u\)/g) || []).length).toBe(2);
    expect((admin.match(/await confirm\(autoSubmitOffAsk\(u\)\)/g) || []).length).toBe(2);
    expect((admin.match(/=> autoSubmitOffSend\(u\)/g) || []).length).toBe(2);
    expect(admin).toMatch(/api\.post\(`\/admin\/users\/\$\{u\.id\}\/watcher\/stop`, \{\}\)/);
    expect(admin).toMatch(/api\.patch\(`\/admin\/users\/\$\{u\.id\}\/auto-process`, \{ autoProcess: false \}\)/);
    expect(fn('handleStopWatcher')).toMatch(/await control\('watcher', u,/);
    expect(fn('handleAutoSubmitOff')).toMatch(/await control\('auto', u,/);
  });
});

describe('the panel', () => {
  const panel = read('pages/admin/UserDetailPanel.jsx');

  test('takes its wording from the helpers', () => {
    expect(panel).toMatch(/from '\.\/user-detail';/);
    for (const name of ['statusLine', 'signInRow', 'sessionRow', 'sessionsNote', 'xeroLine', 'documentsLine', 'storageLine', 'panelActions', 'attributionOf']) {
      expect(panel).toMatch(new RegExp(`\\b${name}\\(`));
    }
  });

  test('the Xero line is told the role, to tell an admin\'s chosen sample data from a demo account\'s', () => {
    expect(panel).toContain('<WorkSection work={work} demo={acct.demo === true} role={acct.role} now={now} />');
    expect(panel).toContain('function WorkSection({ work, demo, role, now }) {');
    expect(panel).toContain('xeroLine(work.xero, { demo, role, now })');
  });

  test('is a modal dialog named by its heading: a centred two-column window on the web, a full-screen sheet with tabs on a phone', () => {
    expect(panel).toMatch(/role="dialog"\s+aria-modal="true"\s+aria-labelledby=\{TITLE_ID\}/);
    expect(panel).toMatch(/<h2 id=\{TITLE_ID\}/);
    expect(panel).toMatch(/const \{ isMobile \} = useViewMode\(\);/);
    expect(panel).toMatch(/display: 'flex', alignItems: 'center', justifyContent: 'center',/);
    expect(panel).toMatch(/width: isMobile \? '100vw' : 'min\(960px, calc\(100vw - 32px\)\)'/);
    expect(panel).toMatch(/maxHeight: isMobile \? '100dvh' : '85vh'/);
    // Below the confirm and reset dialogs (Modal, zIndex 1000 and up), which open over it.
    expect(panel).toMatch(/zIndex: 301/);
    // Web: sessions and sign-ins on the left, work and activity on the right.
    expect(panel).toMatch(/gridTemplateColumns: '1fr 1fr'/);
    expect(panel).toMatch(/\{sessionsPart\}\s+\{signInsPart\}\s+<\/div>\s+<div style=\{column\}>\s+\{workPart\}\s+\{activityPart\}/);
    // Phone: one part at a time under tabs.
    expect(panel).toMatch(/role="tablist" aria-label="Parts of this account"/);
    expect(panel).toMatch(/\{PARTS\[phoneTab\]\}/);
  });

  test('Prev and Next (and the arrow keys) move through the list without closing', () => {
    expect(panel).toMatch(/aria-label="Previous account"/);
    expect(panel).toMatch(/aria-label="Next account"/);
    expect(panel).toMatch(/if \(e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'\)/);
    expect(panel).toMatch(/if \(!typing && !over && step\) \{ e\.preventDefault\(\); step\(\); \}/);
    expect(panel).toMatch(/useEffect\(\(\) => \{ setDetail\(null\); setAllSignIns\(false\); setPhoneTab\('sessions'\); \}, \[user\.id\]\);/);
    const admin = read('pages/Admin.jsx');
    expect(admin).toMatch(/const detailPrev  = detailIndex > 0 \? \(\) => openDetail\(users\[detailIndex - 1\]\.id\) : null;/);
    expect(admin).toMatch(/onPrev=\{detailPrev\}\s+onNext=\{detailNext\}/);
  });

  test('fetches the detail on open and after every control, with a loading state and a Retry', () => {
    expect(panel).toMatch(/await api\.get\(`\/admin\/users\/\$\{user\.id\}\/detail`\)/);
    expect(panel).toMatch(/useEffect\(\(\) => \{ load\(\); \}, \[load, refreshKey\]\);/);
    expect(panel).toMatch(/\{!detail && loading && \(/);
    expect(panel).toMatch(/<RetryAlert[^>]*\n?[^>]*onRetry=\{load\}/);
  });

  test('closes on ✕, on Escape unless a dialog over it takes Escape, and on a click on the page behind', () => {
    expect(panel).toMatch(/<button type="button" onClick=\{onClose\} aria-label="Close"/);
    expect(panel).toMatch(/if \(e\.key !== 'Escape'\) return;/);
    expect(panel).toMatch(/document\.querySelectorAll\('\[aria-modal="true"\]'\)\]\.some\(el => el !== panelRef\.current\)/);
    expect(panel).toMatch(/window\.addEventListener\('keydown', onKey, true\);/);
    expect(panel).toMatch(/window\.removeEventListener\('keydown', onKey, true\);/);
    expect(panel).toMatch(/<div aria-hidden="true" onClick=\{onClose\}/);
  });

  test('takes focus when it opens and gives it back to the row when it closes', () => {
    expect(panel).toMatch(/const opener = document\.activeElement;\s+panelRef\.current\?\.focus\(\);/);
    expect(panel).toMatch(/opener\.isConnected && typeof opener\.focus === 'function'\) opener\.focus\(\);/);
    expect(panel).toMatch(/tabIndex=\{-1\}\s+onKeyDown=\{trapTab\}/);
  });

  test('sessions: This device for the current one, Revoke for the others through the page, Revoke all except on yourself', () => {
    expect(panel).toMatch(/\{r\.current \? \(\s+<span className="badge badge-blue"[^>]*>This device<\/span>\s+\) : r\.canRevoke && \(/);
    expect(panel).toMatch(/onClick=\{\(\) => actions\.revokeSession\(user, s\)\}/);
    expect(panel).toMatch(/aside=\{!isMe && \(\s+<button[^>]*\n[^\n]*\n\s+onClick=\{\(\) => actions\.signOut\(user\)\}>/);
    expect(panel).toContain("'⇥ Revoke all'");
    expect(panel).toContain('<Quiet>No active sessions</Quiet>');
    expect(panel).toMatch(/\{note && <div[^>]*>\{note\}<\/div>\}/);
  });

  test('sign-ins: the IP inline on the web, on hover only on a phone; NEW is a muted badge', () => {
    expect(panel).toContain('const showIp = e.ip && (!isMobile || !where);');
    expect(panel).toMatch(/<div title=\{e\.ip \|\| undefined\}/);
    expect(panel).toMatch(/\{e\.isNew && <span className="badge badge-gray"[^>]*>NEW<\/span>\}/);
    expect(panel).toContain('Sign-ins (last 30 days)');
  });

  test('every control is the page\'s handler, held while another runs or when the server would refuse it', () => {
    for (const [key, call] of [['unlock', 'unlock'], ['role', 'role'], ['reset', 'reset'], ['stopWatcher', 'stopWatcher'],
      ['autoSubmitOff', 'autoSubmitOff'], ['disabled', 'disabled'], ['delete', 'remove'],
      ['invite', 'invite'], ['revokeInvite', 'revokeInvite']]) {
      expect(panel).toMatch(new RegExp(`${key}:\\s+\\(\\) => actions\\.${call}\\(user\\),`));
    }
    expect(panel).toMatch(/disabled=\{!!busy \|\| !!a\.blocked\}\s+title=\{a\.blocked \|\| a\.title\}\s+onClick=\{run\[a\.key\]\}/);
    expect(panel).toMatch(/\{inFlight\(a\.busyKey\) \? '…' : a\.label\}/);
    expect(panel).toMatch(/\{isMe && <div[^>]*>\{SELF_NOTE\}<\/div>\}/);
  });

  test('the DB-IP credit is a link, with the note that places are approximate', () => {
    expect(panel).toContain('const credit   = attributionOf(detail);');
    expect(panel).toMatch(/<a href=\{credit\.url\} target="_blank" rel="noopener noreferrer"[^>]*>\{credit\.text\}<\/a>/);
    expect(panel).toContain('Locations are approximate');
  });

  test('an account action is muted with who did it', () => {
    expect(panel).toMatch(/color: r\.muted \? MUTED : 'var\(--text-primary\)'/);
    expect(panel).toMatch(/\{r\.text\}\{r\.by \? ` · \$\{r\.by\}` : ''\}/);
  });
});
