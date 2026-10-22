const fs   = require('fs');
const path = require('path');

// Demo accounts on the screen side. A demo account shows sample data this app
// generates in place of a Xero connection (GET /api/auth/me carries `demo`).
// There is no React test setup in this project (see login-ui.test.js), so
// the decisions — what the Invite a user form sends and when it cannot be sent,
// the badge on a demo row, which Xero card Setup shows and what it says, the
// live updates line for data that does not change — are plain functions in
// files with no imports, loaded whole and run here; the wiring (the form
// sends demo/copyFrom/mailboxFilterFrom, Setup's demo card has no actions,
// the Dashboard pill) is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const users   = load('pages/admin/users.js');
const connect = load('pages/setup/connect.js');
const live    = load('pages/xero-insights/live.js');

// The form as Admin.jsx holds it: the address and the role, the Demo account
// tick, the copy boxes and the sender address. No password: the person sets
// their own from the invite link.
const form = extra => ({
  email: 'demo@nexsoss.com', role: 'user',
  demo: true, copyFrom: { llm: true, defaults: true, mailbox: true }, mailboxFilterFrom: 'bills@vendor.com',
  ...extra,
});

describe('Admin › Invite a user: what the form sends (addUserPayload)', () => {
  test('a demo account carries the copy ticks and the sender address, trimmed', () => {
    expect(users.addUserPayload(form({ mailboxFilterFrom: '  bills@vendor.com ' }))).toEqual({
      email: 'demo@nexsoss.com', role: 'user',
      demo: true, copyFrom: { llm: true, defaults: true, mailbox: true }, mailboxFilterFrom: 'bills@vendor.com',
    });
    expect(users.addUserPayload(form({ copyFrom: { llm: false, defaults: true, mailbox: true } })).copyFrom)
      .toEqual({ llm: false, defaults: true, mailbox: true });
  });

  test('the sender address only travels with the mailbox', () => {
    const p = users.addUserPayload(form({ copyFrom: { llm: true, defaults: true, mailbox: false } }));
    expect(p.copyFrom).toEqual({ llm: true, defaults: true, mailbox: false });
    expect(p).not.toHaveProperty('mailboxFilterFrom');
  });

  test('an ordinary account copies nothing, whatever the boxes held before Demo was unticked', () => {
    const p = users.addUserPayload(form({ demo: false }));
    expect(p).toEqual({
      email: 'demo@nexsoss.com', role: 'user',
      demo: false, copyFrom: { llm: false, defaults: false, mailbox: false },
    });
    expect(p).not.toHaveProperty('mailboxFilterFrom');
  });

  test('the ticks are read strictly; a form with no boxes, or none at all, copies nothing', () => {
    expect(users.addUserPayload(form({ copyFrom: { llm: 'yes', defaults: 1, mailbox: undefined } })).copyFrom)
      .toEqual({ llm: false, defaults: false, mailbox: false });
    expect(users.addUserPayload(form({ copyFrom: undefined })).copyFrom).toEqual({ llm: false, defaults: false, mailbox: false });
    expect(users.addUserPayload(form({ demo: 'true' })).demo).toBe(false);
    expect(users.addUserPayload(null)).toMatchObject({ demo: false, copyFrom: { llm: false, defaults: false, mailbox: false } });
  });

  // An administrator never sets anyone's password, so none is sent, even
  // from a form that still held one.
  test('no password travels, whatever the form held', () => {
    expect(users.addUserPayload(form({ password: 'twelve chars at least' }))).not.toHaveProperty('password');
    expect(users.addUserPayload(form({ demo: false, password: 'x' }))).not.toHaveProperty('password');
  });
});

describe('Admin › Invite a user: why it cannot be sent yet (addUserProblem)', () => {
  test('the mailbox copy needs the sender the demo account processes emails from', () => {
    const problem = users.addUserProblem(form({ mailboxFilterFrom: '' }));
    expect(problem).toBe('Mailbox needs a sender address: the demo account only processes emails from that sender');
    expect(users.addUserProblem(form({ mailboxFilterFrom: '   ' }))).toBe(problem);
    expect(users.addUserProblem(form({ mailboxFilterFrom: undefined }))).toBe(problem);
  });

  // The mail server matches the filter anywhere in a sender, so the server
  // takes one whole address (routes/admin.js FULL_ADDRESS); so does the form.
  test('the sender must be one whole address, not a domain or part of one', () => {
    for (const filter of ['gmail.com', 'vendor', '@vendor.com', 'bills@', 'bills@vendor', 'a@b.com, c@d.com',
      'Bills <bills@vendor.com>', 'bills @vendor.com', 'bills@vendor..com']) {
      expect(users.addUserProblem(form({ mailboxFilterFrom: filter })))
        .toBe('Mailbox needs one whole sender address, such as bills@vendor.com: a domain or part of an address would match almost every email');
    }
    for (const filter of ['bills@vendor.com', ' Bills.Payable+sg@mail.vendor.co.uk ']) {
      expect(users.addUserProblem(form({ mailboxFilterFrom: filter }))).toBeNull();
    }
  });

  test('the form and the server ask the same of the address', () => {
    const pattern = src => src.match(/const FULL_ADDRESS = (\/.+\/);/)[1];
    expect(pattern(read('pages/admin/users.js'))).toBe(pattern(fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8')));
  });

  test('with a sender, without the mailbox, or for an ordinary account, nothing stands in the way', () => {
    expect(users.addUserProblem(form())).toBeNull();
    expect(users.addUserProblem(form({ copyFrom: { llm: true, defaults: true, mailbox: false }, mailboxFilterFrom: '' }))).toBeNull();
    expect(users.addUserProblem(form({ demo: false, mailboxFilterFrom: '' }))).toBeNull();
    expect(users.addUserProblem(null)).toBeNull();
  });
});

describe('Admin › Invite a user: what was copied, under the result (copiedNote)', () => {
  const sent = extra => users.addUserPayload(form(extra));

  test('names what was copied, from the answer, in the order the boxes show', () => {
    expect(users.copiedNote(sent(), { user: { email: 'demo@nexsoss.com', demo: true }, copied: ['mailbox', 'llm', 'defaults'] }))
      .toBe('Demo account: copied LLM keys, invoice defaults, mailbox.');
  });

  test('names a ticked group the answer did not copy: the admin had nothing in it', () => {
    expect(users.copiedNote(sent(), { user: { email: 'demo@nexsoss.com', demo: true }, copied: ['llm', 'defaults'] }))
      .toBe('Demo account: copied LLM keys, invoice defaults. Not copied, as you have none set up: mailbox.');
    expect(users.copiedNote(sent(), { user: { email: 'demo@nexsoss.com', demo: true }, copied: [] }))
      .toBe('Demo account. Not copied, as you have none set up: LLM keys, invoice defaults, mailbox.');
    // Unticked is not "not copied".
    expect(users.copiedNote(sent({ copyFrom: { llm: true, defaults: false, mailbox: false } }), { user: { email: 'demo@nexsoss.com', demo: true }, copied: ['llm'] }))
      .toBe('Demo account: copied LLM keys.');
  });

  test('an ordinary account has nothing to say: the invite result says it all', () => {
    expect(users.copiedNote(sent({ demo: false }), { user: { email: 'demo@nexsoss.com', demo: false }, copied: [] })).toBe('');
  });

  test('an answer with nothing in it falls back to what was sent', () => {
    expect(users.copiedNote(sent(), {})).toBe('Demo account. Not copied, as you have none set up: LLM keys, invoice defaults, mailbox.');
    expect(users.copiedNote(sent({ demo: false }), undefined)).toBe('');
    expect(users.copiedNote(sent(), { user: { email: 'demo@nexsoss.com', demo: true }, copied: ['xero', 'llm'] }))
      .toBe('Demo account: copied LLM keys. Not copied, as you have none set up: invoice defaults, mailbox.');
  });

  test('the banner that said "created" is gone: the invite result takes its place', () => {
    expect(users.createdMessage).toBeUndefined();
  });
});

describe('Admin › Invite a user: the copy boxes', () => {
  test('are the three settings the route copies, and all start ticked for a demo account', () => {
    expect(users.copyBoxes()).toEqual([
      { key: 'llm',      label: 'LLM keys' },
      { key: 'defaults', label: 'Invoice defaults' },
      { key: 'mailbox',  label: 'Mailbox (IMAP)' },
    ]);
    expect(users.copyDefaults()).toEqual({ llm: true, defaults: true, mailbox: true });
    // A fresh object each time: the form resets to it.
    expect(users.copyDefaults()).not.toBe(users.copyDefaults());
  });
});

describe('Admin › Users: the badge on a demo row (demoBadge)', () => {
  test('a muted "demo" with what it means; nothing on any other row', () => {
    expect(users.demoBadge({ id: 'u3', email: 'demo@nexsoss.com', demo: true }))
      .toEqual({ text: 'demo', title: 'Demo account: sample data, no Xero connection' });
    expect(users.demoBadge({ id: 'u3', email: 'demo@nexsoss.com', role: 'user', demo: true }))
      .toEqual({ text: 'demo', title: 'Demo account: sample data, no Xero connection' });
    expect(users.demoBadge({ demo: false })).toBeNull();
    expect(users.demoBadge({ demo: 'true' })).toBeNull();
    expect(users.demoBadge({})).toBeNull();
    expect(users.demoBadge(null)).toBeNull();
  });

  // An admin switches their own account to sample data and back
  // (PUT /api/setup/data-source); the row says it is their choice.
  test('an admin on sample data: their choice, their Xero connection kept', () => {
    expect(users.demoBadge({ id: 'u1', email: 'owner@nexsoss.com', role: 'admin', demo: true }))
      .toEqual({ text: 'sample data', title: 'On sample data by their own choice; their Xero connection is kept' });
    expect(users.demoBadge({ role: 'admin', demo: false })).toBeNull();
  });
});

describe('Setup › Xero Connection for a demo account', () => {
  // GET /api/xero/connection as the server answers it for a demo account.
  const answer = {
    connected: true, method: 'demo', demo: true, needsReconnect: false, reason: null,
    tenants: [{ tenantId: 'demo-company', tenantName: 'Demo Company Pte Ltd' }],
  };

  test('the demo card for a demo account, from the signed-in user before any request, or from the answer', () => {
    expect(connect.connectionView(null, { id: 'u3', demo: true })).toBe('demo');
    expect(connect.connectionView(answer, { id: 'u3', demo: false })).toBe('demo');
    expect(connect.connectionView(answer, undefined)).toBe('demo');
  });

  test('the card as it is for everyone else', () => {
    expect(connect.connectionView({ connected: true, method: 'oauth', optional: {} }, { id: 'u1', demo: false })).toBe('xero');
    expect(connect.connectionView({ connected: false, method: 'custom' }, { id: 'u1' })).toBe('xero');
    expect(connect.connectionView(null, null)).toBe('xero');
    expect(connect.connectionView(undefined, undefined)).toBe('xero');
    expect(connect.connectionView({ demo: 'yes' }, { demo: 1 })).toBe('xero');
  });

  test('the note in place of the connect options, and the one row standing for the companies', () => {
    expect(connect.demoCard(answer)).toEqual({
      note: 'Demo account: the dashboard shows Demo Company Pte Ltd, sample data generated by this app. '
          + 'No Xero connection is made, and nothing is sent to Xero.',
      status: '● Connected',
      company: 'Demo Company Pte Ltd (sample data)',
    });
  });

  test('named as the answer names the company, or as the app does until it has answered', () => {
    expect(connect.demoCard({ demo: true, tenants: [{ tenantId: 'demo-company', tenantName: 'Sample Co' }] }))
      .toMatchObject({ note: expect.stringContaining('shows Sample Co,'), company: 'Sample Co (sample data)' });
    expect(connect.demoCard(null).company).toBe('Demo Company Pte Ltd (sample data)');
    expect(connect.demoCard({ demo: true, tenants: [] }).company).toBe('Demo Company Pte Ltd (sample data)');
  });

  test('the optional-permission boxes are untouched by it', () => {
    expect(connect.defaultBoxes(null)).toEqual({ live: false, balance: false });
    expect(connect.optionalBoxes().map(b => b.key)).toEqual(['live', 'balance']);
  });
});

describe('Dashboard › the live updates line for demo data (liveLabel)', () => {
  const T1 = '2026-10-10T02:02:00.000Z';
  const T2 = '2026-10-10T02:04:00.000Z';
  const clock = t => new Date(t).toISOString().slice(11, 16);
  const DEMO = { asOf: 'Sample data', checked: null, off: '· does not change', reason: 'Demo data does not change', reconnect: false, demo: true };

  test('"Demo data does not change" from the version route is a plain line: no read time, no check, no reconnect', () => {
    expect(live.liveLabel({ fetchedAt: T1, checkedAt: T2, live: false, liveReason: 'Demo data does not change' }, clock)).toEqual(DEMO);
    expect(live.liveLabel({ fetchedAt: Date.parse(T1), checkedAt: null, live: false, liveReason: 'Demo data does not change' }, clock)).toEqual(DEMO);
  });

  test('the account alone says so, before the version route has answered', () => {
    expect(live.liveLabel({ fetchedAt: T1, demo: true }, clock)).toEqual({ ...DEMO, reason: null });
    expect(live.liveLabel({ fetchedAt: T1, checkedAt: T2, live: true, liveReason: null, demo: true }, clock)).toEqual({ ...DEMO, reason: null });
  });

  test('every other line is as it was, with no demo mark on it', () => {
    const reconnect = live.liveLabel({ fetchedAt: T1, checkedAt: null, live: false, liveReason: 'Reconnect Xero once to allow live updates' }, clock);
    expect(reconnect).toEqual({
      asOf: 'Xero data as of 02:02', checked: null, off: '· live updates off',
      reason: 'Reconnect Xero once to allow live updates', reconnect: true,
    });
    expect(reconnect).not.toHaveProperty('demo');
    expect(live.liveLabel({ fetchedAt: T1, checkedAt: T2, live: true, liveReason: null, demo: false }, clock))
      .toEqual({ asOf: 'Xero data as of 02:02', checked: '· checked 02:04', off: null, reason: null, reconnect: false });
    // A reason only counts while live updates are off, as before.
    expect(live.liveLabel({ fetchedAt: T1, live: true, liveReason: 'Demo data does not change' }, clock).off).toBeNull();
  });
});

describe('Admin › Users is wired to them', () => {
  const admin = read('pages/Admin.jsx');

  test('the form sends demo, copyFrom and mailboxFilterFrom through the helper, and is held while it has a problem', () => {
    // The 2-step helpers (mfa-ui.test.js) share the import.
    expect(admin).toMatch(/import \{ lockBadge, failedNote, mustSetNote, demoBadge, copyBoxes, copyDefaults, addUserPayload, addUserProblem, copiedNote, inviteNote, revokeInviteAsk\b[^}]*\} from '\.\/admin\/users';/);
    expect(admin).toContain('const form = { email, role, demo, copyFrom, mailboxFilterFrom: filterFrom };');
    expect(admin).toContain('const createProblem = addUserProblem(form);');
    expect(admin).toContain('if (createProblem) { setError(createProblem); return; }');
    expect(admin).toContain('const payload = addUserPayload(form);');
    expect(admin).toContain("const created = await api.post('/admin/users', payload);");
    // The result says what was copied, from the answer, under the invite.
    expect(admin).toContain('setInvited({ email: created.user?.email || payload.email, invite: created.invite || {}, copied: copiedNote(payload, created) });');
    expect(admin).toContain('extra={invited.copied}');
    expect(admin).toMatch(/disabled=\{inviting \|\| !!createProblem\}\s+title=\{createProblem \|\| undefined\}/);
    // The form starts over after a create, demo block included.
    expect(admin).toContain("setDemo(false); setCopyFrom(copyDefaults()); setFilterFrom('');");
  });

  test('the demo block: the tick, the copy boxes once ticked, the sender with the mailbox, and the note', () => {
    expect(admin).toContain('<strong>Demo account</strong> — sample data, no Xero connection');
    expect(admin).toMatch(/onChange=\{e => \{ setDemo\(e\.target\.checked\); setCopyFrom\(copyDefaults\(\)\); setFilterFrom\(''\); \}\}/);
    expect(admin).toMatch(/\{demo && \(\s+<div[^>]*>\s+<div[^>]*>\s+Copy my settings to this account:/);
    expect(admin).toMatch(/\{copyBoxes\(\)\.map\(\(\{ key, label \}\) => \(/);
    expect(admin).toMatch(/\{copyFrom\.mailbox && \([\s\S]*?Only process emails from[\s\S]*?\(needed with Mailbox\)/);
    expect(admin).toMatch(/<input id="admin-filter-from"\s+type="email"[\s\S]*?required\s+\/>/);
    expect(admin).toContain('Two accounts watching one mailbox must watch different senders: the demo account only processes emails from this address.');
  });

  test('a demo row carries the muted badge', () => {
    expect(admin).toMatch(/const isDemo\s+= demoBadge\(u\);/);
    expect(admin).toMatch(/\{isDemo && \(\s+<span className="badge badge-gray" title=\{isDemo\.title\}>\{isDemo\.text\}<\/span>/);
  });

  // Demo accounts were once allowed a short, permanent password; the one used
  // turned up in this public repository. Then every password an admin set was
  // temporary. Now an admin sets none: an account is invited, and a reset is
  // a link, so the person chooses their own (invite-ui.test.js).
  test('an admin sets no password, demo account or not: no password field, no temporary-password dialog', () => {
    expect(admin).not.toMatch(/from '\.\/account\/password-rules'/);
    expect(admin).not.toMatch(/passwordProblem|passwordHint|PASSWORD_MIN_LENGTH/);
    expect(admin).not.toContain('function ResetPasswordDialog(');
    expect(admin).not.toContain('id="admin-password"');
    expect(admin).not.toContain('Temporary password</label>');
    expect(admin).not.toMatch(/demoRule|shortPasswordAllowed|DEMO_PASSWORD_MIN_LENGTH/);
  });

  // A demo account may still have the short password from before; made an
  // admin, the server makes it choose a new one, and the page says so.
  test('making a demo account an admin says it must choose a new password', () => {
    const role = admin.slice(admin.indexOf('async function handleRole('), admin.indexOf('async function handleSignOut('));
    expect(role).toContain("const newPassword = role === 'admin' && u.demo === true;");
    expect(role).toContain('As a demo account, it must choose a new password before anything else.');
    expect(role).toContain('They must choose a new password before anything else.');
  });

  // An admin on sample data with their own Xero is switched back to it when
  // made a user (routes/admin.js); the page warns first and says whether it
  // happened, from the answer.
  test('removing admin from someone on sample data says they go back to their own Xero', () => {
    const role = admin.slice(admin.indexOf('async function handleRole('), admin.indexOf('async function handleSignOut('));
    expect(role).toContain("const onSample = role === 'user' && u.demo === true;");
    expect(role).toContain('They are on sample data: if they have their own Xero connection, they are switched back to it, as a user cannot switch.');
    expect(role).toMatch(/answer => `[^`]*\$\{answer\.switchedToXero \? ' They are back on their own Xero\.' : ''\}`/);
    // control() hands a function its answer.
    expect(admin).toContain('const answer = await send();');
    expect(admin).toContain("if (done) toast.success(typeof done === 'function' ? done(answer || {}) : done);");
  });
});

describe('Setup is wired to them', () => {
  const page = read('pages/Setup.jsx');
  const card = page.slice(page.indexOf('function XeroConnectionCard('), page.indexOf('function LlmKeysCard('));
  const branch = card.slice(card.indexOf("if (connectionView(connection, user) === 'demo') {"), card.indexOf('Connect via Custom Connection credentials'));

  test('the card takes the signed-in user and decides through the helper, after every hook', () => {
    expect(page).toMatch(/import \{ boxState, defaultBoxes, extrasParam, optionalBoxes, connectionView, demoCard \} from '\.\/setup\/connect';/);
    expect(page).toMatch(/<XeroConnectionCard\s+idx=\{0\} user=\{user\} sectionData=\{config\.xero\}/);
    expect(card).toMatch(/function XeroConnectionCard\(\{ idx, user, values,/);
    expect(branch.length).toBeGreaterThan(0);
    const decision = card.indexOf("if (connectionView(connection, user) === 'demo') {");
    expect(card.lastIndexOf('useState(')).toBeLessThan(decision);
    expect(card.lastIndexOf('useEffect(')).toBeLessThan(decision);
    expect(card.lastIndexOf('useConfirm(')).toBeLessThan(decision);
  });

  test('the demo card says the note and the one connected row, and offers nothing to connect, test or disconnect', () => {
    expect(branch).toContain('const card = demoCard(connection);');
    expect(branch).toContain('<div className="card-title">Xero Connection</div>');
    expect(branch).toContain('{card.note}');
    expect(branch).toMatch(/<span className="badge badge-green"[^>]*>\{card\.status\}<\/span>\s+\{card\.company\}/);
    for (const action of ['Connect to Xero', 'Disconnect', 'Test Custom Connection', '<Field', 'optionalBoxes()', 'HelpLink', 'DefaultTenantPicker']) {
      expect(branch).not.toContain(action);
    }
  });

  test('the card for everyone else is as it was', () => {
    const rest = card.slice(card.indexOf('Connect via Custom Connection credentials'));
    expect(rest).toContain('🔗 Connect to Xero');
    expect(rest).toContain('⚡ Test Custom Connection');
    expect(rest).toContain('companyBadge(connection, connectionFailed)');
    expect(rest).toContain('{optionalBoxes().map(({ key, label }) => {');
  });
});

describe('the Dashboard is wired to them', () => {
  const page = read('pages/XeroInsights.jsx');
  const bits = read('pages/xero-insights/bits.jsx');

  test('the pill beside the title for a demo account, and the lines that claimed a Xero connection', () => {
    expect(page).toContain('const demo = user?.demo === true;');
    expect(page).toMatch(/<h1>Dashboard<\/h1>\s+\{demo && \(\s+<span className="badge badge-gray"[^>]*>\s+Demo Company · sample data\s+<\/span>/);
    expect(page).toContain("${organisation.name} · ${demo ? 'sample data' : 'Connected via Xero'}");
    expect(page).toContain("{demo ? 'Sample data generated by this app' : 'Connected via Xero'}");
  });

  test('the status line is told, and says it plainly: no red, no Setup link for a demo', () => {
    expect(page).toMatch(/liveReason: version\?\.liveReason, demo \},/);
    const status = bits.slice(bits.indexOf('export function LiveStatus('));
    expect(status).toMatch(/title=\{label\.demo \? 'Sample data generated by this app; nothing is read from Xero' : 'When Xero was last read for the figures on screen'\}/);
    expect(status).not.toContain('var(--danger)');
    // The way to Setup is offered only when the label says a reconnect cures it.
    expect(status).toMatch(/\{label\.reconnect && /);
  });
});
