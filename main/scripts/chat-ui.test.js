const fs   = require('fs');
const path = require('path');

// The Invoice Assistant's panel, on the screen side: where it sits (docked
// beside the page on a wide window, over it below that, the whole screen on a
// phone), tables in its replies that scroll rather than being squeezed, and
// the AR & AP list's row numbers that "#5" in a question refers to. There is
// no React test setup in this project (see login-ui.test.js), so the
// decisions are plain functions in files with no imports
// (components/chat-layout.js, utils/visible-invoices.js), loaded whole and
// run here; the wiring is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const layout  = load('components/chat-layout.js');
const visible = () => load('utils/visible-invoices.js'); // a fresh store per test

describe('chatMode: where the chat sits and how wide', () => {
  const at = (viewportWidth, extra = {}) => layout.chatMode({ open: true, isMobile: false, viewportWidth, ...extra });

  test('closed: nothing shown and no room kept, whatever the window', () => {
    expect(layout.chatMode({ open: false, isMobile: false, viewportWidth: 1600 })).toEqual({ mode: 'closed', width: 0 });
    expect(layout.chatMode({ open: false, isMobile: true, viewportWidth: 390, expanded: true })).toEqual({ mode: 'closed', width: 0 });
    expect(layout.chatMode()).toEqual({ mode: 'closed', width: 0 });
  });

  test('docked beside the page from 1280px, 440 wide', () => {
    expect(layout.DOCK_MIN_VIEWPORT).toBe(1280);
    expect(at(1280)).toEqual({ mode: 'docked', width: 440 });
    expect(at(1920)).toEqual({ mode: 'docked', width: 440 });
  });

  test('over the page below 1280px, 440 wide, expanded or not', () => {
    expect(at(1279)).toEqual({ mode: 'overlay', width: 440 });
    expect(at(1024, { expanded: true })).toEqual({ mode: 'overlay', width: 440 });
    expect(at(undefined)).toEqual({ mode: 'overlay', width: 440 });
  });

  test('the whole screen on a phone, however wide the window says it is', () => {
    expect(layout.chatMode({ open: true, isMobile: true, viewportWidth: 390 })).toEqual({ mode: 'fullscreen', width: '100vw' });
    expect(layout.chatMode({ open: true, isMobile: true, viewportWidth: 1400, expanded: true })).toEqual({ mode: 'fullscreen', width: '100vw' });
  });

  test('⤢ widens the docked chat to 720', () => {
    expect(at(1280, { expanded: true })).toEqual({ mode: 'docked', width: 720 });
    expect(layout.CHAT_WIDTH).toBe(440);
    expect(layout.CHAT_WIDTH_EXPANDED).toBe(720);
    expect(layout.EXPANDED_KEY).toBe('xero_chat_expanded');
  });
});

describe('cellKind: how a cell of a reply\'s table wraps', () => {
  test('amounts, counts and percentages are numbers', () => {
    for (const t of ['12', '1,234.56', '$1,234.56', '-$50.00', '(1,200.00)', 'SGD 1,234.56', '1,234.56 SGD', 'S$980.00', '12.5%', ' 7 ', '−3']) {
      expect([t, layout.cellKind(t)]).toEqual([t, 'num']);
    }
  });

  test('references, dates and names are short; a sentence is long', () => {
    for (const t of ['INV-001', 'BLR/2025-26/2078', '2026-10-20', '3 Sep 2026', 'J. Sagar Associates', '—', '', 'SGD1,234', '12 days']) {
      expect([t, layout.cellKind(t)]).toEqual([t, 'short']);
    }
    expect(layout.cellKind('Professional fees for October, including disbursements')).toBe('long');
    expect(layout.cellKind(null)).toBe('short');
    expect(layout.cellKind(42)).toBe('num');
  });
});

describe('the visible-invoices store', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({ id: `inv-${i + 1}`, invoiceNumber: `N${i + 1}`, vendorName: `V${i + 1}` }));
  const T0 = Date.parse('2026-10-20T02:30:00.000Z');
  const MIN = 60 * 1000;

  test('numbers the rows from 1 in the order given, and keeps only n and id', () => {
    const v = visible();
    v.setVisibleInvoices([{ id: 'b', invoiceNumber: '9', vendorName: 'X' }, { id: 'a' }, { id: 7 }], T0);
    expect(v.getVisibleInvoices(T0)).toEqual([{ n: 1, id: 'b' }, { n: 2, id: 'a' }, { n: 3, id: '7' }]);
  });

  test('a row with no id is skipped without moving the numbers after it', () => {
    const v = visible();
    v.setVisibleInvoices([{ id: 'a' }, null, { vendorName: 'no id' }, { id: 'd' }], T0);
    expect(v.getVisibleInvoices(T0)).toEqual([{ n: 1, id: 'a' }, { n: 4, id: 'd' }]);
  });

  test('at most 200, the first 200 shown', () => {
    const v = visible();
    expect(v.VISIBLE_MAX).toBe(200);
    v.setVisibleInvoices(rows(350), T0);
    const got = v.getVisibleInvoices(T0);
    expect(got).toHaveLength(200);
    expect(got[0]).toEqual({ n: 1, id: 'inv-1' });
    expect(got[199]).toEqual({ n: 200, id: 'inv-200' });
  });

  test('kept for 30 minutes, then nothing', () => {
    const v = visible();
    v.setVisibleInvoices(rows(3), T0);
    expect(v.getVisibleInvoices(T0 + 29 * MIN)).toHaveLength(3);
    expect(v.getVisibleInvoices(T0 + 30 * MIN)).toHaveLength(3);
    expect(v.getVisibleInvoices(T0 + 30 * MIN + 1)).toEqual([]);
    // Stored again (the list re-rendered, or was left), the half hour restarts.
    v.setVisibleInvoices(rows(3), T0 + 40 * MIN);
    expect(v.getVisibleInvoices(T0 + 60 * MIN)).toHaveLength(3);
  });

  test('clear empties it; nothing stored, or not a list, is an empty list', () => {
    const v = visible();
    expect(v.getVisibleInvoices(T0)).toEqual([]);
    v.setVisibleInvoices(rows(2), T0);
    v.clearVisibleInvoices();
    expect(v.getVisibleInvoices(T0)).toEqual([]);
    v.setVisibleInvoices('nope', T0);
    expect(v.getVisibleInvoices(T0)).toEqual([]);
  });

  test('what it returns is a copy: changing it changes nothing stored', () => {
    const v = visible();
    v.setVisibleInvoices(rows(2), T0);
    const got = v.getVisibleInvoices(T0);
    got[0].id = 'changed';
    got.push({ n: 9, id: 'x' });
    expect(v.getVisibleInvoices(T0)).toEqual([{ n: 1, id: 'inv-1' }, { n: 2, id: 'inv-2' }]);
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────────
describe('a reply\'s tables scroll inside their own box', () => {
  const md   = read('components/MarkdownMessage.jsx');
  const chat = read('components/ChatAssistant.jsx');

  test('MarkdownMessage wraps every table in a scrolling div and marks each cell\'s kind', () => {
    expect(md).toMatch(/import \{ cellKind \} from '\.\/chat-layout';/);
    expect(md).toMatch(/<ReactMarkdown remarkPlugins=\{\[remarkGfm\]\} components=\{COMPONENTS\}>/);
    expect(md).toMatch(/table: \(\{ node, \.\.\.props \}\) => \(\s*<div className="chat-md-table" style=\{\{ overflowX: 'auto' \}\}>\s*<table \{\.\.\.props\} \/>\s*<\/div>/);
    expect(md).toMatch(/td: \(\{ node, className, \.\.\.props \}\) => \(\s*<td \{\.\.\.props\} className=\{\[className, `cell-\$\{cellKind\(textOf\(props\.children\)\)\}`\]/);
  });

  test('the styles: no squeezing, numbers on one line to the right, sentences no thinner than a few words', () => {
    const css = chat.slice(chat.indexOf('<style>{`'));
    expect(css).toMatch(/\.chat-md-table \{ max-width: 100%; overflow-x: auto;/);
    expect(css).toMatch(/\.chat-md table \{\s*border-collapse: collapse; min-width: 100%;/);
    expect(css).toContain('.chat-md td { min-width: 6em; }');
    expect(css).toContain('.chat-md td.cell-num { text-align: right; white-space: nowrap; }');
    expect(css).toContain('.chat-md td.cell-short { white-space: nowrap; }');
    expect(css).toContain('.chat-md td.cell-long { min-width: 12em; }');
  });

  test('the message list never scrolls sideways, and the bubble clips only top and bottom', () => {
    expect(chat).toMatch(/<div ref=\{scrollRef\} style=\{\{ flex: 1, overflowY: 'auto', overflowX: 'hidden',/);
    expect(chat).toMatch(/<div style=\{\{ maxWidth: '94%', minWidth: 0, overflowX: 'auto', overflowY: 'hidden',/);
    // Every flex item on the way down may shrink below the table's width.
    expect(chat).toMatch(/<div style=\{\{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, flex: 1, minWidth: 0 \}\}>/);
  });
});

describe('"#5" means row 5 of the AR & AP list', () => {
  test('the chat sends the stored list with every message', () => {
    const chat = read('components/ChatAssistant.jsx');
    expect(chat).toMatch(/import \{ getVisibleInvoices \} from '\.\.\/utils\/visible-invoices';/);
    const post = chat.slice(chat.indexOf("api.post('/chat', {"), chat.indexOf('});', chat.indexOf("api.post('/chat', {")));
    expect(post).toContain('visibleInvoices: getVisibleInvoices(),');
    expect(post).toContain('invoiceId: pinnedId || undefined,');
  });

  test('the list stores the rows it shows, in their order, whenever they change and when it is left', () => {
    const page = read('pages/Invoices.jsx');
    expect(page).toMatch(/import \{ setVisibleInvoices \} from '\.\.\/utils\/visible-invoices';/);
    expect(page).toContain('const shownRows  = useMemo(() => groups.flatMap(g => g.rows), [groups]);');
    expect(page).toContain('const rowNumbers = useMemo(() => new Map(shownRows.map((inv, i) => [inv.id, i + 1])), [shownRows]);');
    expect(page).toMatch(/useEffect\(\(\) => \{\s*setVisibleInvoices\(shownRows\);\s*return \(\) => setVisibleInvoices\(shownRows\);\s*\}, \[shownRows\]\);/);
    // The same order as the CSV, which is the rows on screen.
    expect(page).toMatch(/function handleExportCsv\(\) \{\s*const rows = groups\.flatMap\(g => g\.rows\);/);
    expect(page).toMatch(/<MobileList [^\n]*rowNumbers=\{rowNumbers\}/);
    expect(page).toMatch(/<DesktopTable [^\n]*rowNumbers=\{rowNumbers\}/);
  });

  test('the web table\'s first column is #, numbered from the list\'s order; every column kept', () => {
    const t = read('pages/invoices/DesktopTable.jsx');
    const head = t.slice(t.indexOf('<thead>'), t.indexOf('</thead>'));
    // The first heading cell is the # one: before the select-all box and every other heading.
    const first = head.slice(head.search(/<th[\s>]/));
    expect(first).toMatch(/^<th scope="col" style=\{ROW_NO\} title='[^']*'>#<\/th>/);
    expect(head.indexOf('>#</th>')).toBeLessThan(head.indexOf('type="checkbox"'));
    expect(head.indexOf('>#</th>')).toBeLessThan(head.indexOf('<SortHeader'));
    for (const label of ['label="Vendor"', '<th>Invoice #</th>', 'label="Amount"', '<th>Type</th>', 'label="Invoice date"', 'label="Due"', '<th>Received</th>', '<th>PDF</th>', 'label="Status"']) {
      expect(head).toContain(label);
    }
    // One more column for the group headings to span.
    expect(t).toContain('const columns = showDue ? 12 : 11;');
    // The first cell of a row is its number, before the checkbox.
    expect(t).toMatch(/onClick=\{\(\) => openRecord\(inv\.id\)\}\s*>\s*<td style=\{\{ \.\.\.ROW_NO, fontSize: 11\.5, color: 'var\(--text-muted\)' \}\}>\s*\{rowNumbers\?\.get\(inv\.id\)\}\s*<\/td>\s*<td style=\{\{ paddingRight: 0 \}\} onClick=\{e => toggleSelect\(inv\.id, e\)\}>/);
    expect(t).toMatch(/const ROW_NO = \{[^}]*textAlign: 'right'[^}]*fontVariantNumeric: 'tabular-nums'/);
  });

  test('a phone row carries its number too', () => {
    const m = read('pages/invoices/MobileList.jsx');
    expect(m).toMatch(/sortValue, sortOptions, onSortChange, today, rowNumbers \}\)/);
    expect(m).toContain('{rowNumbers?.get(inv.id)}');
  });
});

describe('docked beside the page on a wide window', () => {
  const chat   = read('components/ChatAssistant.jsx');
  const lay    = read('components/layout/Layout.jsx');
  const panel  = chat.slice(chat.indexOf('ref={panelRef}'), chat.indexOf('<div ref={scrollRef}'));

  test('the chat takes its mode from chatMode and reports the docked width to Layout', () => {
    expect(chat).toMatch(/import \{ chatMode, DOCK_MIN_VIEWPORT, EXPANDED_KEY \} from '\.\/chat-layout';/);
    expect(chat).toMatch(/export default function ChatAssistant\(\{ onDockChange \}\)/);
    expect(chat).toContain('const layout = chatMode({ open, isMobile, viewportWidth, expanded });');
    expect(chat).toContain("const docked = layout.mode === 'docked';");
    expect(chat).toContain('const dockWidth = docked ? layout.width : 0;');
    expect(chat).toContain('useEffect(() => { onDockChange?.(dockWidth); }, [onDockChange, dockWidth]);');
    expect(chat).toContain('useEffect(() => () => onDockChange?.(0), [onDockChange]);');
    // The width is read again when the window crosses 1280, not on every resize.
    expect(chat).toContain('window.matchMedia(`(min-width: ${DOCK_MIN_VIEWPORT}px)`)');
  });

  test('Layout keeps that width free right of the page and the banner, not the header', () => {
    expect(lay).toMatch(/import \{ Suspense, useState \} from 'react';/);
    expect(lay).toContain('const [chatDock, setChatDock] = useState(0);');
    expect(lay).toContain("style={{ '--chat-dock-width': `${chatDock}px` }}");
    expect(lay).toMatch(/const DOCK_ROOM = \{\s*marginRight: 'var\(--chat-dock-width\)',/);
    expect(lay).toContain('<div className="page-body" style={DOCK_ROOM}>');
    expect(lay).toMatch(/<div style=\{\{ \.\.\.DOCK_ROOM, flexShrink: 0 \}\}>\s*<XeroConnectionBanner/);
    expect(lay).toMatch(/<Header \/>/);
    expect(lay).not.toMatch(/<Header [^/]*DOCK_ROOM/);
    expect(lay).toContain('<ChatAssistant onDockChange={setChatDock} />');
  });

  test('the panel: under the header on the web, its width from chatMode, a shadow only when floating', () => {
    expect(panel).toContain("role={shape.mode === 'docked' ? 'complementary' : 'dialog'}");
    expect(panel).toContain("top: shape.mode === 'fullscreen' ? 0 : 'var(--header-height)',");
    expect(panel).toContain('width: shape.width,');
    expect(panel).toContain("boxShadow: shape.mode === 'docked' ? 'none' : '-12px 0 40px rgba(0,0,0,0.25)',");
  });

  test('it sits under the admin\'s account window and every dialog, over the header, sidebar and phone nav', () => {
    const z = Number(/zIndex: (\d+),\s*\}\}>/.exec(panel)[1]);
    expect(z).toBe(201);
    expect(z).toBeLessThan(300);   // UserDetailPanel's backdrop
    expect(read('pages/admin/UserDetailPanel.jsx')).toMatch(/zIndex: 300,/);
    expect(read('components/Modal.jsx')).toMatch(/zIndex = 1000/);
    expect(z).toBeGreaterThan(100); // the sidebar
    expect(read('components/layout/Header.jsx')).toMatch(/zIndex: 50,/);
  });

  test('docked, working on the page leaves it open; only an Escape inside it closes it', () => {
    const effect = chat.slice(chat.indexOf('function handleKeyDown(e) {'), chat.indexOf('}, [open, docked]);'));
    expect(effect).toMatch(/if \(docked && !panelRef\.current\?\.contains\(document\.activeElement\)\) return;\s*setOpen\(false\);/);
    expect(effect).toMatch(/function handleClickOutside\(e\) \{\s*if \(docked\) return;/);
  });

  test('⤢ in the header, docked only, switches 440 and 720 and is remembered (storage may be refused)', () => {
    expect(panel).toMatch(/\{shape\.mode === 'docked' && \(\s*<button type="button" onClick=\{toggleExpanded\} aria-pressed=\{expanded\}/);
    expect(panel).toContain('⤢</button>');
    expect(panel.indexOf('⤢</button>')).toBeLessThan(panel.indexOf('aria-label="Close the assistant"'));
    expect(chat).toContain("try { return localStorage.getItem(EXPANDED_KEY) === '1'; } catch (_) { return false; }");
    expect(chat).toContain("try { localStorage.setItem(EXPANDED_KEY, on ? '1' : '0'); } catch (_)");
    expect(chat).toContain('const [expanded, setExpanded] = useState(readExpanded);');
    expect(chat).toMatch(/function toggleExpanded\(\) \{\s*const next = !expanded;\s*setExpanded\(next\);\s*saveExpanded\(next\);/);
  });

  test('the launcher still hides while the chat is open', () => {
    const launcher = chat.slice(chat.indexOf('aria-label="Open the invoice assistant"'), chat.indexOf('💬'));
    expect(launcher).toContain("opacity: open ? 0 : 1,");
    expect(launcher).toContain("pointerEvents: open ? 'none' : 'auto',");
  });
});
