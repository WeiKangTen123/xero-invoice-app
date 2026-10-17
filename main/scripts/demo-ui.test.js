const fs   = require('fs');
const path = require('path');

// Demo accounts on the screen side. A demo account shows sample data this app
// generates in place of a Xero connection (GET /api/auth/me carries `demo`).
// There is no React test setup in this project (see login-ui.test.js), so
// the decisions — what the Add User form sends and when it cannot be sent,
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

// The form as Admin.jsx holds it: the three fields it always had, the Demo
// account tick, the copy boxes and the sender address.
const form = extra => ({
  email: 'demo@nexsoss.com', password: 'twelve chars at least', role: 'user',
  demo: true, copyFrom: { llm: true, defaults: true, mailbox: true }, mailboxFilterFrom: 'bills@vendor.com',
  ...extra,
});

describe('Admin › Add User: what the form sends (addUserPayload)', () => {
  test('a demo account carries the copy ticks and the sender address, trimmed', () => {
    expect(users.addUserPayload(form({ mailboxFilterFrom: '  bills@vendor.com ' }))).toEqual({
      email: 'demo@nexsoss.com', password: 'twelve chars at least', role: 'user',
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
      email: 'demo@nexsoss.com', password: 'twelve chars at least', role: 'user',
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
});

describe('Admin › Add User: why it cannot be sent yet (addUserProblem)', () => {
  test('the mailbox copy needs the sender the demo account processes emails from', () => {
    const problem = users.addUserProblem(form({ mailboxFilterFrom: '' }));
    expect(problem).toBe('Mailbox needs a sender address: the demo account only processes emails from that sender');
    expect(users.addUserProblem(form({ mailboxFilterFrom: '   ' }))).toBe(problem);
    expect(users.addUserProblem(form({ mailboxFilterFrom: undefined }))).toBe(problem);
  });

  test('with a sender, without the mailbox, or for an ordinary account, nothing stands in the way', () => {
    expect(users.addUserProblem(form())).toBeNull();
    expect(users.addUserProblem(form({ copyFrom: { llm: true, defaults: true, mailbox: false }, mailboxFilterFrom: '' }))).toBeNull();
    expect(users.addUserProblem(form({ demo: false, mailboxFilterFrom: '' }))).toBeNull();
    expect(users.addUserProblem(null)).toBeNull();
  });
});

describe('Admin › Add User: the copy boxes', () => {
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
    expect(users.demoBadge({ demo: false })).toBeNull();
    expect(users.demoBadge({ demo: 'true' })).toBeNull();
    expect(users.demoBadge({})).toBeNull();
    expect(users.demoBadge(null)).toBeNull();
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
    expect(admin).toMatch(/import \{ lockBadge, failedNote, mustSetNote, demoBadge, copyBoxes, copyDefaults, addUserPayload, addUserProblem \} from '\.\/admin\/users';/);
    expect(admin).toContain('const form = { email, password: pass, role, demo, copyFrom, mailboxFilterFrom: filterFrom };');
    expect(admin).toContain('const createProblem = addUserProblem(form);');
    expect(admin).toContain('if (createProblem) { setError(createProblem); return; }');
    expect(admin).toContain("await api.post('/admin/users', addUserPayload(form));");
    expect(admin).toMatch(/disabled=\{!!passwordProblem\(pass, email, \{ demo \}\) \|\| !!createProblem\}\s+title=\{createProblem \|\| undefined\}/);
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
