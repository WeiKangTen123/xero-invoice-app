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
  org:      { fontSize: 12, bold: true },
  title:    { fontSize: 12, bold: true },
  sub:      { fontSize: 7.5, color: MUTED },
  foot:     { fontSize: 6.5, color: MUTED },
  band:     { fontSize: 6.5, bold: true, characterSpacing: 0.6 },
  colHead:  { fontSize: 6.5, bold: true, color: MUTED },
  section:  { fontSize: 7.5, bold: true },
  account:  { fontSize: 7 },
  strong:   { fontSize: 7, bold: true },
};

// ── Budget vs Actual ────────────────────────────────────────────────────────
// Landscape, because the grid is one column per month plus a total and there is
// no honest way to fit twelve of those on a portrait page.
function budgetVsActualDoc(payload, opts = {}) {
  const { months = [], rows = [], organisation = {}, fiscalYear = {} } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt || Date.now();

  const firstBudgetIdx = months.findIndex(m => m.source === 'budget');
  const actualCount    = firstBudgetIdx === -1 ? months.length : firstBudgetIdx;
  // Column 0 is the account label, so a month at index i is table column i + 1.
  const seamColumn     = firstBudgetIdx === -1 ? -1 : firstBudgetIdx + 1;

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
  for (const r of rows) {
    if (r.kind === 'section') {
      body.push([
        { text: latin1(r.label), style: 'section', colSpan: months.length + 2, margin: [0, 5, 0, 1] },
        ...new Array(months.length + 1).fill({}),
      ]);
      continue;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
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
        // The seam between the last actual month and the first budget month.
        // Xero's own PDF signals this only in the column headers, which is easy
        // to miss, so it gets a rule here exactly as it does on screen.
        vLineWidth: i => (i === seamColumn ? 1.2 : 0),
        vLineColor: () => ACCENT,
        hLineWidth: i => (i === 2 ? 0.7 : 0),
        hLineColor: () => RULE,
        paddingLeft:   () => 4,
        paddingRight:  () => 4,
        paddingTop:    () => 2.5,
        paddingBottom: () => 2.5,
      },
    }],
  };
}

// ── Budget Variance ─────────────────────────────────────────────────────────
// Portrait: five columns fit comfortably, and it is the report someone is more
// likely to read on a phone.
function budgetVarianceDoc(payload, opts = {}) {
  const { rows = [], organisation = {}, months = [] } = payload || {};
  const currency  = organisation.currency && organisation.currency !== '—' ? organisation.currency : '';
  const generated = opts.generatedAt || Date.now();
  const month     = opts.month || 'ytd';

  // 'ytd' rolls up the fully elapsed months; a month key reports that month
  // alone. Same two choices the screen offers, resolved the same way.
  const idx   = month === 'ytd' ? -1 : Math.max(0, months.findIndex(m => m.key === month));
  const label = month === 'ytd' ? 'Year to date' : (months[idx]?.label || 'Year to date');
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

  for (const r of rows) {
    if (r.kind === 'section') {
      body.push([
        { text: latin1(r.label), style: 'section', colSpan: 5, margin: [0, 5, 0, 1] },
        {}, {}, {}, {},
      ]);
      continue;
    }
    const strong = r.kind === 'subtotal' || r.kind === 'summary';
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
        hLineWidth: i => (i === 1 ? 0.7 : 0),
        hLineColor: () => RULE,
        paddingLeft:   () => 5,
        paddingRight:  () => 5,
        paddingTop:    () => 3,
        paddingBottom: () => 3,
      },
    }],
  };
}

// Filenames end up in a Content-Disposition header and on someone's desktop, so
// they carry the organisation and period rather than being "export.pdf".
function exportFilename(kind, payload, opts = {}) {
  const org = (payload?.organisation?.name || 'organisation')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'organisation';
  const months = payload?.months || [];
  const span = kind === 'variance'
    ? (opts.month === 'ytd' || !opts.month ? 'year-to-date' : (months.find(m => m.key === opts.month)?.label || opts.month))
    : (payload?.fiscalYear?.label || 'financial-year');
  const title = kind === 'variance' ? 'Budget-Variance' : 'Budget-vs-Actual';
  return `${title}_${org}_${String(span).replace(/[^\p{L}\p{N}]+/gu, '-')}`;
}

module.exports = {
  budgetVsActualDoc,
  budgetVarianceDoc,
  exportFilename,
  // exported for tests
  _cell: cell, _money: money, _pct: pct, _currencyNote: currencyNote, _latin1: latin1,
};
