const fs   = require('fs');
const path = require('path');

// The Overview's and the Analysis tab's wording where a figure is missing,
// nil or unmeasured. There is no React test setup in this project, so this
// follows dashboard-figures-ui.test.js: the decisions are plain functions in
// the panels, lifted out of the source and run here, and the rest is read.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

// The source of `export function NAME(...) { ... }`, by matching braces from
// its first one. Good for the plain functions it is used on, whose parameter
// lists hold no braces.
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
// Evaluates a lifted function, handing it whatever it calls by name.
function lift(rel, name, deps = {}) {
  const body = `${functionSource(read(rel), name)}\nreturn ${name};`;
  return new Function(...Object.keys(deps), body)(...Object.values(deps));
}

const O = 'components/performance/OverviewPanel.jsx';
const A = 'components/performance/AnalysisPanel.jsx';
const nothingBooked    = lift(O, 'nothingBooked');
const hasAnyBudget     = lift(O, 'hasAnyBudget');
const noAttainmentText = lift(O, 'noAttainmentText', { hasAnyBudget });
const growthNote       = lift(O, 'growthNote');
const statusTone       = lift(A, 'statusTone');
const reasonsFooter    = lift(A, 'reasonsFooter');
const checklistState   = lift(A, 'checklistState');

const zeros = () => Array(12).fill(0);
const at = (i, v) => zeros().map((_, k) => (k === i ? v : 0));

// "Needs two closed months" was said with two closed months on screen, when
// the earlier one simply had no revenue to grow from.
describe('the revenue growth note', () => {
  test('no revenue in the previous closed month is said as such', () => {
    expect(growthNote({ available: true, closedMonths: 2, mom: null, latestLabel: 'Aug 2026', momLabel: 'Jul 2026' }))
      .toBe('No revenue in Jul 2026 to compare with');
    expect(growthNote({ available: true, closedMonths: 1, mom: null, momLabel: null })).toBe('Needs two closed months');
    expect(growthNote({ available: false })).toBe('No closed month in range');
    expect(growthNote({ available: true, mom: 0.1, latestLabel: 'Aug 2026', momLabel: 'Jul 2026' })).toBe('Aug 2026 vs Jul 2026');
  });
});

// The Total revenue tile said "No budget set" over a period with a budget,
// whenever nothing had been budgeted for the months already closed.
describe('the revenue tile without an attainment', () => {
  test('"No budget set" only when there is no budget at all', () => {
    const d = budget => ({ totals: { revenue: { budget }, cogs: { budget: zeros() } }, serviceLines: [], expenseLines: [] });
    expect(noAttainmentText(3, d(zeros()))).toBe('No budget set');
    expect(noAttainmentText(3, d(at(8, 5000)))).toBe('Nothing budgeted for the closed months');
    expect(noAttainmentText(0, d(at(8, 5000)))).toBe('No closed month yet');
    const overview = read(O);
    expect(overview).toMatch(/: noAttainmentText\(T\.closedMonths, data\)\}/);
    expect(overview).not.toMatch(/'No budget set'\}/);
  });
});

// An account with nothing booked read "SGD 0.00" in the bars and "—" in the
// snapshot beside them; a real 0 must still read as one.
describe('"nothing booked" only where nothing was', () => {
  test('nil needs every month of every part empty, budget included, over the range', () => {
    expect(nothingBooked([{ actual: zeros(), budget: zeros() }], 0, 11)).toBe(true);
    expect(nothingBooked([{ actual: at(5, 100), budget: zeros() }], 0, 3)).toBe(true);   // outside the range
    expect(nothingBooked([{ actual: zeros(), budget: at(2, 900) }], 0, 3)).toBe(false);  // budgeted, booked nothing: a real 0
    // A net profit of 0 from real trading is not nil: its parts were booked.
    const revenue = { actual: at(1, 500), budget: zeros() }, costs = { actual: at(1, 500), budget: zeros() };
    expect(nothingBooked([revenue, costs, { actual: zeros(), budget: zeros() }], 0, 11)).toBe(false);
  });

  test('the snapshot, the margin bridge and the service-line bars all say it the same way', () => {
    const overview = read(O);
    expect(overview).toMatch(/<BookedRows currency=\{cur\} items=\{\[/);
    expect(overview).toMatch(/<BookedBars items=\{serviceItems\}/);
    expect(overview).toMatch(/<BookedBars currency=\{cur\} items=\{\[/);
    expect(overview).not.toMatch(/<BarList/);
    for (const k of ['revenue', 'cogs', 'opex', 'netProfit']) expect(overview).toMatch(new RegExp(`nil: nil\\.${k} \\}`));
    expect(overview).toMatch(/nil: nothingBooked\(\[l\], from, to\)/);
    expect(overview).toMatch(/nothing booked<\/span>/);
  });
});

describe('the Analysis tab says when the AI or the figures are not there', () => {
  test('the footer says the AI is unavailable when the reasons are the computed ones', () => {
    expect(reasonsFooter({ failed: 'unavailable', source: 'figures' })).toBe('AI unavailable — the reasons shown are computed from Xero.');
    expect(reasonsFooter({ source: 'gemini' })).toMatch(/AI-suggested/);
    expect(reasonsFooter(null)).toBe('Figures are computed from Xero.');
  });

  test('an unmeasured card gets neither the favourable nor the unfavourable colour', () => {
    expect(statusTone('unavailable').color).toBe('var(--text-muted)');
    expect(statusTone('favorable').color).toMatch(/success/);
    expect(statusTone('unfavorable').color).toMatch(/danger/);
  });

  test('the checklist is loading, failed, empty or ready, never a blank card', () => {
    expect(checklistState(null)).toBe('loading');
    expect(checklistState(null, { error: true })).toBe('failed');
    expect(checklistState({ categories: [{ key: 'revenue' }] }, { loading: true })).toBe('loading');
    expect(checklistState({ categories: [], failed: 'unavailable' })).toBe('failed');
    expect(checklistState({ categories: [], generated: false })).toBe('empty');
    expect(checklistState({ categories: [{ key: 'revenue' }], failed: 'unparsed' })).toBe('ready');
    const analysis = read(A);
    expect(analysis).toMatch(/<Empty>Loading…<\/Empty>/);
    expect(analysis).toMatch(/Couldn&apos;t produce the checklist —/);
    expect(analysis).toMatch(/onRetry=\{onReanalyse\}/);
  });

  test('"Analysis up to date" only over insights the model wrote', () => {
    const analysis = read(A);
    expect(analysis).toMatch(/const upToDate = !!stamp && !!insights && !insights\.failed;/);
    expect(analysis).toMatch(/\{upToDate && \(/);
    expect(analysis).not.toMatch(/\{stamp && \(/);
  });
});
