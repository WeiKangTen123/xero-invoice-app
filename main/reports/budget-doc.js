// Document definitions for the two budget exports.
//
// Everything here is plain data — a pdfmake docDefinition is just an object —
// so the structure that actually matters (which rows, which columns, where the
// actual/budget seam falls, how a negative reads) is unit-testable without
// rendering a single byte. Rendering lives in budget-render.js.
//
// These read the SAME payload the screen renders, straight from
// reports.getBudgetVariance. Deriving the export from the same rows is the only
// way a printed figure and an on-screen figure can be relied on to agree; a
// second query shaped slightly differently is how a report and its export start
// telling different stories. The wording and formatting rules below mirror the
// screen's (ui/src/utils/format.js, ui/src/pages/xero-insights/bits.jsx) for
// the same reason.

const ACCENT   = '#6366f1';
const MUTED    = '#6b7280';
const RULE     = '#d8d8e4';
const NEGATIVE = '#b42318';
const POSITIVE = '#0f9d76';
// The month in progress, in the screen's amber: a figure still moving, kept
// visibly apart from the closed actuals on one side and the budget on the other.
const AMBER      = '#b45309';
const AMBER_TINT = '#fdf3dc';
// A tint light enough to survive a monochrome printer without turning into a
// grey block, but visible enough to follow one account across fourteen columns
// — which is the hardest thing to do in the landscape report.
const BAND     = '#f5f5fa';

// Said outright when Xero has no Overall Budget for the period: every budget
// figure would otherwise read "-", the same as a line budgeted at nil, and every
// variance would equal its actual with nothing on the page saying why. Same
// sentence as the screen.
const BUDGET_MISSING = 'Xero returned no Overall Budget for this period, so budget figures are blank.';

// An account Xero has actuals for but no budget line at all. Its budget prints
// "-" exactly like a line budgeted at nil, so the label says which one it is.
const NOT_BUDGETED = ' (not budgeted)';

// True for an amount that prints as 0.00. A sum of floats can land a hair off
// zero, and that should read as nil rather than as "0.00" or "(0.00)". The same
// test the screen applies, so a cell is a dash in both or in neither.
function isNil(n) {
  return Math.round(Number(n || 0) * 100) === 0;
}

// Mirrors fmtCell in the UI: a dash for zero (matching Xero's own reports, where
// nothing and nil look the same), parentheses for negatives.
function cell(v) {
  const n = Number(v || 0);
  if (isNil(n)) return '-';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${abs})` : abs;
}

function money(n, currency) {
  const v = Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${v}` : v;
}

// Xero's Budget Variance percentage, as the screen prints it: two decimals and
// no plus sign (195.20%, -11.46%). It used to be one decimal and signed, so
// most percentages in an export differed from the report they came from. Takes
// the FRACTION the server sends; no percentage at all — a nil budget has
// nothing to divide by — is a dash.
function pct(fraction) {
  if (fraction === null || fraction === undefined || !Number.isFinite(Number(fraction))) return '-';
  const s = (Number(fraction) * 100).toFixed(2);
  return `${s === '-0.00' ? '0.00' : s}%`;
}

// The Variance % cell. An on-budget line prints a dash rather than 0.00%,
// matched against Xero's own report, where it shows "-" in both columns.
function pctCell(v) {
  return isNil(v?.variance) ? '-' : pct(v?.variancePct);
}

// Which rows are costs. The server says so; a payload from before it did is
// read from the section title, which in Xero's standard layout starts "Less"
// for costs — the same fallback the screen uses, so the two colour alike.
function isExpense(row) {
  if (typeof row?.expense === 'boolean') return row.expense;
  return /^less\b|cost of sales|expense|overhead/i.test(row?.section || '');
}

// Green is favourable and red unfavourable, as in Xero and on screen: income or
// profit above budget is good, a cost above budget is bad. The figure keeps its
// sign either way (actual minus budget), so a cost under budget reads negative
// and green. Colouring by sign alone painted every overspend green. Null for a
// nil variance, which has no colour.
function favourable(row, variance) {
  if (isNil(variance)) return null;
  return isExpense(row) ? variance < 0 : variance > 0;
}

function toneOf(row, variance) {
  const good = favourable(row, variance);
  return good === null ? undefined : good ? POSITIVE : NEGATIVE;
}

// A moment in the reader's own timezone, with the zone named. The server runs
// in UTC while the "as of" dates are the organisation's local days, so a stamp
// in server time put "Generated 6 Oct, 17:30" on a file whose figures were read
// on 7 Oct. An unknown zone name throws in Intl; UTC, named, is still true.
function stamp(date, timeZone) {
  const format = tz => new Date(date).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: tz, timeZoneName: 'short',
  });
  try {
    return format(timeZone || undefined);
  } catch (_) {
    return format('UTC');
  }
}

// When the figures were read from Xero. An export re-reads the report, and the
// cache it reads from lasts minutes, not forever, so a file can hold figures
// newer than the screen it was exported from. Saying when they were read is
// what lets the two be told apart afterwards.
function fetchedNote(payload, timeZone) {
  const at = payload?.fetchedAt;
  if (at === null || at === undefined || Number.isNaN(new Date(at).getTime())) return '';
  return `Figures read from Xero at ${stamp(at, timeZone)}`;
}

// The currency line is not decoration. Xero's reports come back in the
// organisation's base currency while its documents do not, and an exported
// figure outlives the screen that explains it — a PDF gets emailed, filed and
// read months later by someone who never saw the dashboard.
function currencyNote(currency, foreign) {
  const base = currency
    ? `Figures in ${currency}, the organisation's base currency.`
    : `Figures in the organisation's base currency.`;
  if (!foreign || !foreign.mixed) return base;
  const list = (foreign.currencies || []).join(', ');
  const tail = foreign.unconvertible > 0
    ? ` ${foreign.unconvertible} document(s) carried no exchange rate and are counted at face value.`
    : '';
  return `${base} Includes ${list} converted at the rate Xero stamped on each document.${tail}`;
}

// The standard PDF fonts are drawn through WinAnsiEncoding (Windows-1252): all
// of Latin-1 plus the 27 characters pdfkit maps into 0x80-0x9F, among them the
// curly quotes, dashes, ellipsis and euro sign that account names really use.
// Only what lies outside that set is folded; this once folded “Office” and €
// too, which the font draws perfectly well. The C1 controls (U+0080-U+009F) are
// folded as well, since pdfkit would print them as whatever WinAnsi keeps at
// those bytes. The .xlsx export carries the real characters.
const WIN_ANSI_EXTRA = [
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc,
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021,
  0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
].map(c => String.fromCharCode(c)).join('');
const NOT_WIN_ANSI = new RegExp(`[^\\t\\n\\r\\x20-\\x7e\\xa0-\\xff${WIN_ANSI_EXTRA}]`, 'gu');

function latin1(v) {
  const str = v === null || v === undefined ? '' : String(v);
  return str.replace(NOT_WIN_ANSI, '?');
}

// A row's label as the PDF can print it. Two accounts named only in Japanese
// would both fold to "????", so a label that lost characters also carries its
// line number in the report, which keeps them apart and points the reader to
// the same line in the workbook.
function pdfLabel(row, line) {
  const raw    = row?.label === null || row?.label === undefined ? '' : String(row.label);
  const folded = latin1(raw);
  const mark   = folded === raw ? '' : ` [#${line}]`;
  return `${folded}${mark}${row?.unbudgeted ? NOT_BUDGETED : ''}`;
}

const FOLDED_NOTE = 'A "?" stands for a character the PDF\'s built-in font cannot draw, and [#n] is that '
  + 'line\'s position in the report, so names that fold alike stay distinct. The Excel export carries '
  + 'every name as written in Xero.';

function hasFolded(rows) {
  return rows.some(r => latin1(r.label) !== String(r.label ?? ''));
}

function pageHeader(orgName, title, subtitle, { generatedAt, timezone, fetched }) {
  return {
    margin: [28, 16, 28, 0],
    columns: [
      {
        width: '*',
        stack: [
          { text: latin1(orgName || 'Organisation'), style: 'org' },
          { text: latin1(subtitle), style: 'sub' },
        ],
      },
      {
        width: 'auto',
        stack: [
          { text: title, style: 'title', alignment: 'right' },
          { text: `Generated ${stamp(generatedAt, timezone)}`, style: 'sub', alignment: 'right' },
          ...(fetched ? [{ text: latin1(fetched), style: 'sub', alignment: 'right' }] : []),
        ],
      },
    ],
  };
}

function pageFooter(note) {
  return (currentPage, pageCount) => ({
    margin: [28, 6, 28, 0],
    columns: [
      { width: '*', text: note, style: 'foot' },
      { width: 'auto', text: `Page ${currentPage} of ${pageCount}`, style: 'foot', alignment: 'right' },
    ],
  });
}

const STYLES = {
  // The report title leads; the organisation is context beneath it. Both at
  // 12pt bold made them compete for the same job.
  org:      { fontSize: 10.5, bold: true },
  title:    { fontSize: 14, bold: true },
  sub:      { fontSize: 7.5, color: MUTED },
  foot:     { fontSize: 6.5, color: MUTED },
  band:     { fontSize: 6.5, bold: true, characterSpacing: 0.6 },
  group:    { fontSize: 7, bold: true, color: ACCENT },
  colHead:  { fontSize: 6.5, bold: true, color: MUTED },
  section:  { fontSize: 7.5, bold: true },
  account:  { fontSize: 7 },
  strong:   { fontSize: 7, bold: true },
  note:     { fontSize: 7.5, color: MUTED },
  aside:    { fontSize: 6.5, color: MUTED },
  warn:     { fontSize: 8, bold: true, color: AMBER },
};

// '2026-10-06' -> '6 Oct 2026'. Read from the string, not through Date, so no
// timezone can move it a day.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}` : '';
}

// The period's first and last month, which is what tells this year's file from
// last year's when nothing else does.
function periodSpan(payload) {
  const months = payload?.months || [];
  if (!months.length) return '';
  const first = months[0].label, last = months[months.length - 1].label;
  return first === last ? first : `${first} – ${last}`;
}

// Which months the report covers, in words: the title the server gave the
// period, or failing that its first and last month.
function periodText(payload) {
  return payload?.fiscalYear?.label || periodSpan(payload);
}

// The closed months a to-date figure covers: 'Apr 2026 – Sep 2026', just
// 'Apr 2026' for one, or '' while none has closed. The server names them; a
// payload from before it did falls back to the first and last of the elapsed
// months, which are the same two. Mirrors the screen's closedRange.
function closedRange(payload) {
  const n = payload?.kpis?.monthsElapsed ?? 0;
  if (!(n > 0)) return '';
  const months = payload?.months || [];
  const from = payload?.period?.closedFromLabel || months[0]?.label;
  const to   = payload?.period?.closedToLabel   || months[n - 1]?.label;
  if (!from || !to) return '';
  return from === to ? from : `${from} – ${to}`;
}

// "Year to date" or "Period to date" is the server's call, so the screen and
// the exports cannot word it differently; without it the wording stays neutral
// rather than guessing from the period key.
function toDateLabel(payload) {
  return payload?.period?.toDateLabel || 'To date';
}

// A to-date figure's title, naming its months: "Year to date · Apr 2026 –
// Sep 2026 (6 completed months)". It used to say "Year to date · Financial year
// to date · Apr 2026 – Oct 2026" over figures that stop at September, because
// the month in progress is never in a to-date total.
function toDateText(payload) {
  const label = toDateLabel(payload);
  const range = closedRange(payload);
  if (!range) return `${label} · no completed months yet`;
  const n = payload.kpis.monthsElapsed;
  return `${label} · ${range} (${n} completed month${n === 1 ? '' : 's'})`;
}

// The month still in progress, which the grid shows as budget because it has
// not closed. The screen reports what has been booked against it beside the
// grid; an export without it was missing a figure the reader had just seen.
// Stated as outside the totals, because it is.
function soFarNote(payload) {
  const cur = payload?.kpis?.currentMonth;
  if (!cur) return '';
  const asOf = cur.asOf ? `, as of ${dayLabel(cur.asOf)}` : '';
  return `${cur.label} so far${asOf}: net profit ${money(cur.actualNet)} booked against ${money(cur.budgetNet)} budgeted. `
    + 'Not included in the figures above.';
}

// The month in progress, when the grid has one, by the screen's rule: the
// month straight after the closed ones. A period without one gets no "so far"
// column. -1 when there is none.
function currentColumn(months) {
  const firstBudgetIdx = months.findIndex(m => m.source === 'budget');
  const actualCount    = firstBudgetIdx === -1 ? months.length : firstBudgetIdx;
  const curIdx         = months.findIndex(m => m.current);
  return curIdx >= 0 && curIdx === actualCount ? curIdx : -1;
}

const blanks = n => Array.from({ length: n }, () => ({ text: '' }));

// Helvetica's advance widths, in ems, for what a figure is made of. Anything
// else is taken as wide as an "M", so an estimate errs towards a wider page.
const GLYPH_EM = { ',': 0.278, '.': 0.278, ' ': 0.278, '(': 0.333, ')': 0.333, '-': 0.333, '%': 0.889 };
const textWidth = (text, size) =>
  [...String(text)].reduce((w, ch) => w + (/\d/.test(ch) ? 0.556 : GLYPH_EM[ch] ?? 0.833), 0) * size;

const A4_LANDSCAPE = { width: 841.89, height: 595.28 };

// A table wider than its page is not wrapped by pdfmake but cut off at the
// right-hand edge, Total first. A long period has more months than A4 is wide
// (a custom range can run to 132), and the "so far" column takes one more, so
// the page widens to fit the table instead: A4's height, every figure at the
// same size, and a viewer's or printer's fit-to-page to scale it. Columns are
// sized from their widest figure, as pdfmake sizes them, with the account
// column at the narrowest it wraps to.
function gridPageSize(body, margins, padding) {
  const cols = body[1].length;
  let needed = margins + 80 + padding;
  for (let c = 1; c < cols; c++) {
    let widest = 0;
    for (const r of body) {
      if (r[c] && r[c].text && !r[c].colSpan) widest = Math.max(widest, textWidth(r[c].text, 7));
    }
    needed += widest + padding;
  }
  return needed <= A4_LANDSCAPE.width ? 'A4' : { width: Math.ceil(needed), height: A4_LANDSCAPE.height };
}

// ── Budget vs Actual ────────────────────────────────────────────────────────
// Landscape, because the grid is one column per month plus a total and there is
// no honest way to fit twelve of those on a portrait page.
function budgetVsActualDoc(payload, opts = {}) {
  const { months = [], rows = [], organisation = {}, fiscalYear = {} } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt ?? Date.now();
  const soFar     = soFarNote(payload);

  const firstBudgetIdx = months.findIndex(m => m.source === 'budget');
  const actualCount    = firstBudgetIdx === -1 ? months.length : firstBudgetIdx;
  // The month in progress keeps its budget column and gets a second one before
  // it, as on screen: what has been booked against it so far, in amber and
  // never added into Total, which stays closed actuals plus budget — a few
  // days of figures counted as a whole month would understate the year.
  const curIdx   = currentColumn(months);
  const hasCur   = curIdx >= 0;
  const curShort = hasCur ? String(months[curIdx].label).split(' ')[0] : '';
  // Column 0 is the account label, so a month at index i is table column i + 1.
  // A "so far" column takes the place of the first budget month and pushes the
  // rest along, so the seam — one rule, after the closed actuals — is at the
  // same column either way.
  const seamColumn  = firstBudgetIdx === -1 ? -1 : firstBudgetIdx + 1;
  const width       = months.length + 2 + (hasCur ? 1 : 0);
  // The line before Total is at its index.
  const totalColumn = width - 1;

  const band = [{ text: currency ? `Figures in ${currency}` : '', style: 'colHead', border: [false, false, false, false] }];
  if (actualCount > 0) {
    band.push({ text: 'ACTUAL', style: 'band', color: POSITIVE, colSpan: actualCount, alignment: 'center' });
    for (let i = 1; i < actualCount; i++) band.push({});
  }
  if (hasCur) band.push({ text: 'SO FAR', style: 'band', color: AMBER, alignment: 'center', fillColor: AMBER_TINT });
  if (actualCount < months.length) {
    const n = months.length - actualCount;
    band.push({ text: 'OVERALL BUDGET', style: 'band', color: ACCENT, colSpan: n, alignment: 'center' });
    for (let i = 1; i < n; i++) band.push({});
  }
  band.push({ text: '' });

  const head = [{ text: 'Account', style: 'colHead' }];
  months.forEach((m, i) => {
    if (i === curIdx) head.push({ text: `${latin1(curShort)} so far`, style: 'colHead', color: AMBER, alignment: 'right', fillColor: AMBER_TINT });
    head.push({ text: latin1(m.label), style: 'colHead', alignment: 'right' });
  });
  head.push({ text: 'Total', style: 'colHead', alignment: 'right' });

  const body = [band, head];
  // Banding and rules need to know what each row is, and the only place that is
  // known is here, while it is being built. Collected rather than re-derived in
  // the layout callbacks, which only receive an index.
  const summaryRows = new Set();
  const bandedRows  = new Set();
  let banded = false;
  const red = v => (!isNil(v) && Number(v) < 0 ? NEGATIVE : undefined);

  rows.forEach((r, line) => {
    if (r.kind === 'section') {
      banded = false;          // each section restarts the stripe
      // Deliberately not colSpan: see the note above the layout.
      body.push([
        { text: pdfLabel(r, line + 1), style: 'section', margin: [0, 7, 0, 2] },
        ...blanks(width - 1),
      ]);
      return;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
    if (r.kind === 'summary') summaryRows.add(body.length);
    banded = !banded;
    if (banded) bandedRows.add(body.length);
    const style = strong ? 'strong' : 'account';
    const cells = [{ text: pdfLabel(r, line + 1), style, margin: [r.kind === 'account' ? 8 : 0, 0, 0, 0] }];
    (r.cells || []).forEach((v, i) => {
      if (i === curIdx) {
        const booked = r.monthly?.[curIdx]?.actual ?? 0;
        cells.push({ text: cell(booked), style, alignment: 'right', color: red(booked), fillColor: AMBER_TINT });
      }
      cells.push({ text: cell(v), style, alignment: 'right', color: red(v) });
    });
    cells.push({ text: cell(r.total), style: 'strong', alignment: 'right', color: red(r.total) });
    body.push(cells);
  });

  const notes = [];
  if (soFar) notes.push({ text: latin1(soFar), style: 'note', margin: [0, 8, 0, 0] });
  if (hasFolded(rows)) notes.push({ text: FOLDED_NOTE, style: 'aside', margin: [0, 6, 0, 0] });

  return {
    pageSize: gridPageSize(body, 28 + 28, 4 + 4),
    pageOrientation: 'landscape',
    pageMargins: [28, 60, 28, 30],
    defaultStyle: { font: 'Helvetica', fontSize: 7 },
    header: pageHeader(
      organisation.name,
      'Budget vs Actual',
      [fiscalYear.label || 'Current financial year', currency].filter(Boolean).join(' · '),
      { generatedAt: generated, timezone: opts.timezone, fetched: fetchedNote(payload, opts.timezone) },
    ),
    footer: pageFooter(currencyNote(currency, payload?.currency)),
    styles: STYLES,
    content: [
      ...(payload?.budgetMissing ? [{ text: BUDGET_MISSING, style: 'warn', margin: [0, 0, 0, 6] }] : []),
      {
        table: {
          headerRows: 2,
          dontBreakRows: true,
          widths: ['auto', ...new Array(width - 2).fill('*'), 'auto'],
          body,
        },
        layout: {
          // Section headings deliberately avoid colSpan, because a spanned cell
          // has no internal column boundaries and these two rules would break at
          // every heading and resume below it.
          //
          // The seam after the last actual month — Xero's own PDF signals this
          // only in the column headers, which is easy to miss — and a rule
          // before Total, which is the most-read column and otherwise runs
          // straight on from the last budget month.
          vLineWidth: i => (i === seamColumn ? 1.2 : i === totalColumn ? 0.7 : 0),
          vLineColor: i => (i === seamColumn ? ACCENT : RULE),
          // Under the header, and above each summary line so the figure the report
          // exists to deliver is not just another bold row.
          hLineWidth: i => (i === 2 || summaryRows.has(i) ? 0.7 : 0),
          hLineColor: () => RULE,
          fillColor: i => (bandedRows.has(i) ? BAND : null),
          paddingLeft:   () => 4,
          paddingRight:  () => 4,
          paddingTop:    () => 2.5,
          paddingBottom: () => 2.5,
        },
      },
      ...notes,
    ],
  };
}

// ── Budget Variance ─────────────────────────────────────────────────────────
// Portrait for the to-date rollup: five columns fit comfortably, and it is the
// report someone is more likely to read on a phone. A month comes with its
// running total beside it — nine columns — which needs the landscape page.

// The variance month an export reports, decided once and then used for its
// figures, its title and its filename alike. A key that is not one of the
// report's months — a selection left over from another organisation or
// period — means the to-date rollup. It used to put the first month's figures
// under a filename naming the month asked for, so the file said one thing and
// held another.
function resolveMonth(payload, month) {
  const months = payload?.months || [];
  return month && month !== 'ytd' && months.some(m => m.key === month) ? month : 'ytd';
}

// What the variance figures cover, in words; a month's version titles its
// column group and the subtitle. A month still in progress says so and when it
// was read: titling it "Oct 2026" alone reads as a closed month.
function varianceLabel(payload, month = 'ytd') {
  const k = resolveMonth(payload, month);
  if (k === 'ytd') return toDateLabel(payload);
  const m   = payload.months.find(x => x.key === k);
  const cur = payload?.kpis?.currentMonth;
  if (!cur || cur.key !== m.key) return m.label;
  return `${m.label} so far${cur.asOf ? `, as of ${dayLabel(cur.asOf)}` : ''}`;
}

// The variance export's subtitle, before the currency. A single month names
// itself; the rollup names the closed months it covers. With none closed yet
// the months cannot say which year this is, so the period does.
function varianceSubtitle(payload, month = 'ytd') {
  if (resolveMonth(payload, month) !== 'ytd') return varianceLabel(payload, month);
  const text = toDateText(payload);
  return closedRange(payload) ? text : [text, periodText(payload)].filter(Boolean).join(' · ');
}

// The running-total group beside a month, as Xero's Budget Variance report
// lays it out: from the period's first month through the chosen one. Over a
// year that is the year to date; over a quarter or a custom range "YTD" would
// be wrong, so the months are named instead. Same wording as the screen.
function cumulativeLabel(payload, idx) {
  const months = payload.months;
  const m      = months[idx];
  const tail   = m.current ? ' so far' : '';
  if (toDateLabel(payload) === 'Year to date') return `YTD to ${m.label}${tail}`;
  // Matches the screen: the period's first month alone is not a range.
  return months[0].key === m.key ? `${m.label}${tail}` : `${months[0].label} – ${m.label}${tail}`;
}

const NIL = { actual: 0, budget: 0, variance: 0, variancePct: null };

// The column groups a variance export shows, each a label and the figures it
// reads from a row: the to-date rollup alone, or a month beside its running
// total. A payload from before the server sent running totals shows the month
// alone rather than a group of blanks, as the screen does. Shared by the PDF
// and the workbook so the two cannot lay the report out differently.
function variancePeriods(payload, month = 'ytd') {
  const k = resolveMonth(payload, month);
  if (k === 'ytd') {
    return [{
      label: toDateText(payload),
      of: r => ({ actual: r.actualToDate, budget: r.budgetToDate, variance: r.variance, variancePct: r.variancePct }),
    }];
  }
  const idx = payload.months.findIndex(m => m.key === k);
  const out = [{ label: varianceLabel(payload, k), of: r => r.monthly?.[idx] }];
  if ((payload.rows || []).some(r => Array.isArray(r.cumulative))) {
    out.push({ label: cumulativeLabel(payload, idx), of: r => r.cumulative?.[idx] });
  }
  return out;
}

// A row's figures for one group. An unbudgeted line has no budget to show, so
// it prints a dash whatever arrives in that field.
function figures(period, row) {
  const v = period.of(row) || NIL;
  return row.unbudgeted ? { ...v, budget: 0 } : v;
}

const VARIANCE_HEADS = ['Actual', 'Budget', 'Variance', 'Variance %'];

function budgetVarianceDoc(payload, opts = {}) {
  const { rows = [], organisation = {} } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt ?? Date.now();
  const month     = resolveMonth(payload, opts.month);
  const periods   = variancePeriods(payload, month);
  const label     = varianceSubtitle(payload, month);
  const width     = 1 + periods.length * VARIANCE_HEADS.length;

  // Each group titled over its four columns, so "Actual" under a month and
  // "Actual" under its running total cannot be mistaken for each other.
  const band = [{ text: currency ? `Figures in ${currency}` : '', style: 'colHead' }];
  for (const p of periods) band.push({ text: latin1(p.label), style: 'group', colSpan: 4, alignment: 'center' }, {}, {}, {});
  const head = [{ text: 'Account', style: 'colHead' }];
  for (let g = 0; g < periods.length; g++) {
    for (const h of VARIANCE_HEADS) head.push({ text: h, style: 'colHead', alignment: 'right' });
  }

  const body = [band, head];
  const summaryRows = new Set();
  const bandedRows  = new Set();
  let banded = false;

  rows.forEach((r, line) => {
    if (r.kind === 'section') {
      banded = false;
      body.push([{ text: pdfLabel(r, line + 1), style: 'section', margin: [0, 7, 0, 2] }, ...blanks(width - 1)]);
      return;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
    if (r.kind === 'summary') summaryRows.add(body.length);
    banded = !banded;
    if (banded) bandedRows.add(body.length);
    const style = strong ? 'strong' : 'account';
    const cells = [{ text: pdfLabel(r, line + 1), style, margin: [r.kind === 'account' ? 8 : 0, 0, 0, 0] }];
    for (const p of periods) {
      const v    = figures(p, r);
      const tone = toneOf(r, v.variance);
      cells.push(
        { text: cell(v.actual), style, alignment: 'right' },
        { text: cell(v.budget), style, alignment: 'right', color: MUTED },
        { text: cell(v.variance), style: 'strong', alignment: 'right', color: tone },
        { text: pctCell(v), style, alignment: 'right', color: tone },
      );
    }
    body.push(cells);
  });

  return {
    pageSize: 'A4',
    pageOrientation: periods.length > 1 ? 'landscape' : 'portrait',
    pageMargins: [32, 60, 32, 30],
    defaultStyle: { font: 'Helvetica', fontSize: 8 },
    header: pageHeader(
      organisation.name,
      'Budget Variance',
      [label, currency].filter(Boolean).join(' · '),
      { generatedAt: generated, timezone: opts.timezone, fetched: fetchedNote(payload, opts.timezone) },
    ),
    footer: pageFooter(currencyNote(currency, payload?.currency)),
    styles: STYLES,
    content: [
      ...(payload?.budgetMissing ? [{ text: BUDGET_MISSING, style: 'warn', margin: [0, 0, 0, 6] }] : []),
      {
        table: {
          headerRows: 2,
          dontBreakRows: true,
          widths: ['*', ...new Array(width - 1).fill('auto')],
          body,
        },
        layout: {
          // A rule where one group's four columns end and the next one's begin.
          vLineWidth: i => (i > 1 && i < width && (i - 1) % 4 === 0 ? 0.7 : 0),
          vLineColor: () => RULE,
          hLineWidth: i => (i === 2 || summaryRows.has(i) ? 0.7 : 0),
          hLineColor: () => RULE,
          fillColor: i => (bandedRows.has(i) ? BAND : null),
          paddingLeft:   () => 5,
          paddingRight:  () => 5,
          paddingTop:    () => 3,
          paddingBottom: () => 3,
        },
      },
      ...(hasFolded(rows) ? [{ text: FOLDED_NOTE, style: 'aside', margin: [0, 6, 0, 0] }] : []),
    ],
  };
}

// Filenames end up in a Content-Disposition header and on someone's desktop, so
// they carry the organisation and what the figures cover rather than being
// "export.pdf", and stay short and safe in any filesystem. A rollup names the
// closed months it covers — or, with none closed, the period — so this year's
// and last year's do not arrive under one name and overwrite each other. A
// month names the month its running total starts from, since that total
// depends on where the period begins.
function exportFilename(kind, payload, opts = {}) {
  const slug = s => String(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const org  = slug(payload?.organisation?.name || 'organisation').slice(0, 40) || 'organisation';
  const title = kind === 'variance' ? 'Budget-Variance' : 'Budget-vs-Actual';
  let parts;
  if (kind === 'variance') {
    const month = resolveMonth(payload, opts.month);
    if (month === 'ytd') {
      const range = closedRange(payload);
      parts = [slug(toDateLabel(payload).toLowerCase()), range ? slug(range) : `none-closed_${slug(periodSpan(payload) || periodText(payload))}`];
    } else {
      const months  = payload.months;
      const running = variancePeriods(payload, month).length > 1;
      const from    = toDateLabel(payload) === 'Year to date' ? 'ytd-from' : 'to-date-from';
      parts = [slug(months.find(m => m.key === month).label), running ? `${from}-${slug(months[0].label)}` : ''];
    }
  } else {
    parts = [slug(payload?.fiscalYear?.label || 'financial-year')];
  }
  return [title, org, ...parts.filter(Boolean)].join('_');
}

module.exports = {
  budgetVsActualDoc,
  budgetVarianceDoc,
  exportFilename,
  varianceLabel,
  varianceSubtitle,
  variancePeriods,
  cumulativeLabel,
  figures,
  resolveMonth,
  periodText,
  closedRange,
  toDateText,
  soFarNote,
  fetchedNote,
  currentColumn,
  favourable,
  stamp,
  dayLabel,
  BUDGET_MISSING,
  NOT_BUDGETED,
  // exported for tests
  _cell: cell, _money: money, _pct: pct, _pctCell: pctCell, _currencyNote: currencyNote, _latin1: latin1,
  _pdfLabel: pdfLabel, _isNil: isNil,
};
