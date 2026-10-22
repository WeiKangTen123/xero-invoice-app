const fs   = require('fs');
const path = require('path');

// 2-step sign-in on the screen side: the sign-in card's second step, the
// Account page's card (set up, recovery codes, new codes, turn off), the
// set-up-2-step mode an admin without it is held in, "Confirm it's you"
// before a sensitive admin action, and Reset 2-step in Admin › Users. There
// is no React test setup in this project (see login-ui.test.js): the
// decisions are plain functions in files with no imports
// (pages/account/two-step.js, pages/login/login.js, pages/admin/users.js,
// pages/admin/user-detail.js), loaded whole and run here; the API client is
// run whole too (as in session-renewal-ui.test.js), so the redirect for
// mfa_setup_required and the retry after "Confirm it's you" are exercised for
// real; the rest of the wiring is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const ts     = load('pages/account/two-step.js');
const login  = load('pages/login/login.js');
const users  = load('pages/admin/users.js');
const detail = load('pages/admin/user-detail.js');

// ── Codes ─────────────────────────────────────────────────────────────────────
describe('what a code field keeps (sanitizeCode, isFullCode)', () => {
  test('digits only, six at most: a code pasted as "123 456" is 123456', () => {
    expect(ts.sanitizeCode('123 456')).toBe('123456');
    expect(ts.sanitizeCode(' 12-34 56\n')).toBe('123456');
    expect(ts.sanitizeCode('1234567')).toBe('123456');
    expect(ts.sanitizeCode('12a3')).toBe('123');
    expect(ts.sanitizeCode('abc')).toBe('');
    for (const v of ['', null, undefined]) expect(ts.sanitizeCode(v)).toBe('');
    expect(ts.sanitizeCode(123456)).toBe('123456');
    expect(ts.CODE_LENGTH).toBe(6);
  });

  test('a full code is six digits and nothing else', () => {
    expect(ts.isFullCode('123456')).toBe(true);
    for (const v of ['12345', '1234567', '123 456', '12345a', '', null, undefined, 123456]) expect(ts.isFullCode(v)).toBe(false);
  });
});

describe('a recovery code (sanitizeRecoveryCode, recoveryCodeForSend, isRecoveryCode)', () => {
  test('letters, digits and dashes kept; spaces and anything else dropped', () => {
    expect(ts.sanitizeRecoveryCode(' abcd-efgh-ijkl ')).toBe('abcd-efgh-ijkl');
    expect(ts.sanitizeRecoveryCode('abcd efgh\nijkl')).toBe('abcdefghijkl');
    expect(ts.sanitizeRecoveryCode('ab!c@d')).toBe('abcd');
    expect(ts.sanitizeRecoveryCode(undefined)).toBe('');
    expect(ts.sanitizeRecoveryCode('a'.repeat(100))).toHaveLength(40);
  });

  test('twelve characters are sent as xxxx-xxxx-xxxx, however they were grouped; anything else as typed', () => {
    expect(ts.recoveryCodeForSend('abcd-efgh-ijkl')).toBe('abcd-efgh-ijkl');
    expect(ts.recoveryCodeForSend('abcd efgh ijkl')).toBe('abcd-efgh-ijkl');
    expect(ts.recoveryCodeForSend('ABCDEFGHIJKL')).toBe('ABCD-EFGH-IJKL');
    expect(ts.recoveryCodeForSend('ab-cdefgh-ijkl')).toBe('abcd-efgh-ijkl');
    expect(ts.recoveryCodeForSend('abcd-efgh')).toBe('abcd-efgh');
  });

  test('the Verify button waits for something that could be one', () => {
    expect(ts.isRecoveryCode('abcd-efgh-ijkl')).toBe(true);
    expect(ts.isRecoveryCode('abcd-efgh')).toBe(true);
    for (const v of ['', 'abcd', 'ab-cd-ef', '123 456', null]) expect(ts.isRecoveryCode(v)).toBe(false);
  });
});

// ── Setting it up ─────────────────────────────────────────────────────────────
describe('the secret for typing by hand (groupSecret) and the steps', () => {
  test('in fours, upper case, whatever spacing it came with', () => {
    expect(ts.groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(ts.groupSecret('jbsw y3dp-ehpk 3pxp')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(ts.groupSecret('ABCDE')).toBe('ABCD E');
    for (const v of ['', null, undefined]) expect(ts.groupSecret(v)).toBe('');
  });

  test('three steps, naming the apps', () => {
    expect(ts.SETUP_STEPS).toEqual([
      'Open Google Authenticator, Microsoft Authenticator or 1Password.',
      'Scan the code.',
      'Enter the 6-digit code it shows.',
    ]);
  });
});

// ── Recovery codes ────────────────────────────────────────────────────────────
describe('the recovery codes, copied and downloaded', () => {
  const codes = ['aaaa-bbbb-cccc', 'dddd-eeee-ffff', 'gggg-hhhh-iiii', 'jjjj-kkkk-llll', 'mmmm-nnnn-oooo',
    'pppp-qqqq-rrrr', 'ssss-tttt-uuuu', 'vvvv-wwww-xxxx', 'yyyy-zzzz-0000', '1111-2222-3333'];

  test('the list as the server sent it, blanks and junk dropped', () => {
    expect(ts.recoveryList(codes)).toEqual(codes);
    expect(ts.recoveryList([' aaaa-bbbb-cccc ', '', null, 7, 'dddd-eeee-ffff'])).toEqual(['aaaa-bbbb-cccc', 'dddd-eeee-ffff']);
    for (const v of [null, undefined, 'aaaa', {}]) expect(ts.recoveryList(v)).toEqual([]);
  });

  test('Copy all: one a line', () => {
    expect(ts.copyAllText(codes.slice(0, 3))).toBe('aaaa-bbbb-cccc\ndddd-eeee-ffff\ngggg-hhhh-iiii');
    expect(ts.copyAllText(null)).toBe('');
  });

  test('Download .txt: what they are, the account, when, how to use them, and the ten numbered', () => {
    expect(ts.RECOVERY_FILE_NAME).toBe('financial-automation-recovery-codes.txt');
    const text = ts.recoveryCodesText(codes, { email: 'ana@co.sg', made: '22 Oct 2026, 14:05' });
    expect(text.split('\n')).toEqual([
      'Financial Automation: 2-step sign-in recovery codes',
      'Account: ana@co.sg',
      'Made: 22 Oct 2026, 14:05',
      '',
      'Each code signs you in once, in place of the 6-digit code from your authenticator app.',
      'Keep them somewhere safe, away from your phone. Making new codes stops these from working.',
      '',
      ' 1. aaaa-bbbb-cccc', ' 2. dddd-eeee-ffff', ' 3. gggg-hhhh-iiii', ' 4. jjjj-kkkk-llll', ' 5. mmmm-nnnn-oooo',
      ' 6. pppp-qqqq-rrrr', ' 7. ssss-tttt-uuuu', ' 8. vvvv-wwww-xxxx', ' 9. yyyy-zzzz-0000', '10. 1111-2222-3333',
      '',
    ]);
  });

  test('without the account or the date, those lines are left out', () => {
    const lines = ts.recoveryCodesText(['aaaa-bbbb-cccc']).split('\n');
    expect(lines[0]).toBe('Financial Automation: 2-step sign-in recovery codes');
    expect(lines[1]).toBe('');
    expect(lines).toContain(' 1. aaaa-bbbb-cccc');
    expect(lines.join('\n')).not.toMatch(/Account:|Made:/);
  });

  test('how many are left, with a nudge once few are, in the colour to match', () => {
    expect(ts.codesLeftText(10)).toBe('10 recovery codes left');
    expect(ts.codesLeftText(3)).toBe('3 recovery codes left');
    expect(ts.codesLeftText(2)).toBe('2 recovery codes left. Make new ones soon.');
    expect(ts.codesLeftText(1)).toBe('1 recovery code left. Make new ones soon.');
    expect(ts.codesLeftText(0)).toMatch(/^No recovery codes left\. Make new ones/);
    for (const v of [null, undefined, '', 'x', -1]) expect(ts.codesLeftText(v)).toBe('');
    expect([10, 3, 2, 1, 0, null].map(ts.codesLeftTone)).toEqual([null, null, 'yellow', 'yellow', 'red', null]);
  });
});

// ── The Account page's card ───────────────────────────────────────────────────
describe('the card\'s states and words', () => {
  test('on or off from GET /auth/mfa; six states, each its own name', () => {
    expect(ts.stateFromStatus({ enabled: true })).toBe(ts.TWO_STEP_ON);
    for (const s of [{ enabled: false }, {}, null, { enabled: 'yes' }]) expect(ts.stateFromStatus(s)).toBe(ts.TWO_STEP_OFF);
    const states = [ts.TWO_STEP_LOADING, ts.TWO_STEP_OFF, ts.TWO_STEP_SETUP, ts.TWO_STEP_CODES, ts.TWO_STEP_ON, ts.TWO_STEP_FAILED];
    expect(new Set(states).size).toBe(6);
  });

  test('set-up mode: the user\'s mfaSetupRequired, or the address, unless it is already on', () => {
    expect(ts.twoStepSetupMode('', { mfaSetupRequired: true })).toBe(true);
    expect(ts.twoStepSetupMode('?setup-2-step=1', { mfaSetupRequired: false })).toBe(true);
    expect(ts.twoStepSetupMode('?x=1&setup-2-step=1', null)).toBe(true);
    expect(ts.twoStepSetupMode('?setup-2-step=1', { mfaEnabled: true })).toBe(false);
    expect(ts.twoStepSetupMode('', { mfaSetupRequired: false })).toBe(false);
    expect(ts.twoStepSetupMode('?setup-2-step=0', {})).toBe(false);
    expect(ts.twoStepSetupMode(undefined, undefined)).toBe(false);
  });

  test('Turn off for anyone but an admin, who must keep it on', () => {
    expect(ts.canTurnOff({ required: false }, { role: 'user' })).toBe(true);
    expect(ts.canTurnOff(null, { role: 'user' })).toBe(true);
    expect(ts.canTurnOff({ required: true }, { role: 'user' })).toBe(false);
    expect(ts.canTurnOff({ required: false }, { role: 'admin' })).toBe(false);
    expect(ts.canTurnOff(null, { role: 'admin' })).toBe(false);
    expect(ts.REQUIRED_FOR_ADMINS).toBe('Required for admins.');
  });

  test('"On since", from the date as the page formats it', () => {
    expect(ts.onSinceText('22 Oct 2026')).toBe('On since 22 Oct 2026');
    expect(ts.onSinceText('—')).toBe('On');
    expect(ts.onSinceText('')).toBe('On');
  });

  test('set-up mode is headed for it', () => {
    expect(ts.SETUP_REQUIRED_TITLE).toBe('Set up 2-step sign-in to continue');
    expect(ts.SETUP_REQUIRED_INTRO).toMatch(/authenticator app/);
  });
});

// ── Confirm it's you ──────────────────────────────────────────────────────────
describe('"Confirm it\'s you": its words and what it sends', () => {
  test('a code from the app with 2-step on, the password offered instead; the password otherwise', () => {
    expect(ts.reauthText(true)).toMatchObject({ label: 'Code from your app', toggle: 'Use your password instead' });
    expect(ts.reauthText(true).intro).toMatch(/6-digit code from your authenticator app/);
    expect(ts.reauthText(false)).toMatchObject({ label: 'Password', toggle: 'Use a code from your app instead' });
  });

  test('POST /auth/reauth gets { code } or { password }, and Confirm waits for one', () => {
    expect(ts.reauthBody(true, '123 456')).toEqual({ code: '123456' });
    expect(ts.reauthBody(false, ' my pass ')).toEqual({ password: ' my pass ' });
    expect(ts.reauthReady(true, '123456')).toBe(true);
    expect(ts.reauthReady(true, '12345')).toBe(false);
    expect(ts.reauthReady(false, 'x')).toBe(true);
    expect(ts.reauthReady(false, '')).toBe(false);
  });
});

// ── The sign-in card's second step ───────────────────────────────────────────
describe('the second step at sign-in (login.js)', () => {
  test('a sign-in answer that asks for the code, and only that', () => {
    expect(login.mfaChallenge({ mfaRequired: true, mfaToken: 'tok', methods: ['totp', 'recovery'] }))
      .toEqual({ mfaToken: 'tok', methods: ['totp', 'recovery'] });
    expect(login.mfaChallenge({ mfaRequired: true, mfaToken: 'tok', methods: ['totp'] })).toEqual({ mfaToken: 'tok', methods: ['totp'] });
    // No list: both ways.
    expect(login.mfaChallenge({ mfaRequired: true, mfaToken: 'tok' }).methods).toEqual(['totp', 'recovery']);
    for (const a of [{ token: 't', user: {} }, { mfaRequired: true }, { mfaRequired: true, mfaToken: '' }, { mfaRequired: 'true', mfaToken: 't' }, null, undefined]) {
      expect(login.mfaChallenge(a)).toBeNull();
    }
  });

  test('"Use a recovery code instead" only when the server takes one', () => {
    expect(login.canUseRecovery({ mfaToken: 't', methods: ['totp', 'recovery'] })).toBe(true);
    expect(login.canUseRecovery({ mfaToken: 't', methods: ['totp'] })).toBe(false);
    expect(login.canUseRecovery(null)).toBe(false);
  });

  test('the prompts', () => {
    expect(login.MFA_CODE_PROMPT).toBe('Enter the 6-digit code from your authenticator app');
    expect(login.MFA_RECOVERY_PROMPT).toMatch(/recovery code/);
  });

  test('a wrong code is tried again; restart: true or a lock goes back to the password, with the message', () => {
    const err = (status, body) => Object.assign(new Error(body.error || ''), { status, body });
    expect(login.verifyFailure(err(401, { error: 'That code is not right.' }))).toEqual({ restart: false, message: 'That code is not right.' });
    expect(login.verifyFailure(err(401, { error: 'Sign in again.', restart: true }))).toEqual({ restart: true, message: 'Sign in again.' });
    expect(login.verifyFailure(err(423, { error: 'Locked.' }))).toEqual({ restart: true, message: 'Locked.' });
    expect(login.verifyFailure(err(401, { restart: true }))).toEqual({ restart: true, message: 'Sign in again.' });
    expect(login.verifyFailure(err(400, {})).restart).toBe(false);
    expect(login.verifyFailure(null)).toEqual({ restart: false, message: 'That code did not work. Try again.' });
  });

  test('after a recovery code: how many are left, as a toast, louder once few are', () => {
    expect(login.recoveryLeftToast(7)).toEqual({ kind: 'info', text: '7 recovery codes left.' });
    expect(login.recoveryLeftToast(2)).toEqual({ kind: 'error', text: '2 recovery codes left. Make new ones on the Account page.' });
    expect(login.recoveryLeftToast(1).text).toBe('1 recovery code left. Make new ones on the Account page.');
    expect(login.recoveryLeftToast(0)).toEqual({ kind: 'error', text: 'No recovery codes left. Make new ones on the Account page.' });
    expect(login.recoveryLeftToast(undefined).kind).toBe('info');
  });
});

// ── Admin › Users ─────────────────────────────────────────────────────────────
describe('Admin › Users: the badge, the status line and Reset 2-step', () => {
  const NOW  = Date.parse('2026-10-22T06:00:00.000Z');
  const jane = { id: 'u2', email: 'jane@nexsoss.com', role: 'user', disabledAt: null, lockedUntil: null };
  const find = (groups, key) => groups.flatMap(g => g.actions).find(a => a.key === key);

  test('a small "2-step" badge on a row with it on, nothing otherwise', () => {
    expect(users.mfaBadge({ mfaEnabled: true })).toMatchObject({ text: '2-step' });
    for (const r of [{ mfaEnabled: false }, {}, null]) expect(users.mfaBadge(r)).toBeNull();
  });

  test('Reset 2-step asks first, saying what it does and when to use it', () => {
    expect(users.mfaResetAsk({ email: 'jane@nexsoss.com' })).toEqual({
      title: 'Reset 2-step sign-in for jane@nexsoss.com?',
      message: 'They will have to set it up again at their next sign-in. Use this when they have lost their phone.',
      confirmLabel: 'Reset 2-step',
      danger: true,
    });
    expect(users.mfaResetDone({ email: 'jane@nexsoss.com' })).toMatch(/^2-step sign-in for jane@nexsoss\.com is reset\./);
  });

  test('the panel\'s status says 2-step on or off; an admin without it, as a warning', () => {
    const notes = u => detail.statusLine({ ...jane, ...u }, NOW).notes;
    expect(notes({ mfaEnabled: true })).toContainEqual({ text: '2-step on', tone: 'green' });
    expect(notes({ mfaEnabled: false })).toContainEqual({ text: '2-step off', tone: null });
    expect(notes({ mfaEnabled: false, role: 'admin' })).toContainEqual({ text: '2-step off: they set it up at their next sign-in', tone: 'yellow' });
    // An older server that does not say, or an invite with no sign-in yet: nothing.
    expect(notes({}).map(n => n.text).join(' ')).not.toMatch(/2-step/);
    expect(notes({ mfaEnabled: false, invited: true }).map(n => n.text).join(' ')).not.toMatch(/2-step/);
  });

  test('Reset 2-step is offered on another account with it on, never on yours', () => {
    const on = d => detail.panelActions({ user: { ...jane, mfaEnabled: true }, now: NOW, ...d });
    expect(find(on({}), 'mfaReset')).toMatchObject({ key: 'mfaReset', busyKey: 'mfaReset', label: '⟲ Reset 2-step' });
    expect(on({}).find(g => g.key === 'account').actions.map(a => a.key)).toEqual(['role', 'reset', 'mfaReset']);
    expect(find(on({ isMe: true }), 'mfaReset')).toBeUndefined();
    expect(find(detail.panelActions({ user: { ...jane, mfaEnabled: false }, now: NOW }), 'mfaReset')).toBeUndefined();
    expect(find(detail.panelActions({ user: jane, now: NOW }), 'mfaReset')).toBeUndefined();
  });
});

// ── The API client, run whole ─────────────────────────────────────────────────
describe('the API client', () => {
  const src = read('api/client.js');
  const reply = (status, body) => new Response(JSON.stringify(body), { status });

  function loadClient({ pathname = '/admin', fetch }) {
    if (/^import /m.test(src)) throw new Error('client.js now imports something; this harness runs it standalone');
    const store = new Map([['token', 'a.b.c']]);
    const localStorage = {
      getItem:    k => (store.has(k) ? store.get(k) : null),
      setItem:    (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
    };
    const window = { location: { pathname, search: '', hash: '', href: pathname } };
    const body = `${src.replace(/^export /gm, '')}\nreturn { api, requiredPath, setReauthHandler, needsReauth, SET_PASSWORD_PATH, MFA_SETUP_PATH };`;
    return { ...new Function('fetch', 'localStorage', 'window', 'atob', body)(fetch, localStorage, window, atob), window, store };
  }

  // A fetch that answers from a list, in turn, and records what it was asked.
  function scripted(...answers) {
    const calls = [];
    const fetch = async (url, opts) => { calls.push({ url, method: opts.method || 'GET', body: opts.body }); return answers.shift()(); };
    return { fetch, calls };
  }
  const refusedReauth = () => reply(403, { error: "Confirm it's you to continue.", code: 'reauth_required' });

  describe('where an account must go first (requiredPath)', () => {
    const c = loadClient({ fetch: async () => reply(200, {}) });

    test('a password to set, then 2-step to set up, then nowhere', () => {
      expect(c.MFA_SETUP_PATH).toBe('/account?setup-2-step=1');
      expect(c.requiredPath({ mustChangePassword: true, mfaSetupRequired: true })).toBe(c.SET_PASSWORD_PATH);
      expect(c.requiredPath({ mfaSetupRequired: true })).toBe('/account?setup-2-step=1');
      for (const u of [{}, { mfaSetupRequired: false, mustChangePassword: false }, null, undefined]) expect(c.requiredPath(u)).toBe('');
    });
  });

  describe('a 403 mfa_setup_required', () => {
    const refused = () => reply(403, { error: 'Set up 2-step sign-in to continue.', code: 'mfa_setup_required' });

    test('leads to the Account page in set-up-2-step mode, token kept, and the error says why', async () => {
      const c = loadClient({ pathname: '/invoices', fetch: async () => refused() });
      await expect(c.api.get('/invoices')).rejects.toMatchObject({ status: 403, code: 'mfa_setup_required' });
      expect(c.store.get('token')).toBe('a.b.c');
      expect(c.window.location.href).toBe('/account?setup-2-step=1');
    });

    test('on the Account page itself, or a page with no session, nothing moves', async () => {
      for (const pathname of ['/account', '/login', '/set-password']) {
        const c = loadClient({ pathname, fetch: async () => refused() });
        await expect(c.api.get('/auth/sign-ins')).rejects.toMatchObject({ status: 403 });
        expect(c.window.location.href).toBe(pathname);
      }
    });

    test('a password to set still leads to its own form', async () => {
      const c = loadClient({ pathname: '/invoices', fetch: async () => reply(403, { error: 'x', code: 'password_change_required' }) });
      await expect(c.api.get('/invoices')).rejects.toMatchObject({ status: 403 });
      expect(c.window.location.href).toBe('/account?set-password=1');
    });
  });

  describe('a 403 reauth_required: "Confirm it\'s you", then the request once more', () => {
    test('confirmed: the same request is sent again and its answer returned', async () => {
      const { fetch, calls } = scripted(refusedReauth, () => reply(200, { success: true }));
      const c = loadClient({ fetch });
      const asked = [];
      c.setReauthHandler(err => { asked.push(err); return Promise.resolve(true); });
      await expect(c.api.post('/admin/users/u2/mfa-reset', {})).resolves.toEqual({ success: true });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ status: 403, code: 'reauth_required', message: "Confirm it's you to continue." });
      expect(calls).toEqual([
        { url: '/api/admin/users/u2/mfa-reset', method: 'POST', body: '{}' },
        { url: '/api/admin/users/u2/mfa-reset', method: 'POST', body: '{}' },
      ]);
    });

    test('cancelled: the caller gets the original error, and nothing is sent again', async () => {
      const { fetch, calls } = scripted(refusedReauth);
      const c = loadClient({ fetch });
      c.setReauthHandler(() => Promise.resolve(false));
      await expect(c.api.delete('/admin/users/u2')).rejects.toMatchObject({ status: 403, code: 'reauth_required' });
      expect(calls).toHaveLength(1);
    });

    test('an asker that throws counts as a cancel', async () => {
      const { fetch, calls } = scripted(refusedReauth);
      const c = loadClient({ fetch });
      c.setReauthHandler(() => { throw new Error('boom'); });
      await expect(c.api.patch('/admin/users/u2/role', { role: 'admin' })).rejects.toMatchObject({ code: 'reauth_required' });
      expect(calls).toHaveLength(1);
    });

    test('once only: refused again after confirming, the caller gets that', async () => {
      const { fetch, calls } = scripted(refusedReauth, refusedReauth);
      const c = loadClient({ fetch });
      let asked = 0;
      c.setReauthHandler(async () => { asked++; return true; });
      await expect(c.api.post('/admin/users', { email: 'a@b.co', role: 'admin' })).rejects.toMatchObject({ code: 'reauth_required' });
      expect(asked).toBe(1);
      expect(calls).toHaveLength(2);
    });

    test('requests refused together share one question, and each is sent again', async () => {
      const { fetch, calls } = scripted(refusedReauth, refusedReauth, () => reply(200, { a: 1 }), () => reply(200, { b: 2 }));
      const c = loadClient({ fetch });
      let asked = 0;
      let answer;
      c.setReauthHandler(() => { asked++; return new Promise(r => { answer = r; }); });
      const both = Promise.all([c.api.post('/admin/users/u2/reset-link', {}), c.api.delete('/admin/users/u3')]);
      await new Promise(r => setTimeout(r, 0));
      answer(true);
      expect(await both).toEqual([{ a: 1 }, { b: 2 }]);
      expect(asked).toBe(1);
      expect(calls).toHaveLength(4);
    });

    test('without an asker, and for the reauth request itself, the error goes to the caller as it came', async () => {
      const a = scripted(refusedReauth);
      await expect(loadClient({ fetch: a.fetch }).api.post('/admin/users/u2/mfa-reset', {})).rejects.toMatchObject({ code: 'reauth_required' });
      expect(a.calls).toHaveLength(1);
      const b = scripted(refusedReauth);
      const c = loadClient({ fetch: b.fetch });
      let asked = 0;
      c.setReauthHandler(async () => { asked++; return true; });
      await expect(c.api.post('/auth/reauth', { password: 'x' })).rejects.toMatchObject({ code: 'reauth_required' });
      expect(asked).toBe(0);
      expect(c.needsReauth({ status: 403, code: 'reauth_required' }, '/admin/users')).toBe(true);
      expect(c.needsReauth({ status: 403, code: 'password_change_required' }, '/admin/users')).toBe(false);
      expect(c.needsReauth({ status: 401, code: 'reauth_required' }, '/admin/users')).toBe(false);
    });

    test('unregistering removes only the asker it registered', async () => {
      const c = loadClient({ fetch: async () => refusedReauth() });
      const first = c.setReauthHandler(async () => true);
      const second = c.setReauthHandler(async () => false);
      first();   // stale: the second stays
      await expect(c.api.get('/admin/users')).rejects.toMatchObject({ code: 'reauth_required' });
      second();
      expect(c.needsReauth({ status: 403, code: 'reauth_required' }, '/x')).toBe(true);
    });
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────────
describe('the code field', () => {
  const input = read('pages/account/CodeInput.jsx');

  test('one box a phone fills: text, the number pad, one-time-code, six long', () => {
    expect(input).toMatch(/type="text"/);
    expect(input).toMatch(/inputMode="numeric"/);
    expect(input).toMatch(/autoComplete="one-time-code"/);
    expect(input).toMatch(/maxLength=\{CODE_LENGTH\}/);
    expect(input).toMatch(/import \{ sanitizeCode, CODE_LENGTH \} from '\.\/two-step';/);
  });

  test('digits only as typed, and a paste read whole before maxLength can cut it', () => {
    expect(input).toMatch(/onChange=\{e => onChange\(sanitizeCode\(e\.target\.value\)\)\}/);
    expect(input).toMatch(/onPaste=\{e => \{\s+const text = e\.clipboardData\?\.getData\('text'\);[\s\S]*?e\.preventDefault\(\);\s+const digits = sanitizeCode\(text\);/);
  });
});

describe('the sign-in page', () => {
  const page = read('pages/Login.jsx');
  const step = read('pages/login/MfaStep.jsx');
  const auth = read('context/AuthContext.jsx');

  test('a right password for an account with 2-step on opens the second step in the same card, the password dropped', () => {
    expect(page).toMatch(/const step = mode === 'login' \? mfaChallenge\(user\) : null;\s+if \(step\) \{ setPassword\(''\); setChallenge\(step\); return; \}/);
    expect(page).toMatch(/\{challenge \? '2-step sign-in' : firstRun \?/);
    expect(page).toMatch(/\{challenge \? \(\s+<MfaStep\s+challenge=\{challenge\}\s+onVerified=\{signedIn\}\s+onRestart=\{restartSignIn\}/);
  });

  test('signed in, the account goes where it must first, else where it came from', () => {
    expect(page).toMatch(/function signedIn\(user\) \{\s+navigate\(requiredPath\(user\) \|\| returnPathFrom\(location\), \{ replace: true \}\);/);
  });

  test('sent back to the password: the step closed, the message said (a lock counted down)', () => {
    const fn = page.slice(page.indexOf('function restartSignIn('), page.indexOf('const isDark'));
    expect(fn).toMatch(/setChallenge\(null\);\s+setPassword\(''\);/);
    expect(fn).toMatch(/const l = err\?\.body \? lockMessage\(err\.body, Date\.now\(\)\) : null;\s+if \(l\) \{ setLock\(l\); setNow\(Date\.now\(\)\); shake\(\); return; \}/);
    expect(fn).toMatch(/if \(message\) triggerError\(message\);/);
    expect(page).toMatch(/onBack=\{\(\) => restartSignIn\(null, ''\)\}/);
  });

  test('the step: the code box, Verify, a recovery code instead, and errors announced', () => {
    expect(step).toMatch(/<CodeInput id="mfa-code" value=\{code\} onChange=\{setCode\} autoFocus \/>/);
    expect(step).toMatch(/\{useRecovery \? MFA_RECOVERY_PROMPT : MFA_CODE_PROMPT\}/);
    expect(step).toMatch(/'Use a recovery code instead'/);
    expect(step).toMatch(/\{recoveryOffered && \(/);
    expect(step).toMatch(/placeholder="xxxx-xxxx-xxxx"/);
    expect(step).toMatch(/onChange=\{e => setRecovery\(sanitizeRecoveryCode\(e\.target\.value\)\)\}/);
    expect(step).toMatch(/<div className="alert alert-error" role="alert">\s+<span className="alert-icon">✕<\/span>\s+\{error\}/);
    expect(step).toMatch(/\{busy \? <><span className="btn-spinner" \/> Checking…<\/> : 'Verify'\}/);
  });

  test('the step sends the code or the recovery code with the mfaToken, and says how many recovery codes are left', () => {
    expect(step).toMatch(/const proof = useRecovery \? \{ recoveryCode: recoveryCodeForSend\(recovery\) \} : \{ code \};/);
    expect(step).toMatch(/const user\s+= await verifyMfa\(challenge\.mfaToken, proof\);/);
    expect(step).toMatch(/if \(useRecovery\) \{\s+const t = recoveryLeftToast\(user\?\.recoveryCodesLeft\);\s+toast\[t\.kind\]\(t\.text\);\s+\}\s+onVerified\(user\);/);
    expect(step).toMatch(/const f = verifyFailure\(err\);\s+if \(f\.restart\) \{ onRestart\(err, f\.message\); return; \}/);
  });

  test('AuthContext: the first step stores nothing; the second stores the token as a sign-in does', () => {
    const loginFn = auth.slice(auth.indexOf('async function login('), auth.indexOf('async function verifyMfa('));
    expect(loginFn).toMatch(/const data = await api\.post\('\/auth\/login', \{ email, password \}\);\s+if \(data && data\.mfaRequired === true\) return data;\s+localStorage\.setItem\('token', data\.token\);/);
    expect(auth).toMatch(/async function verifyMfa\(mfaToken, proof\) \{\s+const data = await api\.post\('\/auth\/mfa\/verify', \{ mfaToken, \.\.\.proof \}\);\s+localStorage\.setItem\('token', data\.token\);\s+setUser\(data\.user\);/);
    expect(auth).toMatch(/login, verifyMfa, logout,/);
  });
});

describe('set-up-2-step mode', () => {
  const app     = read('App.jsx');
  const client  = read('api/client.js');
  const account = read('pages/Account.jsx');

  test('the route guard sends every page but Account there, after a password to set', () => {
    expect(app).toMatch(/import \{ SET_PASSWORD_PATH, MFA_SETUP_PATH, requiredPath \} from '\.\/api\/client';/);
    const pw  = app.indexOf("if (user.mustChangePassword && !location.pathname.startsWith('/account'))");
    const mfa = app.indexOf("if (user.mfaSetupRequired && !location.pathname.startsWith('/account')) return <Navigate to={MFA_SETUP_PATH} replace />;");
    expect(pw).toBeGreaterThan(0);
    expect(mfa).toBeGreaterThan(pw);
    expect(app).toMatch(/<Route path="\/login" element=\{user \? <Navigate to=\{requiredPath\(user\) \|\| returnPathFrom\(location\)\} replace \/> : <Login \/>\} \/>/);
  });

  test('the API client turns a 403 mfa_setup_required into that page, after password_change_required', () => {
    expect(client).toMatch(/\} else if \(res\.status === 403 && data\.code === 'password_change_required'\) \{\s+requirePasswordChange\(\);\s+\} else if \(res\.status === 403 && data\.code === 'mfa_setup_required'\) \{\s+requireMfaSetup\(\);/);
    const fn = client.slice(client.indexOf('function requireMfaSetup('), client.indexOf('export function isAuthPath('));
    expect(fn).toMatch(/if \(path\.startsWith\('\/account'\) \|\| isPublicPath\(path\)\) return;\s+window\.location\.href = MFA_SETUP_PATH;/);
    expect(fn).not.toMatch(/removeItem|clearSession/);
  });

  test('the Account page: only the 2-step card, headed for it; a password to set comes first', () => {
    expect(account).toMatch(/const settingUp2Step\s+= !settingPassword && twoStepSetupMode\(location\.search, user\);/);
    expect(account).toMatch(/<strong>\{SETUP_REQUIRED_TITLE\}\.<\/strong> \{SETUP_REQUIRED_INTRO\}/);
    expect(account).toMatch(/\{!settingUp2Step && <ChangePasswordCard /);
    expect(account).toMatch(/\{!settingPassword && <TwoStepCard idx=\{settingUp2Step \? 0 : 1\} setupRequired=\{settingUp2Step\} onSetUp=\{settingUp2Step \? onTwoStepOn : undefined\} \/>\}/);
    expect(account).toMatch(/\{!settingPassword && !settingUp2Step && <SessionsCard /);
    expect(account).toMatch(/\{!settingUp2Step && <SignInsCard /);
    expect(account).toMatch(/async function onTwoStepOn\(\) \{\s+await refreshUser\(\);\s+navigate\('\/dashboard', \{ replace: true \}\);/);
  });
});

describe('the Account page\'s card', () => {
  const card  = read('pages/account/TwoStepCard.jsx');
  const codes = read('pages/account/RecoveryCodes.jsx');

  test('asks the 2-step routes, except GET /auth/mfa in set-up mode, which starts at Off', () => {
    expect(card).toMatch(/api\.get\('\/auth\/mfa'\)/);
    expect(card).toMatch(/api\.post\('\/auth\/mfa\/setup', \{\}\)/);
    expect(card).toMatch(/api\.post\('\/auth\/mfa\/enable', \{ code \}\)/);
    expect(card).toMatch(/api\.post\('\/auth\/mfa\/recovery-codes', \{ password \}\)/);
    expect(card).toMatch(/api\.post\('\/auth\/mfa\/disable', \{ password, code: offCode \}\)/);
    expect(card).toMatch(/useState\(setupRequired \? TWO_STEP_OFF : TWO_STEP_LOADING\)/);
    expect(card).toMatch(/useEffect\(\(\) => \{ if \(!setupRequired\) load\(\); \}, \[load, setupRequired\]\);/);
  });

  test('set up: the QR code, the key in fours with Copy, the steps, and a code box', () => {
    expect(card).toMatch(/<img src=\{setup\.qrSvg\} alt="QR code for your authenticator app"/);
    expect(card).toMatch(/\{groupSecret\(setup\.secret\)\}/);
    expect(card).toMatch(/onClick=\{copySecret\}>Copy<\/button>/);
    expect(card).toMatch(/\{SETUP_STEPS\.map\(step => <li key=\{step\}>\{step\}<\/li>\)\}/);
    expect(card).toMatch(/<CodeInput id="mfa-setup-code" value=\{code\} onChange=\{setCode\}/);
    expect(card).toMatch(/disabled=\{busy \|\| !isFullCode\(code\)\}/);
    expect(card).toMatch(/'Set up 2-step sign-in'/);
  });

  test('on: since when, how many codes are left, New recovery codes, and Turn off only where allowed', () => {
    expect(card).toMatch(/\{onSinceText\(formatDate\(status\?\.enabledAt, user\?\.timezone\)\)\}/);
    expect(card).toMatch(/const left\s+= codesLeftText\(status\?\.recoveryCodesLeft\);/);
    expect(card).toMatch(/\{canTurnOff\(status, user\) \? \([\s\S]*?Turn off[\s\S]*?\) : \(\s+<span[^>]*>\{REQUIRED_FOR_ADMINS\}<\/span>/);
    expect(card).toMatch(/New recovery codes/);
    // New codes ask the password; Turn off the password and a code.
    expect(card).toMatch(/dialog === 'codes' && \(\s+<AskDialog[\s\S]*?withCode=\{false\}/);
    expect(card).toMatch(/dialog === 'off' && \(\s+<AskDialog[\s\S]*?withCode\s/);
  });

  test('set up in set-up mode hands over once the codes are saved; otherwise the user is read again', () => {
    expect(card).toMatch(/async function codesDone\(\) \{\s+setCodes\(null\);\s+if \(onSetUp\) \{ await onSetUp\(\); return; \}\s+await refreshUser\(\);/);
  });

  test('the recovery codes: a monospace grid, Copy all, Download .txt as a Blob, and Done held until saved', () => {
    expect(codes).toMatch(/aria-label="Recovery codes"/);
    expect(codes).toMatch(/fontFamily: 'monospace'/);
    expect(codes).toMatch(/gridTemplateColumns:/);
    expect(codes).toMatch(/>Copy all<\/button>/);
    expect(codes).toMatch(/>Download \.txt<\/button>/);
    expect(codes).toMatch(/new Blob\(\[recoveryCodesText\(list, \{ email, made \}\)\], \{ type: 'text\/plain;charset=utf-8' \}\)/);
    expect(codes).toMatch(/a\.download = RECOVERY_FILE_NAME;/);
    expect(codes).toMatch(/URL\.revokeObjectURL\(url\)/);
    expect(codes).toMatch(/I have saved these codes/);
    expect(codes).toMatch(/onClick=\{onDone\} disabled=\{!saved\}/);
  });
});

describe('"Confirm it\'s you", for every request', () => {
  const app      = read('App.jsx');
  const provider = read('context/ReauthContext.jsx');
  const dialog   = read('components/ReauthDialog.jsx');

  test('one provider registers the asker with the API client, around every page', () => {
    expect(app).toMatch(/<ReauthProvider>\s+<RouterProvider router=\{router\} \/>\s+<\/ReauthProvider>/);
    expect(provider).toMatch(/useEffect\(\(\) => setReauthHandler\(\(\) => new Promise\(resolve => setPending\(\{ resolve \}\)\)\), \[\]\);/);
    expect(provider).toMatch(/hasCode=\{user\?\.mfaEnabled === true\}/);
    expect(provider).toMatch(/onConfirmed=\{\(\) => answer\(true\)\}\s+onCancel=\{\(\) => answer\(false\)\}/);
  });

  test('the dialog: a code with 2-step on (or the password instead), POST /auth/reauth, a refusal said in it', () => {
    expect(dialog).toMatch(/const \[useCode, setUseCode\] = useState\(hasCode\);/);
    expect(dialog).toMatch(/await api\.post\('\/auth\/reauth', reauthBody\(useCode, value\)\);\s+onConfirmed\(\);/);
    expect(dialog).toMatch(/<CodeInput id="reauth-input"/);
    expect(dialog).toMatch(/autoComplete="current-password"/);
    expect(dialog).toMatch(/\{hasCode && \(/);
    expect(dialog).toMatch(/\{text\.toggle\}/);
    expect(dialog).toMatch(/role="alert"/);
    expect(dialog).toMatch(/Confirm it&apos;s you/);
    expect(dialog).toMatch(/<Modal onClose=\{onCancel\} busy=\{busy\}/);
  });

  test('the Admin page handles none of it itself (its comments aside)', () => {
    const code = read('pages/Admin.jsx').replace(/^\s*\/\/[^\n]*$/gm, '');
    expect(code).not.toMatch(/reauth_required|setReauthHandler|\/auth\/reauth/);
  });
});

describe('Admin › Users is wired to Reset 2-step and the badge', () => {
  const admin = read('pages/Admin.jsx');
  const panel = read('pages/admin/UserDetailPanel.jsx');

  test('asked first, then the route, through control()', () => {
    const fn = admin.slice(admin.indexOf('async function handleMfaReset('), admin.indexOf('\n  }\n', admin.indexOf('async function handleMfaReset(')));
    expect(fn).toMatch(/if \(!\(await confirm\(mfaResetAsk\(u\)\)\)\) return;/);
    expect(fn).toContain("await control('mfaReset', u, () => api.post(`/admin/users/${u.id}/mfa-reset`, {}), mfaResetDone(u));");
    const actions = admin.slice(admin.indexOf('const userActions = {'), admin.indexOf('};', admin.indexOf('const userActions = {')));
    expect(actions).toContain('mfaReset: handleMfaReset');
    expect(panel).toMatch(/mfaReset:\s+\(\) => actions\.mfaReset\(user\),/);
  });

  test('a "2-step" badge on each row with it on', () => {
    expect(admin).toMatch(/const twoStep = mfaBadge\(u\);/);
    expect(admin).toMatch(/\{twoStep && \(\s+<span className="badge badge-green" title=\{twoStep\.title\}>\{twoStep\.text\}<\/span>/);
  });
});
