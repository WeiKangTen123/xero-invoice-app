// The chat launcher is pinned to the bottom-right corner of every page, above
// everything else, and the Setup page's "Save settings" button sat exactly
// under it: it read "Save setti" and a click opened the chat. The cure is one
// measurement, --fab-clearance in globals.css, that sizes the launcher and
// that every bottom-pinned bar keeps free on its right. This pins both halves
// at the source, since the UI cannot be rendered on this machine: the
// variable must exist for desktop and phone, the launcher must be sized from
// it, and every bar pinned to the bottom must reserve it.
const fs   = require('fs');
const path = require('path');

const UI   = path.join(__dirname, '..', '..', 'ui', 'src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

describe('the chat launcher and the bars pinned to the bottom', () => {
  const css = read('styles/globals.css');

  test('globals.css defines the launcher size, corner and clearance for desktop and phone', () => {
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    expect(root).toMatch(/--fab-size:\s*54px/);
    expect(root).toMatch(/--fab-offset:\s*26px/);
    expect(root).toMatch(/--fab-clearance:\s*calc\(var\(--fab-offset\) \+ var\(--fab-size\) \+ \d+px\)/);
    const mobile = /\.mobile-mode \{([^}]*)\}/.exec(css)[1];
    expect(mobile).toMatch(/--fab-size:\s*48px/);
    expect(mobile).toMatch(/--fab-offset:\s*16px/);
  });

  test('the launcher is placed and sized from those variables, never from its own numbers', () => {
    const src = read('components/ChatAssistant.jsx');
    const launcher = src.slice(src.indexOf('aria-label="Open the invoice assistant"'), src.indexOf('💬'));
    expect(launcher).toMatch(/right: 'var\(--fab-offset\)'/);
    expect(launcher).toMatch(/width: 'var\(--fab-size\)'/);
    expect(launcher).toMatch(/height: 'var\(--fab-size\)'/);
    expect(launcher).toMatch(/bottom: isMobile \? 'calc\(var\(--bottom-nav-total\) \+ 14px\)' : 'var\(--fab-offset\)'/);
  });

  // Every file that pins something to the bottom edge must reserve the corner.
  // Found by the same search a reviewer would run, so a new bar cannot slip in
  // without either reserving it or being named here as exempt.
  const EXEMPT = new Set([
    'components/ChatAssistant.jsx',   // the launcher itself and its panel
    'components/AccountCodeSelect.jsx', // a list open under (or over) its field, only while open; not a bar
    'components/layout/BottomNav.jsx', // the phone nav sits UNDER the launcher by design
    'components/layout/Layout.jsx',    // the sidebar backdrop covers the whole screen
    'components/Modal.jsx',            // a modal backdrop covers the whole screen
    'context/ToastContext.jsx',        // toasts stack ABOVE the launcher (zIndex 1200)
  ]);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const pinned = walk(UI)
    .filter(f => /\.jsx$/.test(f))
    .map(f => path.relative(UI, f).split(path.sep).join('/'))
    .filter(rel => !EXEMPT.has(rel))
    .filter(rel => /position: '(fixed|sticky)',[\s\S]{0,200}bottom:/.test(read(rel)));

  test('finds the three bars this was written for', () => {
    expect(pinned.sort()).toEqual([
      'pages/Setup.jsx',
      'pages/invoice-review/StickyActionBar.jsx',
      'pages/invoices/MobileSelectionBar.jsx',
    ]);
  });

  test.each([
    ['pages/Setup.jsx',                          /padding: '16px var\(--fab-clearance\) 16px 0'/],
    ['pages/invoice-review/StickyActionBar.jsx', /calc\(var\(--page-pad-x\) \+ var\(--fab-clearance\)\)/],
    ['pages/invoices/MobileSelectionBar.jsx',    /right: 'var\(--fab-clearance\)'/],
  ])('%s keeps the launcher\'s corner free', (rel, pattern) => {
    expect(read(rel)).toMatch(pattern);
  });

  test('every bar pinned to the bottom reserves the corner', () => {
    for (const rel of pinned) expect(read(rel)).toMatch(/--fab-clearance/);
  });

  // Setup's bar was a full-width dark band pinned at the bottom at all times,
  // and hid whatever field scrolled behind it. Now the Save box is in the
  // header's slot on the web layout, and on a phone a small box pinned at the
  // bottom whose strip lets clicks through.
  test('Setup\'s Save box is in the header on the web and a pinned box on a phone, never a band', () => {
    const setup  = read('pages/Setup.jsx');
    const header = read('components/layout/Header.jsx');
    expect(header).toMatch(/<div id="header-page-actions"/);
    expect(setup).toMatch(/document\.getElementById\('header-page-actions'\)/);
    expect(setup).toMatch(/\{!isMobile && headerSlot\s*\? createPortal\(<SaveControls dirty=\{dirty\}/);
    expect(setup).toMatch(/position: 'sticky', bottom: 0, zIndex: 10, pointerEvents: 'none',/);
    expect(setup).toMatch(/pointerEvents: 'auto', padding: '8px 8px 8px 14px'/);
    expect(setup).toMatch(/<SaveControls compact dirty=\{dirty\}/);
    expect(setup).not.toMatch(/linear-gradient\(to top, var\(--bg-primary\) 80%, transparent\)/);
    for (const text of ['Saving…', '● Unsaved changes', '✕ Not saved: ', '✓ Saved', '✓ All settings saved', '● Unsaved', '💾 Save']) expect(setup).toContain(text);
    // Save submits the form by name from wherever the box is, and with
    // unsaved changes the box offers to drop them.
    expect(setup).toMatch(/<form id="setup-form" onSubmit=\{handleSave\}>/);
    expect(setup).toMatch(/type="submit" form="setup-form"/);
    expect(setup).toMatch(/\{dirty && \(\s*<button type="button" className="btn btn-outline btn-sm" disabled=\{saving\} onClick=\{onDiscard\}/);
    expect(setup).toMatch(/function handleDiscard\(\) \{\s*setValues\(savedValues\);/);
    expect(setup.indexOf('className="setup-save-bar"')).toBeGreaterThan(setup.indexOf('<ChartOfAccounts refreshKey'));
  });
});
