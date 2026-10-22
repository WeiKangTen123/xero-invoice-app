const fs   = require('fs');
const path = require('path');

// The privacy notice and the "Get set up" checklist, on the screen side. As
// in data-source-ui.test.js, there is no React test setup in this project,
// so the decisions — the notice's words, when it is shown, what the
// checklist counts and where each step leads — are plain functions in files
// with no imports, loaded whole and run here; the wiring is checked in the
// source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}

describe('the privacy notice (components/privacy-notice.js)', () => {
  const pn = load('components/privacy-notice.js');

  test("its version is the server's: raised together, or an account is never asked again (or never let go)", () => {
    const server = fs.readFileSync(path.join(__dirname, '../utils/onboarding.js'), 'utf8');
    const v = Number(server.match(/^const NOTICE_VERSION = (\d+);$/m)[1]);
    expect(pn.PRIVACY_NOTICE_VERSION).toBe(v);
    expect(v).toBe(1);
  });

  test('the words of version 1, naming who to ask', () => {
    expect(pn.PRIVACY_NOTICE_TITLE).toBe('Before you start');
    expect(pn.PRIVACY_NOTICE_BUTTON).toBe('I understand');
    expect(pn.noticeParagraphs('privacy@firm.example')).toEqual([
      'This app keeps your email address, and the times and places you sign in from (IP address, browser and approximate city), to keep accounts safe. Sign-in records are kept for 90 days and admin actions for 2 years.',
      'Documents you send in are stored on a Google Cloud server in the United States and read by Google Gemini. Documents you post go to your Xero.',
      'Questions or requests about your data: privacy@firm.example.',
    ]);
  });

  test('with no one to name, the administrator', () => {
    for (const c of [null, undefined, '', '   ', 42]) {
      expect(pn.noticeParagraphs(c)[2]).toBe('Questions or requests about your data: your administrator.');
    }
    expect(pn.contactText(' a@b.co ')).toBe('a@b.co');
  });

  test('never asked for, or shown, while a password must be set or 2-step sign-in set up', () => {
    const user = { id: 'u1' };
    expect(pn.canAskForNotice(user)).toBe(true);
    expect(pn.canAskForNotice({ ...user, mustChangePassword: true })).toBe(false);
    expect(pn.canAskForNotice({ ...user, mfaSetupRequired: true })).toBe(false);
    expect(pn.canAskForNotice(null)).toBe(false);

    const required = { required: true, version: 1, contact: 'a@b.co' };
    expect(pn.shouldShowNotice(user, required)).toBe(true);
    expect(pn.shouldShowNotice({ ...user, mustChangePassword: true }, required)).toBe(false);
    expect(pn.shouldShowNotice({ ...user, mfaSetupRequired: true }, required)).toBe(false);
    expect(pn.shouldShowNotice(user, { ...required, required: false })).toBe(false);
    expect(pn.shouldShowNotice(user, null)).toBe(false);
    expect(pn.shouldShowNotice(user, { required: 'yes' })).toBe(false);
  });

  test('a notice changed since the page loaded asks for a reload; anything else, another press', () => {
    expect(pn.acknowledgeError({ status: 409, code: 'NOTICE_CHANGED' })).toMatch(/reload the page/i);
    expect(pn.acknowledgeError({ status: 500, message: 'Internal server error' }))
      .toBe('Could not save that: Internal server error. Try again.');
    expect(pn.acknowledgeError(null)).toBe('Could not save that: the server did not answer. Try again.');
  });
});

describe('the checklist (components/setup-checklist.js)', () => {
  const sc = load('components/setup-checklist.js');
  const step = (done, detail = '') => ({ done, detail });

  test("four steps in the setup guide's order, each with where to go", () => {
    expect(sc.CHECKLIST_STEPS.map(s => [s.key, s.label, s.to, s.action])).toEqual([
      ['llm',     'AI reading', '/setup#setup-llm',  'Set up'],
      ['mailbox', 'Mailbox',    '/setup#setup-imap', 'Set up'],
      ['xero',    'Xero',       '/setup#setup-xero', 'Connect'],
      ['watcher', 'Watcher',    '/automation',       'Start watcher'],
    ]);
    expect(sc.CHECKLIST_TITLE).toBe('Get set up');
    expect(sc.CHECKLIST_HINT).toBe('Save in Setup before pressing Test.');
  });

  test('counted and drawn in that order, whatever order the server sent', () => {
    const view = sc.checklistView({
      watcher: step(false, 'Off'), xero: step(true, 'Sample data'), mailbox: step(false, 'Not set up yet'), llm: step(true, '1 key · tested 22 Oct'),
    });
    expect(view.rows.map(r => [r.key, r.done, r.detail])).toEqual([
      ['llm', true, '1 key · tested 22 Oct'], ['mailbox', false, 'Not set up yet'], ['xero', true, 'Sample data'], ['watcher', false, 'Off'],
    ]);
    expect(view).toMatchObject({ doneCount: 2, total: 4, percent: 50, complete: false });
    expect(sc.progressText(view)).toBe('2 of 4');
    expect(sc.showChecklist(view)).toBe(true);
  });

  test('a step left out, or not strictly done, is not done', () => {
    const view = sc.checklistView({ llm: step('true'), mailbox: { done: 1 } });
    expect(view.rows.every(r => !r.done && r.detail === '')).toBe(true);
    expect(sc.progressText(view)).toBe('0 of 4');
  });

  test('gone once all four are done; nothing drawn without a checklist', () => {
    const all = sc.checklistView({ llm: step(true), mailbox: step(true), xero: step(true), watcher: step(true) });
    expect(all).toMatchObject({ doneCount: 4, percent: 100, complete: true });
    expect(sc.showChecklist(all)).toBe(false);
    expect(sc.checklistView(null)).toBeNull();
    expect(sc.showChecklist(sc.checklistView(undefined))).toBe(false);
  });

  test("a Setup card's anchor, and nothing else", () => {
    expect(sc.setupAnchor('#setup-llm')).toBe('setup-llm');
    expect(sc.setupAnchor('#default-xero-company')).toBe('');
    expect(sc.setupAnchor('')).toBe('');
    expect(sc.setupAnchor('#setup-x"><img')).toBe('');
  });
});

describe('wiring', () => {
  test('Layout asks the server once the account may be asked, and shows the notice over the page', () => {
    const src = read('components/layout/Layout.jsx');
    expect(src).toContain("import PrivacyNotice from '../PrivacyNotice';");
    expect(src).toContain("import { canAskForNotice, shouldShowNotice } from '../privacy-notice';");
    expect(src).toContain("import { useAuth } from '../../context/AuthContext';");
    expect(src).toContain('const askable = canAskForNotice(user);');
    expect(src).toMatch(/if \(!askable\) return;\s+let live = true;\s+api\.get\('\/onboarding'\)/);
    expect(src).toContain('}, [user?.id, askable]);');
    expect(src).toContain('{shouldShowNotice(user, notice) && (');
    expect(src).toContain('<PrivacyNotice contact={notice.contact} onDone={() => setNotice(n => ({ ...n, required: false }))} />');
  });

  test('the notice can only be left by pressing I understand, which records the version shown', () => {
    const src = read('components/PrivacyNotice.jsx');
    expect(src).toContain("await api.post('/onboarding/notice', { version: PRIVACY_NOTICE_VERSION });");
    // No onClose: Escape and a click outside do nothing (Modal.jsx).
    expect(src).toMatch(/<Modal busy=\{saving\} maxWidth=\{480\} zIndex=\{1100\} label=\{PRIVACY_NOTICE_TITLE\}>/);
    expect(src).not.toMatch(/onClose/);
    expect(src).toContain('{noticeParagraphs(contact).map((text, i) => (');
    expect(src).toContain('setError(acknowledgeError(err));');
    expect(src).toContain(': PRIVACY_NOTICE_BUTTON}');
  });

  test('the checklist reads the server, again on focus and when told to', () => {
    const src = read('components/SetupChecklist.jsx');
    expect(src).toContain("const d = await api.get('/onboarding');");
    expect(src).toContain('useEffect(() => { load(); }, [load, refreshKey]);');
    expect(src).toContain("window.addEventListener('focus', load);");
    expect(src).toContain("return () => window.removeEventListener('focus', load);");
    expect(src).toContain('if (!showChecklist(view)) return null;');
    expect(src).toContain('{progressText(view)}');
    expect(src).toContain("{row.done ? '✓' : '○'}");
    expect(src).toContain('<Link to={row.to} className="btn btn-outline btn-sm"');
    expect(src).toContain('{CHECKLIST_HINT}');
  });

  test("Setup: the checklist on top, refreshed after a save, a Test, a key change and a Xero change", () => {
    const src = read('pages/Setup.jsx');
    expect(src).toContain('<SetupChecklist refreshKey={checklistVersion} />');
    expect(src.indexOf('<SetupChecklist')).toBeLessThan(src.indexOf('<form id="setup-form"'));
    expect(src).toMatch(/setTesting\(prev => \(\{ \.\.\.prev, \[type\]: false \}\)\);\s+\/\/[^\n]*\n\s+refreshChecklist\(\);/);
    expect(src).toMatch(/savedTimer\.current = setTimeout\(\(\) => setSaved\(false\), 3500\);\s+\/\/[^\n]*\n\s+refreshChecklist\(\);/);
    expect(src).toContain('onConnectionChange={() => { setXeroVersion(v => v + 1); refreshChecklist(); }}');
    expect(src).toContain('onKeysChange={refreshChecklist}');
    expect((src.match(/onKeysChange\?\.\(\);/g) || []).length).toBe(2);
  });

  test("every Setup step's link lands on a card with that id, brought into view once loaded", () => {
    const sc = load('components/setup-checklist.js');
    const src = read('pages/Setup.jsx');
    expect((src.match(/<div id="setup-xero" className="card"/g) || []).length).toBe(2);   // demo and real
    expect(src).toContain('<div id="setup-llm" className="card"');
    expect(src).toContain('<div id={`setup-${sectionKey}`} className="card"');
    expect(src).toMatch(/\{\['imap'\]\.map\(\(key, idx\) => \{/);   // the mailbox card is SectionCard 'imap'
    for (const s of sc.CHECKLIST_STEPS.filter(x => x.to.startsWith('/setup#'))) {
      const id = s.to.split('#')[1];
      expect(['setup-xero', 'setup-llm', 'setup-imap']).toContain(id);
    }
    expect(src).toContain('const id = setupAnchor(hash);');
    expect(src).toContain("if (loaded && id) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });");
  });

  test('Setup: the privacy contact, server-wide and admin-only, after email sending', () => {
    const src = read('pages/Setup.jsx');
    const meta = src.slice(src.indexOf('  privacy: {'), src.indexOf('};', src.indexOf('  privacy: {')));
    expect(meta).toContain("label: 'Privacy contact (admin)'");
    expect(meta).toContain('testKey: null');
    expect(src).toMatch(/\{config\.privacy && \(\s+<SectionCard\s+sectionKey="privacy" meta=\{SECTION_META\.privacy\} sectionData=\{config\.privacy\}/);
    expect(src.indexOf('sectionKey="privacy"')).toBeGreaterThan(src.indexOf("'xeroOAuth', 'email'].map"));
  });

  test('the Dashboard shows the checklist where Xero is not connected yet', () => {
    const src = read('pages/XeroInsights.jsx');
    expect(src).toContain("import SetupChecklist from '../components/SetupChecklist';");
    const notConnected = src.slice(src.indexOf('if (!data.connected) {'), src.indexOf('const { organisation, kpis, tenants } = data;'));
    expect(notConnected).toContain('<SetupChecklist />');
    expect(src.match(/<SetupChecklist/g)).toHaveLength(1);
  });
});
