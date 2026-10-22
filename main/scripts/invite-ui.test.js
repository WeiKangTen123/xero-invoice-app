const fs   = require('fs');
const path = require('path');

// Invites and reset links on the screen side: Admin › Users invites an
// account (no password: the person sets their own from a link), sends an
// account a reset link, and shows each link once when the server cannot
// email it; Setup has the email sending settings. There is no React test
// setup in this project (see login-ui.test.js), so the words — the result of
// an invite or a reset link, the note on an invited row, the expiry dates —
// are plain functions in files with no imports (pages/admin/users.js,
// pages/admin/user-detail.js, utils/formatDate.js), loaded whole and run
// here; the wiring is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const users  = load('pages/admin/users.js');
const detail = load('pages/admin/user-detail.js');
const dates  = load('utils/formatDate.js');

// 14:00 on 22 Oct 2026 in Singapore; the tests name the zone so they read
// the same on any machine.
const NOW = Date.parse('2026-10-22T06:00:00.000Z');
const SG  = 'Asia/Singapore';
const EXPIRES = '2026-10-29T06:05:00.000Z';   // 29 Oct, 14:05 in Singapore

describe('the expiry dates (formatShortDate, formatShortDateTime)', () => {
  test('"29 Oct" and "29 Oct, 14:05" in the given timezone', () => {
    expect(dates.formatShortDate(EXPIRES, SG, NOW)).toBe('29 Oct');
    expect(dates.formatShortDateTime(EXPIRES, SG, NOW)).toBe('29 Oct, 14:05');
    expect(dates.formatShortDateTime(EXPIRES, 'UTC', NOW)).toBe('29 Oct, 06:05');
    // A day later in Singapore than in UTC.
    expect(dates.formatShortDate('2026-10-29T17:00:00.000Z', SG, NOW)).toBe('30 Oct');
  });

  test('the year only when it is not this one; September as "Sep" in every browser', () => {
    expect(dates.formatShortDate('2027-01-05T02:00:00.000Z', SG, NOW)).toBe('5 Jan 2027');
    expect(dates.formatShortDateTime('2027-01-05T02:00:00.000Z', SG, NOW)).toBe('5 Jan 2027, 10:00');
    expect(dates.formatShortDate('2026-09-03T02:00:00.000Z', SG, NOW)).toBe('3 Sep');
  });

  test('nothing for no time, and midnight as 00, never 24', () => {
    for (const iso of [null, undefined, '', 'soon']) {
      expect(dates.formatShortDate(iso, SG, NOW)).toBe('');
      expect(dates.formatShortDateTime(iso, SG, NOW)).toBe('');
    }
    expect(dates.formatShortDateTime('2026-10-28T16:00:00.000Z', SG, NOW)).toBe('29 Oct, 00:00');
  });
});

describe('what an invite or a reset link came to (linkResult)', () => {
  const when = '29 Oct, 14:05';

  test('emailed: sent, and until when', () => {
    expect(users.linkResult('invite', { emailed: true, link: null, expiresAt: EXPIRES }, 'ana@co.sg', when)).toEqual({
      ok: true, emailed: true, link: null, text: 'Invite sent to ana@co.sg. It expires on 29 Oct, 14:05.', note: '',
    });
    expect(users.linkResult('reset', { emailed: true }, 'ana@co.sg', when).text).toBe('Reset link sent to ana@co.sg. It expires on 29 Oct, 14:05.');
    expect(users.linkResult('invite', { emailed: true }, 'ana@co.sg', '').text).toBe('Invite sent to ana@co.sg.');
  });

  test('email not set up: the link to send yourself, treated like a password, shown once', () => {
    const link = 'https://app.example.com/set-password#t=abc123';
    expect(users.linkResult('invite', { emailed: false, link, expiresAt: EXPIRES }, 'ana@co.sg', when)).toEqual({
      ok: true, emailed: false, link,
      text: 'Invite created. Email isn\'t set up on this server, so send this link to ana@co.sg yourself. Treat it like a password.',
      note: 'Shown once. Single use, expires 29 Oct, 14:05.',
    });
    expect(users.linkResult('reset', { emailed: false, link }, 'ana@co.sg', when).text)
      .toBe('Reset link created. Email isn\'t set up on this server, so send this link to ana@co.sg yourself. Treat it like a password.');
    expect(users.linkResult('reset', { emailed: false, link }, 'ana@co.sg', '').note).toBe('Shown once. Single use.');
  });

  test('the email failed: why, and the link instead', () => {
    const r = users.linkResult('invite', { emailed: false, link: 'https://x/set-password#t=1', emailError: 'Invalid login: 535' }, 'ana@co.sg', when);
    expect(r.text).toBe('Invite created. The email couldn\'t be sent (Invalid login: 535), so send this link to ana@co.sg yourself. Treat it like a password.');
    expect(r.link).toBe('https://x/set-password#t=1');
  });

  test('neither emailed nor a link: said plainly, with the way to try again', () => {
    expect(users.linkResult('invite', { emailed: false, link: null }, 'ana@co.sg', when)).toEqual({
      ok: false, emailed: false, link: null, note: '',
      text: 'Invite created, but it was not emailed and no link came back. New link makes another.',
    });
    expect(users.linkResult('reset', {}, 'ana@co.sg', when).text).toBe('Reset link created, but it was not emailed and no link came back. Send reset link makes another.');
    expect(users.linkResult('reset', null, '', '').text).toMatch(/^Reset link created, but/);
  });
});

describe('an invited row (inviteNote) and Revoke (revokeInviteAsk)', () => {
  const row = { id: 'u5', email: 'ana@co.sg', invited: true, inviteExpiresAt: EXPIRES, inviteExpired: false };

  test('invited, with when the link runs out, in place of the sign-in details', () => {
    expect(users.inviteNote(row, { now: NOW, day: '29 Oct' })).toEqual({
      expired: false, text: 'Invited · expires 29 Oct',
      title: 'Has not set a password yet. New link makes another; Revoke stops the one sent.',
    });
    expect(users.inviteNote({ ...row, inviteExpiresAt: null }, { now: NOW }).text).toBe('Invited');
  });

  test('expired, as the server says, or as the clock says for a list loaded a while ago', () => {
    expect(users.inviteNote({ ...row, inviteExpired: true, inviteExpiresAt: '2026-10-20T06:00:00.000Z' }, { now: NOW, day: '20 Oct' }))
      .toMatchObject({ expired: true, text: 'Invite expired 20 Oct' });
    expect(users.inviteNote(row, { now: Date.parse(EXPIRES) + 1, day: '29 Oct' })).toMatchObject({ expired: true, text: 'Invite expired 29 Oct' });
    expect(users.inviteNote({ ...row, inviteExpired: true }, { now: NOW }).text).toBe('Invite expired');
  });

  test('nothing on a row that has set its password', () => {
    expect(users.inviteNote({ ...row, invited: false }, { now: NOW })).toBeNull();
    expect(users.inviteNote({ ...row, invited: 'true' }, { now: NOW })).toBeNull();
    expect(users.inviteNote({}, { now: NOW })).toBeNull();
    expect(users.inviteNote(null)).toBeNull();
  });

  test('Revoke asks first, and says what it does', () => {
    expect(users.revokeInviteAsk(row)).toEqual({
      title: 'Revoke the invite for ana@co.sg?', message: 'The link they were sent stops working at once.', confirmLabel: 'Revoke', danger: true,
    });
  });
});

describe('the account panel for an invited account', () => {
  const ana = { id: 'u5', email: 'ana@co.sg', role: 'user', invited: true, inviteExpiresAt: EXPIRES, inviteExpired: false, createdAt: '2026-10-22T05:00:00.000Z' };
  const find = (groups, key) => groups.flatMap(g => g.actions).find(a => a.key === key);

  test('the head says Invited, and when the link runs out or that it has', () => {
    const s = detail.statusLine(ana, NOW, { timeZone: SG });
    expect(s.state).toEqual({ label: 'Invited', tone: 'yellow' });
    expect(s.summary).toBe('Invited · user · joined 22 Oct 2026');
    expect(s.notes).toContainEqual({ text: 'Invite link expires 29 Oct 14:05', tone: 'yellow' });
    expect(detail.statusLine({ ...ana, inviteExpired: true, inviteExpiresAt: '2026-10-20T06:00:00.000Z' }, NOW, { timeZone: SG }).notes)
      .toContainEqual({ text: 'Invite expired 20 Oct 14:00: send a new link to let them in', tone: 'red' });
    // Disabled and locked still come first.
    expect(detail.statusLine({ ...ana, disabledAt: '2026-10-22T05:30:00.000Z' }, NOW, { timeZone: SG }).state.label).toBe('Disabled');
  });

  test('offers a new invite link and Revoke, not a reset: there is no password to reset', () => {
    const groups = detail.panelActions({ user: ana, now: NOW });
    expect(groups[0].actions.map(a => a.key)).toEqual(['role', 'invite', 'revokeInvite']);
    expect(find(groups, 'invite')).toMatchObject({ busyKey: 'invite', label: '✉ New invite link' });
    expect(find(groups, 'revokeInvite')).toMatchObject({ busyKey: 'revokeInvite', label: '⊘ Revoke invite' });
    expect(find(groups, 'reset')).toBeUndefined();
    // An account that has set its password is sent a reset link.
    expect(find(detail.panelActions({ user: { ...ana, invited: false }, now: NOW }), 'reset').label).toBe('🔑 Send reset link');
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────────
describe('Admin › Users: the Invite a user card', () => {
  const admin = read('pages/Admin.jsx');
  const card  = admin.slice(admin.indexOf('{/* Invite form.'), admin.indexOf("{tab === 'users' && detailUser && ("));

  test('is called Invite a user, and has no password field', () => {
    expect(card).toContain('<div className="card-title">Invite a user</div>');
    expect(card).not.toMatch(/type=\{show\w* \? 'text' : 'password'\}|type="password"|admin-password|new-password|Temporary password/);
    expect(card).toContain('They get a link to set their own password. You never see it.');
    expect(admin).not.toContain('Add User');
  });

  test('keeps the role, the demo tick, the copy boxes and the sender filter', () => {
    expect(card).toContain('<label className="form-label">Role</label>');
    expect(card).toContain('<strong>Demo account</strong>');
    expect(card).toMatch(/\{copyBoxes\(\)\.map\(/);
    expect(card).toContain('<input id="admin-filter-from"');
  });

  test('after an invite, the result takes the form\'s place until Done: no banner that fades', () => {
    expect(card).toMatch(/\{invited \? \(\s+<LinkResult\s+kind="invite"\s+answer=\{invited\.invite\}\s+email=\{invited\.email\}\s+timeZone=\{me\?\.timezone\}\s+extra=\{invited\.copied\}\s+onDone=\{\(\) => setInvited\(null\)\}\s+\/>\s+\) : \(/);
    expect(admin).not.toMatch(/showSuccess|successTimer|setSuccess/);
    expect(admin).toMatch(/\{inviting \? <><span className="btn-spinner" \/> Inviting…<\/> : 'Invite user'\}/);
  });
});

describe('Admin › Users: an invited row, and the dialogs', () => {
  const admin = read('pages/Admin.jsx');
  const fn = name => admin.slice(admin.indexOf(`async function ${name}(`), admin.indexOf('\n  }\n', admin.indexOf(`async function ${name}(`)));

  test('the invite note replaces the sign-in details, with New link and Revoke', () => {
    expect(admin).toContain('const invite  = inviteNote(u, { now, day: formatShortDate(u.inviteExpiresAt, me?.timezone) });');
    const row = admin.slice(admin.indexOf('{invite ? ('), admin.indexOf('<span aria-hidden="true" style={{ color: \'var(--text-muted)\', fontSize: 14 }}>›</span>'));
    expect(row).toMatch(/\{invite \? \(\s+<>\s+<span className=\{`badge \$\{invite\.expired \? 'badge-red' : 'badge-yellow'\}`\} title=\{invite\.title\}>\{invite\.text\}<\/span>/);
    expect(row).toMatch(/<RowButton onClick=\{\(\) => handleNewInvite\(u\)\}[^>]*>\s+\{busy === `invite:\$\{u\.id\}` \? '…' : 'New link'\}/);
    expect(row).toMatch(/<RowButton onClick=\{\(\) => handleRevokeInvite\(u\)\}[^>]*>\s+\{busy === `revokeInvite:\$\{u\.id\}` \? '…' : 'Revoke'\}/);
    // The sign-in details only for an account that is not on its invite.
    const otherwise = row.slice(row.indexOf(') : ('));
    for (const bit of ['Joined {formatDateTime(u.createdAt', '● Online', '{lock.text}', '{failed}', '{mustSet}', 'Last sign-in']) {
      expect(otherwise).toContain(bit);
    }
  });

  test('a row button keeps its click and its keys from the row, which opens the panel', () => {
    const btn = admin.slice(admin.indexOf('function RowButton('), admin.indexOf('export default function Admin('));
    expect(btn).toContain('onClick={e => { e.stopPropagation(); onClick(); }}');
    expect(btn).toContain('onKeyDown={e => e.stopPropagation()}');
    expect(btn).toContain('type="button"');
  });

  test('New link and Send reset link post, then show what came back in a dialog', () => {
    expect(fn('handleNewInvite')).toContain('answer = await api.post(`/admin/users/${u.id}/invite`, {});');
    expect(fn('handleNewInvite')).toContain("if (sent) setShownLink({ kind: 'invite', email: u.email, answer: answer?.invite || {} });");
    expect(fn('handleResetLink')).toContain('answer = await api.post(`/admin/users/${u.id}/reset-link`, {});');
    expect(admin).toMatch(/\{shownLink && \(\s+<Modal onClose=\{\(\) => setShownLink\(null\)\}/);
    expect(admin).toMatch(/<LinkResult\s+kind=\{shownLink\.kind\}\s+answer=\{shownLink\.answer\}\s+email=\{shownLink\.email\}\s+timeZone=\{me\?\.timezone\}\s+onDone=\{\(\) => setShownLink\(null\)\}/);
  });

  test('Revoke asks first, then deletes the invite', () => {
    const revoke = fn('handleRevokeInvite');
    expect(revoke).toMatch(/if \(!\(await confirm\(revokeInviteAsk\(u\)\)\)\) return;/);
    expect(revoke).toContain("await control('revokeInvite', u, () => api.delete(`/admin/users/${u.id}/invite`), `The invite for ${u.email} was revoked.`);");
    expect(revoke.indexOf('await confirm(')).toBeLessThan(revoke.indexOf('api.delete('));
  });

  test('the temporary-password dialog is gone from the page; the panel\'s reset is the link', () => {
    expect(admin).not.toContain('ResetPasswordDialog');
    expect(admin).not.toMatch(/setResetting|resetting/);
    expect(admin).not.toMatch(/\/admin\/users\/\$\{[^}]+\}\/password/);
    const panel = read('pages/admin/UserDetailPanel.jsx');
    expect(panel).toMatch(/invite:\s+\(\) => actions\.invite\(user\),/);
    expect(panel).toMatch(/revokeInvite:\s+\(\) => actions\.revokeInvite\(user\),/);
  });
});

describe('the link result', () => {
  const src = read('pages/admin/LinkResult.jsx');

  test('dates the expiry in the admin\'s timezone with the app\'s formatter, and words it through the helper', () => {
    expect(src).toMatch(/import \{ formatShortDateTime \} from '\.\.\/\.\.\/utils\/formatDate';/);
    expect(src).toContain('const when = formatShortDateTime(answer?.expiresAt, timeZone);');
    expect(src).toContain('const r    = linkResult(kind, answer, email, when);');
  });

  test('a link to send is in a read-only box with Copy link, which falls back to selecting it', () => {
    expect(src).toMatch(/\{r\.link && \(/);
    expect(src).toMatch(/<input\s+ref=\{inputRef\}\s+className="form-input"\s+readOnly\s+value=\{r\.link\}/);
    expect(src).toContain('await navigator.clipboard.writeText(r.link);');
    expect(src).toMatch(/el\?\.select\(\);[\s\S]*?document\.execCommand\('copy'\)/);
    expect(src).toContain("setCopied(ok ? 'Copied' : 'Selected: press Ctrl+C to copy');");
    expect(src).toMatch(/>\s+Copy link\s+</);
    expect(src).toContain('{r.note}');
    expect(src).toMatch(/onClick=\{onDone\}[^>]*>\s+Done\s+</);
  });

  test('the link is never stored: no storage, no state of the page beyond the dialog', () => {
    expect(src).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe('Setup › Email sending', () => {
  const page = read('pages/Setup.jsx');

  test('its card, with the test button and where to get a Gmail App Password', () => {
    const meta = page.slice(page.indexOf('  email: {'), page.indexOf('};', page.indexOf('  email: {')));
    expect(meta).toContain("label: 'Email sending (admin)', icon: '📨',");
    expect(meta).toContain("desc: 'Sends invites and password-reset links. Not set up: you copy links and send them yourself.',");
    expect(meta).toContain("testKey: 'email', testLabel: 'Send test email',");
    expect(meta).toContain("helpUrl: 'https://myaccount.google.com/apppasswords', helpLabel: 'Gmail App Password ↗',");
  });

  test('last, after the other server-wide settings; its Test is /setup/test/email', () => {
    expect(page).toContain("{['defaults', 'allowances', 'preferences', 'optional', 'xeroOAuth', 'email'].map((key, i) => {");
    expect(page).toContain('const d = await api.post(`/setup/test/${type}`);');
  });

  test('the app\'s address is a plain field; the mail password a secret, masked like the rest', () => {
    const isSecretKey = new Function(`${page.match(/const PLAIN_KEYS = new Set\(\[[^\]]*\]\);/)[0]}\n${page.match(/function isSecretKey\(key\) \{[\s\S]*?\n\}/)[0]}\nreturn isSecretKey;`)();
    expect(isSecretKey('APP_BASE_URL')).toBe(false);
    expect(isSecretKey('SMTP_PASS')).toBe(true);
    expect(isSecretKey('SLACK_WEBHOOK_URL')).toBe(true);
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_FROM_NAME']) expect(isSecretKey(k)).toBe(false);
  });

  test('the server\'s hint under each field; no Test for someone who can only read the section', () => {
    expect((page.match(/\{meta\.hint && <div style=\{\{ fontSize: 11\.5, color: 'var\(--text-muted\)', marginTop: 4 \}\}>\{meta\.hint\}<\/div>\}/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(page).toContain('const readOnly = entries.length > 0 && entries.every(([, m]) => m.readOnly);');
    expect(page).toContain('{meta.testKey && !readOnly && (');
  });
});
