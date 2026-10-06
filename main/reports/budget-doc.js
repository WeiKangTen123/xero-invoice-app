// Document definitions for the two budget exports.
//
// Everything here is plain data — a pdfmake docDefinition is just an object —
// so the structure that actually matters (which rows, which columns, where the
// actual/budget seam falls, how a negative reads) is unit-testable without
// rendering a single byte. Rendering lives in budget-pdf.js.
//
// These read the SAME payload the screen renders, straight from
// reports.getBudgetVariance. Deriving the export from the same rows is the only
// way a printed figure and an on-screen figure can be relied on to agree; a
// second query shaped slightly differently is how a report and its export start
// telling different stories.

const ACCENT  = '#6366f1';
const MUTED   = '#6b7280';
const RULE    = '#d8d8e4';
const NEGATIVE = '#b42318';
// A tint light enough to survive a monochrome printer without turning into a
// grey block, but visible enough to follow one account across fourteen columns
// — which is the hardest thing to do in the landscape report.
const BAND     = '#f5f5fa';

// Mirrors fmtCell in the UI: a dash for zero (matching Xero's own reports, where
// nothing and nil look the same), parentheses for negatives.
function cell(v) {
  const n = Number(v || 0);
  if (n === 0) return '-';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${abs})` : abs;
}

function money(n, currency) {
  const v = Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${v}` : v;
}

function pct(fraction) {
  if (fraction === null || fraction === undefined) return '–';
  const v = Number(fraction) * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function stamp(date) {
  return new Date(date).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
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

// The standard PDF fonts cover Latin-1 only. Anything outside it is folded
// here, so a chart of accounts written in another script produces a readable
// placeholder rather than a stream that dies after the headers are sent. The
// .xlsx export carries the real characters.
function latin1(v) {
  const str = v === null || v === undefined ? '' : String(v);
  // eslint-disable-next-line no-control-regex
  return str.replace(/[^\u0000-\u00ff\u2013\u2019]/g, '?').replace(/[\u2013]/g, '-').replace(/[\u2019]/g, "'");
}

function pageHeader(orgName, title, subtitle, generatedAt) {
  return {
    margin: [28, 20, 28, 0],
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
          { text: `Generated ${stamp(generatedAt)}`, style: 'sub', alignment: 'right' },
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
  colHead:  { fontSize: 6.5, bold: true, color: MUTED },
  section:  { fontSize: 7.5, bold: true },
  account:  { fontSize: 7 },
  strong:   { fontSize: 7, bold: true },
  note:     { fontSize: 7.5, color: MUTED },
};

// '2026-10-06' -> '6 Oct 2026'. Read from the string, not through Date, so no
// timezone can move it a day.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}` : '';
}

// Which months the report covers, in words: the title the server gave the
// period, or failing that its first and last month. An export has to say this
// itself — "Year to date" alone reads the same for this year and last year.
function periodText(payload) {
  const months = payload?.months || [];
  if (payload?.fiscalYear?.label) return payload.fiscalYear.label;
  if (!months.length) return '';
  const first = months[0].label, last = months[months.length - 1].label;
  return first === last ? first : `${first} – ${last}`;
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

// ── Budget vs Actual ────────────────────────────────────────────────────────
// Landscape, because the grid is one column per month plus a total and there is
// no honest way to fit twelve of those on a portrait page.
function budgetVsActualDoc(payload, opts = {}) {
  const { months = [], rows = [], organisation = {}, fiscalYear = {} } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt || Date.now();
  const soFar     = soFarNote(payload);

  const firstBudgetIdx = months.findIndex(m => m.source === 'budget');
  const actualCount    = firstBudgetIdx === -1 ? months.length : firstBudgetIdx;
  // Column 0 is the account label, so a month at index i is table column i + 1.
  const seamColumn     = firstBudgetIdx === -1 ? -1 : firstBudgetIdx + 1;
  // Account + one per month; the line before it is at that index.
  const totalColumn    = months.length + 1;

  const band = [{ text: '', border: [false, false, false, false] }];
  if (actualCount > 0) {
    band.push({ text: 'ACTUAL', style: 'band', color: '#0f9d76', colSpan: actualCount, alignment: 'center' });
    for (let i = 1; i < actualCount; i++) band.push({});
  }
  if (actualCount < months.length) {
    const n = months.length - actualCount;
    band.push({ text: 'OVERALL BUDGET', style: 'band', color: ACCENT, colSpan: n, alignment: 'center' });
    for (let i = 1; i < n; i++) band.push({});
  }
  band.push({ text: '' });

  const head = [
    { text: 'Account', style: 'colHead' },
    ...months.map(m => ({ text: latin1(m.label), style: 'colHead', alignment: 'right' })),
    { text: 'Total', style: 'colHead', alignment: 'right' },
  ];

  const body = [band, head];
  // Banding and rules need to know what each row is, and the only place that is
  // known is here, while it is being built. Collected rather than re-derived in
  // the layout callbacks, which only receive an index.
  const sectionRows = new Set();
  const bandedRows  = new Set();
  const summaryRows = new Set();
  let banded = false;

  for (const r of rows) {
    if (r.kind === 'section') {
      sectionRows.add(body.length);
      banded = false;          // each section restarts the stripe
      // Deliberately not colSpan: see the note above the layout.
      body.push([
        { text: latin1(r.label), style: 'section', margin: [0, 7, 0, 2] },
        ...new Array(months.length + 1).fill({ text: '' }),
      ]);
      continue;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
    if (r.kind === 'summary') summaryRows.add(body.length);
    banded = !banded;
    if (banded) bandedRows.add(body.length);
    const style  = strong ? 'strong' : 'account';
    body.push([
      { text: latin1(r.label), style, margin: [r.kind === 'account' ? 8 : 0, 0, 0, 0] },
      ...(r.cells || []).map(v => ({
        text: cell(v), style, alignment: 'right', color: Number(v) < 0 ? NEGATIVE : undefined,
      })),
      { text: cell(r.total), style: 'strong', alignment: 'right', color: Number(r.total) < 0 ? NEGATIVE : undefined },
    ]);
  }

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 58, 28, 30],
    defaultStyle: { font: 'Helvetica', fontSize: 7 },
    header: pageHeader(
      organisation.name,
      'Budget vs Actual',
      [fiscalYear.label || 'Current financial year', currency].filter(Boolean).join(' · '),
      generated,
    ),
    footer: pageFooter(currencyNote(currency, payload.currency)),
    styles: STYLES,
    content: [{
      table: {
        headerRows: 2,
        dontBreakRows: true,
        widths: ['auto', ...months.map(() => '*'), 'auto'],
        body,
      },
      layout: {
        // Section headings deliberately avoid colSpan, because a spanned cell
        // has no internal column boundaries and these two rules would break at
        // every heading and resume below it.
        //
        // The seam between the last actual month and the first budget month —
        // Xero's own PDF signals this only in the column headers, which is easy
        // to miss — and a rule before Total, which is the most-read column and
        // otherwise runs straight on from the last budget month.
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
    ...(soFar ? [{ text: latin1(soFar), style: 'note', margin: [0, 8, 0, 0] }] : [])],
  };
}

// ── Budget Variance ─────────────────────────────────────────────────────────
// Portrait: five columns fit comfortably, and it is the report someone is more
// likely to read on a phone.

// Periods that are a year, so their rollup is a "year to date". Anything else
// the reader picked (a quarter, the last six months) is a period to date.
const YEAR_PERIODS = new Set(['fy', 'fy-ytd', 'prev-fy', 'next-fy', 'cy', 'cy-ytd']);

// The variance month an export reports, decided once and then used for its
// figures, its title and its filename alike. A key that is not one of the
// report's months — a selection left over from another organisation or
// period — means the year to date. It used to put the first month's figures
// under a filename naming the month asked for, so the file said one thing and
// held another.
function resolveMonth(payload, month) {
  const months = payload?.months || [];
  return month && month !== 'ytd' && months.some(m => m.key === month) ? month : 'ytd';
}

// What the variance figures cover, in words. Shared by the PDF and the
// workbook, and matched by the screen. A month still in progress says so and
// when it was read: titling it "Oct 2026" alone reads as a closed month.
function varianceLabel(payload, month = 'ytd') {
  const key    = payload?.period?.key;
  const ytd    = !key || YEAR_PERIODS.has(key) ? 'Year to date' : 'Period to date';
  const k      = resolveMonth(payload, month);
  if (k === 'ytd') return ytd;
  const m   = payload.months.find(x => x.key === k);
  const cur = payload?.kpis?.currentMonth;
  return cur && cur.key === m.key && cur.asOf ? `${m.label} so far, as of ${dayLabel(cur.asOf)}` : m.label;
}

// The variance export's subtitle, before the currency. A single month names
// itself; the rollup also names the period, since "Year to date" alone is the
// same words for this financial year and the last one.
function varianceSubtitle(payload, month = 'ytd') {
  const label = varianceLabel(payload, month);
  return resolveMonth(payload, month) === 'ytd'
    ? [label, periodText(payload)].filter(Boolean).join(' · ')
    : label;
}

function budgetVarianceDoc(payload, opts = {}) {
  const { rows = [], organisation = {}, months = [] } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt || Date.now();
  const month     = resolveMonth(payload, opts.month);

  // 'ytd' rolls up the fully elapsed months; a month key reports that month
  // alone. Same two choices the screen offers, resolved the same way.
  const idx   = month === 'ytd' ? -1 : months.findIndex(m => m.key === month);
  const label = varianceSubtitle(payload, month);
  const figuresFor = r => (month === 'ytd'
    ? { actual: r.actualToDate, budget: r.budgetToDate, variance: r.variance, variancePct: r.variancePct }
    : (r.monthly || [])[idx] || { actual: 0, budget: 0, variance: 0, variancePct: null });

  const body = [[
    { text: 'Account',     style: 'colHead' },
    { text: 'Actual',      style: 'colHead', alignment: 'right' },
    { text: 'Budget',      style: 'colHead', alignment: 'right' },
    { text: 'Variance',    style: 'colHead', alignment: 'right' },
    { text: 'Variance %',  style: 'colHead', alignment: 'right' },
  ]];

  const summaryRows = new Set();
  const bandedRows  = new Set();
  let banded = false;

  for (const r of rows) {
    if (r.kind === 'section') {
      banded = false;
      body.push([
        { text: latin1(r.label), style: 'section', margin: [0, 7, 0, 2] },
        { text: '' }, { text: '' }, { text: '' }, { text: '' },
      ]);
      continue;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
    if (r.kind === 'summary') summaryRows.add(body.length);
    banded = !banded;
    if (banded) bandedRows.add(body.length);
    const style  = strong ? 'strong' : 'account';
    const v      = figuresFor(r);
    // Favourability is not the sign of the variance — over budget is good on
    // revenue and bad on costs — so the export stays with the plain sign and
    // leaves the reading to the reader, exactly as the screen does.
    const tone   = v.variance === 0 ? undefined : v.variance < 0 ? NEGATIVE : '#0f9d76';
    body.push([
      { text: latin1(r.label), style, margin: [r.kind === 'account' ? 8 : 0, 0, 0, 0] },
      { text: cell(v.actual), style, alignment: 'right' },
      { text: cell(v.budget), style, alignment: 'right', color: MUTED },
      { text: cell(v.variance), style: 'strong', alignment: 'right', color: tone },
      { text: v.variance === 0 ? '-' : pct(v.variancePct), style, alignment: 'right', color: tone },
    ]);
  }

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [32, 58, 32, 30],
    defaultStyle: { font: 'Helvetica', fontSize: 8 },
    header: pageHeader(
      organisation.name,
      'Budget Variance',
      [label, currency].filter(Boolean).join(' · '),
      generated,
    ),
    footer: pageFooter(currencyNote(currency, payload.currency)),
    styles: STYLES,
    content: [{
      table: {
        headerRows: 1,
        dontBreakRows: true,
        widths: ['*', 'auto', 'auto', 'auto', 'auto'],
        body,
      },
      layout: {
        vLineWidth: () => 0,
        hLineWidth: i => (i === 1 || summaryRows.has(i) ? 0.7 : 0),
        hLineColor: () => RULE,
        fillColor: i => (bandedRows.has(i) ? BAND : null),
        paddingLeft:   () => 5,
        paddingRight:  () => 5,
        paddingTop:    () => 3,
        paddingBottom: () => 3,
      },
    }],
  };
}

// Filenames end up in a Content-Disposition header and on someone's desktop, so
// they carry the organisation and period rather than being "export.pdf". A
// rollup names its period as well, or this year's and last year's downloads
// arrive under one name and the second overwrites the first.
function exportFilename(kind, payload, opts = {}) {
  const slug = s => String(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const org  = slug(payload?.organisation?.name || 'organisation').slice(0, 40) || 'organisation';
  const title = kind === 'variance' ? 'Budget-Variance' : 'Budget-vs-Actual';
  let span;
  if (kind === 'variance') {
    const month = resolveMonth(payload, opts.month);
    span = month === 'ytd'
      ? [slug(varianceLabel(payload, 'ytd').toLowerCase()), slug(periodText(payload))].filter(Boolean).join('_')
      : slug(payload.months.find(m => m.key === month).label);
  } else {
    span = slug(payload?.fiscalYear?.label || 'financial-year');
  }
  return `${title}_${org}_${span}`;
}

module.exports = {
  budgetVsActualDoc,
  budgetVarianceDoc,
  exportFilename,
  varianceLabel,
  varianceSubtitle,
  resolveMonth,
  periodText,
  soFarNote,
  dayLabel,
  // exported for tests
  _cell: cell, _money: money, _pct: pct, _currencyNote: currencyNote, _latin1: latin1,
};
