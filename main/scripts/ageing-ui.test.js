const fs   = require('fs');
const path = require('path');

// The Dashboard's ageing section, on the screen side. There is no React test
// setup in this project, so this follows dashboard-figures-ui.test.js: the
// sorting, the strip and the "days late" wording are self-contained functions
// lifted out of the file and run here, and the wiring is checked in the source.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');
const SECTION = 'pages/xero-insights/AgeingSection.jsx';

function functionSource(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1).replace(/^export /, '');
}
const lift = name => new Function(`${functionSource(read(SECTION), name)}\nreturn ${name};`)();

describe('the contact table sorts by total or by over 90 days', () => {
  const sortAgeingContacts = lift('sortAgeingContacts');
  const c = (name, total, d90plus) => ({ name, total, buckets: { d90plus } });
  const contacts = [c('Beta', 500, 0), c('Alpha', 300, 250), c('Gamma', 300, 0), c('Delta', -40, 0)];

  test('by total, largest first, ties by name; and the other way round', () => {
    expect(sortAgeingContacts(contacts, 'total', 'desc').map(x => x.name)).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    expect(sortAgeingContacts(contacts, 'total', 'asc').map(x => x.name)).toEqual(['Delta', 'Alpha', 'Gamma', 'Beta']);
  });

  test('by over 90 days, most first', () => {
    expect(sortAgeingContacts(contacts, 'd90plus', 'desc')[0].name).toBe('Alpha');
  });

  test('never sorts the list it was given in place, and copes with none', () => {
    const before = contacts.map(x => x.name);
    sortAgeingContacts(contacts, 'total', 'asc');
    expect(contacts.map(x => x.name)).toEqual(before);
    expect(sortAgeingContacts(undefined, 'total', 'desc')).toEqual([]);
  });
});

describe('the bucket strip', () => {
  const ageingSegments = lift('ageingSegments');

  test('each bucket is drawn as its share of what is owed', () => {
    const segs = ageingSegments([
      { key: 'current', label: 'Current', amount: 300 },
      { key: 'd1_30', label: '1–30 days', amount: 100 },
      { key: 'd31_60', label: '31–60 days', amount: 0 },
    ]);
    expect(segs.map(s => [s.key, s.share])).toEqual([['current', 0.75], ['d1_30', 0.25]]);
  });

  test('a bucket a credit note took below nothing has no length, and nothing owed draws nothing', () => {
    expect(ageingSegments([{ key: 'current', amount: -20 }, { key: 'd1_30', amount: 50 }]).map(s => [s.key, s.share]))
      .toEqual([['d1_30', 1]]);
    expect(ageingSegments([])).toEqual([]);
  });
});

describe('how late a row is, in words', () => {
  const ageingDaysText = lift('ageingDaysText');
  test.each([
    [{ kind: 'invoice', daysOverdue: -1 }, 'Due in 1 day'],
    [{ kind: 'invoice', daysOverdue: -12 }, 'Due in 12 days'],
    [{ kind: 'invoice', daysOverdue: 0 }, 'Due today'],
    [{ kind: 'invoice', daysOverdue: 1 }, '1 day late'],
    [{ kind: 'invoice', daysOverdue: 91 }, '91 days late'],
    [{ kind: 'invoice', daysOverdue: null }, '—'],
    [{ kind: 'credit-note', daysOverdue: null }, 'Credit'],
  ])('%j reads "%s"', (row, text) => expect(ageingDaysText(row)).toBe(text));
});

describe('wiring', () => {
  const section = read(SECTION);
  const page = read('pages/XeroInsights.jsx');

  test('the page asks the ageing route for one side, and forces it on Refresh and Retry', () => {
    expect(page).toMatch(/api\.get\(`\/xero-reports\/ageing\?\$\{params\.toString\(\)\}`\)/);
    expect(page).toMatch(/new URLSearchParams\(\{ side \}\)/);
    expect(page).toMatch(/fetchAgeing\(ageingSide, \{ force: true \}\)/);
  });

  test('the two headline cards open it, each on its own side', () => {
    expect(page).toMatch(/setAgeingSide\(ageingSide === 'receivables' \? null : 'receivables'\)/);
    expect(page).toMatch(/setAgeingSide\(ageingSide === 'payables' \? null : 'payables'\)/);
  });

  test('a switch of organisation drops both sides', () => {
    expect(page).toMatch(/setAgeing\(\{ receivables: AGEING_IDLE, payables: AGEING_IDLE \}\)/);
  });

  test('it has an empty state, an error state with a retry, and a side switch', () => {
    expect(section).toMatch(/Nothing outstanding/);
    expect(section).toMatch(/<RetryAlert/);
    expect(section).toMatch(/aria-pressed=\{side === s\}/);
    expect(section).toMatch(/aria-expanded=\{open\}/);
    expect(section).toMatch(/aria-sort=/);
  });
});
