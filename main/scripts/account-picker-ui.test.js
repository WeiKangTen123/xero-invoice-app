// The account picker's open list (ui/src/components/AccountCodeSelect.jsx).
// Inside its Setup card the list was drawn under every card after it: each
// card keeps the transform its fadeUp animation ends on, which makes it a
// layer of its own, so the Mileage account list showed its search box and
// then disappeared behind Preferences. It is now drawn at the top of the page
// and placed from the field (ui/src/components/popover-place.js). The page
// cannot be rendered on this machine, so the placement is run here as a plain
// module and the wiring is read from the source.
const fs   = require('fs');
const path = require('path');

const UI = path.join(__dirname, '..', '..', 'ui', 'src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load() {
  const src = read('components/popover-place.js');
  if (/^import /m.test(src)) throw new Error('popover-place.js now imports something; this harness runs it standalone');
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const p = load();

// A field 44px tall, 300px wide, 120px from the left, its top at `top`.
const field = top => ({ top, bottom: top + 44, left: 120, width: 300 });

describe('where the list opens', () => {
  test('below the field when the whole list fits there', () => {
    const at = p.placePopover(field(100), 900);
    expect(at).toEqual({ up: false, left: 120, width: 300, top: 149, bottom: null, maxHeight: p.MAX_HEIGHT });
  });

  test('above the field near the bottom of the window, its bottom edge on the field\'s top', () => {
    const at = p.placePopover(field(700), 900);
    expect(at.up).toBe(true);
    expect(at.top).toBeNull();
    expect(at.bottom).toBe(900 - 700 + p.GAP);
    expect(at.maxHeight).toBe(p.MAX_HEIGHT);
  });

  test('on the side with more room when it fits on neither, never taller than that room', () => {
    // 200px below the field, 400px above it.
    const up = p.placePopover(field(400), 700);
    expect(up.up).toBe(true);
    expect(up.maxHeight).toBe(Math.min(p.MAX_HEIGHT, 400 - p.GAP - p.EDGE));
    // 276px below, 200px above: stays below, cut to the room there.
    const down = p.placePopover(field(200), 520);
    expect(down.up).toBe(false);
    expect(down.maxHeight).toBe(520 - 244 - p.GAP - p.EDGE);
  });

  test('never shorter than is worth opening, even in a tiny window', () => {
    expect(p.placePopover(field(60), 200).maxHeight).toBe(p.MIN_HEIGHT);
  });

  test('the field leaving the window closes the list', () => {
    expect(p.fieldOffScreen(field(100), 900)).toBe(false);
    expect(p.fieldOffScreen(field(-60), 900)).toBe(true);   // scrolled up and away
    expect(p.fieldOffScreen(field(905), 900)).toBe(true);   // scrolled down and away
    expect(p.fieldOffScreen(field(-30), 900)).toBe(false);  // half visible still counts
  });
});

describe('the picker draws its list at the top of the page', () => {
  const src = read('components/AccountCodeSelect.jsx');

  test('through a portal into <body>, fixed where popover-place says', () => {
    expect(src).toMatch(/import \{ createPortal \} from 'react-dom'/);
    expect(src).toMatch(/import \{ placePopover, fieldOffScreen \} from '\.\/popover-place'/);
    expect(src).toMatch(/document\.body,\s*\)/);
    expect(src).toMatch(/position: 'fixed', left: place\.left, width: place\.width/);
    expect(src).toMatch(/maxHeight: place\.maxHeight/);
    // Not the old in-card list.
    expect(src).not.toMatch(/position: 'absolute', top: 'calc\(100% \+ 5px\)'/);
  });

  test('above a Modal (1000) and below a confirm dialog (1100)', () => {
    const z = Number(src.match(/position: 'fixed', left: place\.left, width: place\.width, zIndex: (\d+)/)[1]);
    expect(z).toBeGreaterThan(1000);
    expect(z).toBeLessThan(1100);
    expect(read('components/Modal.jsx')).toMatch(/zIndex = 1000/);
    expect(read('components/ConfirmDialog.jsx')).toMatch(/zIndex=\{1100\}/);
  });

  test('a click in the list is not a click outside the picker', () => {
    expect(src).toMatch(/listRef\.current && listRef\.current\.contains\(t\)/);
    expect(src).toMatch(/<div ref=\{listRef\}/);
  });

  test('it follows the field on any scroll and on resize, and lets go of both when closed', () => {
    expect(src).toMatch(/window\.addEventListener\('scroll', measure, true\)/);
    expect(src).toMatch(/window\.addEventListener\('resize', measure\)/);
    expect(src).toMatch(/window\.removeEventListener\('scroll', measure, true\)/);
    expect(src).toMatch(/window\.removeEventListener\('resize', measure\)/);
  });
});
