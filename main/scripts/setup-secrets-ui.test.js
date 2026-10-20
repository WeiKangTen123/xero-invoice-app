// Setup's stored secrets and Gemini keys (ui/src/pages/setup/secrets.js), and
// the add-key box. "Add key" used to reload Setup as /setup? and never send
// the key: its box was a <form> inside the settings <form>, and Chrome's
// answer to a nested form was to run neither form's handler and submit the
// page the old way (server log 19 Oct 23:55, and headless Chrome with this
// app's React). The page cannot be rendered here, so the rules run as a
// plain module and the wiring is read from the source.
const fs   = require('fs');
const path = require('path');

const UI   = path.join(__dirname, '..', '..', 'ui', 'src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  if (/^import /m.test(src)) throw new Error(`${rel} now imports something; this harness runs it standalone`);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const s = load('pages/setup/secrets.js');

describe('a stored secret is shown as stored', () => {
  const meta = { isSet: true, masked: '••••••••••••tqwz', account: 'weikangten@gmail.com' };

  test('dots and its last four, until Change is pressed or something is typed', () => {
    expect(s.secretView(meta, '', false)).toEqual({ mode: 'saved', masked: '••••••••••••tqwz' });
    expect(s.secretView(meta, '', true)).toEqual({ mode: 'edit' });
    expect(s.secretView(meta, 'new-pass', false)).toEqual({ mode: 'edit' });
    expect(s.secretView({ isSet: false, masked: '' }, '', false)).toEqual({ mode: 'edit' });
    // Too short for the server to spare four characters: dots only.
    expect(s.secretView({ isSet: true, masked: '' }, '', false)).toEqual({ mode: 'saved', masked: '••••••••••••' });
  });

  test('the mailbox password says whose mailbox it opens; the others say nothing', () => {
    expect(s.secretNote('IMAP_PASS', meta)).toBe('Mailbox password for weikangten@gmail.com');
    expect(s.secretNote('XERO_OAUTH_CLIENT_SECRET', { isSet: true, masked: '••••••••••••Rk2P' })).toBe('');
  });

  test('while changing it, the line beside Cancel names it', () => {
    expect(s.changeNote('IMAP_PASS', meta)).toBe('Mailbox password for weikangten@gmail.com (saved one ends tqwz)');
    expect(s.changeNote('XERO_OAUTH_CLIENT_SECRET', { masked: '••••••••••••Rk2P' })).toBe('The saved one (it ends Rk2P) stays if you cancel');
    expect(s.changeNote('XERO_CLIENT_SECRET', { masked: '••••••••••••' })).toBe('The saved one stays if you cancel');
    expect(s.CHANGE_PLACEHOLDER).toBe('Enter a new one — Cancel keeps the saved one');
  });
});

describe('the Gemini key list says what invoice reading runs on', () => {
  test('an empty list: the server\'s shared key, or nothing at all', () => {
    expect(s.keyListEmptyText(true)).toBe("No keys of your own: invoice reading uses this server's shared key");
    expect(s.keyListEmptyText(false)).toBe("No API keys added yet: invoice reading won't work until you add one");
  });

  test('a key in the old single-key field: in use only while no other key is added', () => {
    expect(s.legacyKeyText({ inUse: true })).toBe('saved earlier · in use');
    expect(s.legacyKeyText({ inUse: false })).toBe('saved earlier · not used');
    expect(s.legacyKeyTitle({ inUse: false })).toMatch(/Not used while the keys above are added/);
  });
});

describe('Setup has one form: the settings form', () => {
  const setup = read('pages/Setup.jsx');
  const card  = setup.slice(setup.indexOf('function LlmKeysCard('), setup.indexOf('function flatten('));

  // A form element in JSX carries attributes; the comments that explain why
  // there is only one say "<form>" bare, and are not counted.
  test('no form inside it, so nothing on the page submits the old way', () => {
    expect((setup.match(/<form\s+[A-Za-z]/g) || []).length).toBe(1);
    expect(setup).toMatch(/<form id="setup-form" onSubmit=\{handleSave\}>/);
    expect(card).not.toMatch(/<form[\s>]/);
  });

  test('the add box: a plain button, and Enter adds the key without submitting the settings form', () => {
    expect(card).toMatch(/<div role="group" aria-label="Add a Gemini API key"/);
    expect(card).toMatch(/<button type="button" className="btn btn-primary btn-sm" disabled=\{adding \|\| !newKey\.trim\(\)\} onClick=\{handleAdd\}>/);
    expect((card.match(/onKeyDown=\{addOnEnter\}/g) || []).length).toBe(2);
    expect(card).toMatch(/function addOnEnter\(e\) \{\s*if \(e\.key !== 'Enter'\) return;\s*e\.preventDefault\(\);\s*handleAdd\(\);/);
    expect(card).toMatch(/async function handleAdd\(\) \{\s*if \(!newKey\.trim\(\) \|\| adding\) return;/);
  });

  test('the list shows the old single-field key and what an empty list means', () => {
    expect(card).toContain('setServerKey(!!d.serverKey)');
    expect(card).toContain('{keyListEmptyText(serverKey)}');
    expect(card).toMatch(/\{k\.legacy && \(\s*<span className="badge badge-gray" title=\{legacyKeyTitle\(k\)\}>\{legacyKeyText\(k\)\}<\/span>/);
  });

  test('a stored secret field shows the saved view, Change, and Cancel', () => {
    expect(setup).toMatch(/secretView\(meta, value, editing\)\.mode === 'saved'/);
    expect(setup).toContain('<span className="badge badge-green" style={{ flexShrink: 0 }}>✓ Saved</span>');
    expect(setup).toMatch(/onClick=\{\(\) => setEditing\(true\)\}>Change<\/button>/);
    expect(setup).toMatch(/onClick=\{\(\) => \{ onChange\(name, ''\); setEditing\(false\); \}\}/);
    expect(setup).not.toContain('Saved — leave blank to keep, or enter a new one');
  });
});
