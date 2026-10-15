// The Monthly sub-tab's decisions: which spans and fills the controls offer,
// what is remembered between visits, what the request asks for, how the
// columns are banded, which rows the grid shows and how, what colour a
// closing balance is, and what hovering a figure says it was made of.
//
// Plain functions with no imports, so main/scripts/cash-monthly-ui.test.js
// can load and run them against a payload shaped as the server sends it
// (main/xero/cash-monthly.js); CashMonthly.jsx only lays them out.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The spans offered, months before this one and after it: the server takes
// 0 to 12 behind and 1 to 12 ahead, and these are the ones worth a click.
const SPANS = [[3, 3], [6, 6], [12, 6], [6, 12], [12, 12], [0, 12]];
const FILLS = ['budget', 'none'];
const DEFAULT_PREFS = { past: 6, future: 6, fill: 'budget' };

// The words for each kind of column, over the bands and in the hover text.
const KIND_LABEL = { actual: 'Actual', current: 'Actual + forecast', forecast: 'Forecast' };
// The lines that start a group, and what the group is called.
const HEADINGS = { in_customer: 'Cash in', out_supplier: 'Cash out' };
const STRONG = ['opening', 'in_total', 'out_total', 'net', 'closing'];

// What each source the server names means, for the hover text.
const SOURCE_HINT = {
  'bank': 'Xero\'s Bank Summary',
  'payments': 'payments recorded in Xero against invoices and bills',
  'bank transactions': 'bank transactions recorded in Xero, by the account each line is coded to',
  'unexplained': 'money the Bank Summary shows moving that no payment or bank transaction accounts for: pay runs and journals the app cannot read',
  'transfers with accounts left out': 'transfers to or from a bank account left out in the bank options',
  'opening adjustment': 'the opening adjustment set in the bank options',
  'bank movement': 'the Bank Summary\'s movement, not split because payments could not be read',
  'previous closing': 'the month before\'s closing balance',
  'forecast': 'the forecast for the rest of the month',
  'budget': 'the Overall Budget in Xero, less what is already scheduled',
  'open invoices': 'sales invoices still owed, on their expected dates',
  'open bills': 'bills still owed, on their planned dates',
  'repeating': 'invoices and bills repeating templates will raise',
  'payments dated ahead': 'payments recorded in Xero with a later date',
  'spend/receive money dated ahead': 'Spend Money and Receive Money transactions entered in Xero with a later date',
  'bank transactions dated ahead': 'Spend Money and Receive Money transactions entered in Xero with a later date',
  'your entries': 'entries made in the Cash Flow Manager',
  'your bank adjustments': 'the opening adjustments set in the bank options',
};

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const cents = v => Math.round(num(v) * 100);
// Null, or anything that is not a number, is a figure the server does not
// have (a Bank Summary month that came back empty, this month's rows when
// Xero's records could not be read): blank on screen, never a nil.
const isBlank = v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v));

// ── The controls ────────────────────────────────────────────────────────────

export function spanKey(past, future) {
  return `${past}-${future}`;
}

export function spanOptions() {
  return SPANS.map(([past, future]) => ({ key: spanKey(past, future), past, future, label: `Past ${past} | Next ${future}` }));
}

export function fillOptions() {
  return [{ key: 'budget', label: 'Budget' }, { key: 'none', label: 'Nothing' }];
}

// The span, fill and so on remembered from the last visit, from what was
// stored (a JSON string, or nothing in a private window). A span not offered
// is the default rather than a request the server would refuse.
export function readMonthlyPrefs(raw) {
  let p = raw;
  if (typeof raw === 'string') {
    try { p = JSON.parse(raw); } catch { p = null; }
  }
  if (!p || typeof p !== 'object') return { ...DEFAULT_PREFS };
  const offered = SPANS.some(([a, b]) => a === p.past && b === p.future);
  return {
    past:   offered ? p.past : DEFAULT_PREFS.past,
    future: offered ? p.future : DEFAULT_PREFS.future,
    fill:   FILLS.includes(p.fill) ? p.fill : DEFAULT_PREFS.fill,
  };
}

// The query the route and the exports take: the organisation, once known, and
// the span and fill on screen, so a PDF is the forecast looked at.
export function monthlyQueryFor({ tenantId, past, future, fill } = {}) {
  const prefs = readMonthlyPrefs({ past, future, fill });
  const q = {};
  if (tenantId) q.tenantId = tenantId;
  q.past = String(prefs.past);
  q.future = String(prefs.future);
  q.fill = prefs.fill;
  return q;
}

// The query string for the route, with force when the page was refreshed.
export function monthlySearch(query, { force = false } = {}) {
  const parts = Object.entries(query || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  if (force) parts.push('force=true');
  return parts.join('&');
}

// ── The columns ─────────────────────────────────────────────────────────────

// Each month as a column: its kind, and its heading as a month over a year
// (the year is what tells a reader where December turns into January). The
// month in progress is starred, for the footnote.
export function columnsOf(payload) {
  const months = Array.isArray(payload?.months) ? payload.months.filter(Boolean) : [];
  return months.map(m => {
    const k = /^(\d{4})-(\d{2})$/.exec(String(m.key || ''));
    const month = k ? MONTH_ABBR[Number(k[2]) - 1] : String(m.label || '').slice(0, 3);
    const year = k ? k[1] : String(m.label || '').slice(-4);
    const kind = KIND_LABEL[m.kind] ? m.kind : 'forecast';
    return {
      key: m.key, label: m.label || '', month: `${month}${kind === 'current' ? '*' : ''}`, year,
      kind, current: kind === 'current', kindLabel: KIND_LABEL[kind],
    };
  });
}

// The bands over the columns: each run of one kind, with how many columns it
// spans, as the layout draws "ACTUAL | A+F | FORECAST".
export function bandsOf(payload) {
  const out = [];
  for (const c of columnsOf(payload)) {
    const last = out[out.length - 1];
    if (last && last.kind === c.kind) last.span++;
    else out.push({ kind: c.kind, label: KIND_LABEL[c.kind], span: 1 });
  }
  return out;
}

// What the star on this month's heading means.
export function currentFootnote(payload) {
  const cur = columnsOf(payload).find(c => c.current);
  if (!cur) return '';
  return `* ${cur.label} = actual to ${longDay(payload?.today) || 'today'} + forecast for the rest of the month`;
}

function longDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}` : '';
}

// ── The colour of a closing balance ─────────────────────────────────────────

// Red below the overdraft limit (or below zero with no limit set), orange
// below zero within it, nothing at or above zero. Read in cents, so a balance
// a hair under zero from adding floats is not called overdrawn. A blank cell
// (or one that is not a number) has no colour.
export function closingTone(value, overdraft = 0) {
  if (isBlank(value)) return null;
  const b = cents(value);
  const limit = Math.max(0, cents(overdraft));
  if (b >= 0) return null;
  return b < -limit ? 'danger' : 'warning';
}

export function toneColour(tone) {
  return tone === 'danger' ? 'var(--danger)' : tone === 'warning' ? 'var(--warning)' : undefined;
}

// ── The rows ────────────────────────────────────────────────────────────────

// What hovering a figure says: the line and month, what kind of month it is,
// and what the figure was made of, each source in words. Blank when the
// server named nothing.
export function sourcesText(row, index, payload) {
  const col = columnsOf(payload)[index];
  const raw = String(row?.sources?.[index] || '').trim();
  if (!col || !raw) return '';
  const head = `${row.label}, ${col.label} (${col.kindLabel.toLowerCase()})`;
  // The overdue row's source is already a sentence of its own.
  if (row.key === 'overdue') return `${head}: ${raw}`;
  const parts = raw.split(' + ').map(s => s.trim()).filter(Boolean);
  const lines = parts.map(s => {
    const hint = SOURCE_HINT[s.toLowerCase()];
    return hint ? `• ${s}: ${hint}` : `• ${s}`;
  });
  return [`${head}, from:`, ...lines].join('\n');
}

// The grid as the table draws it: a heading before each group, then each
// line with its cells. A line in a group is indented; the totals, Opening,
// Net and Closing are bold; the overdue line is muted and stands apart. Your
// bank adjustments, between Net and Closing, is a balance line but not bold:
// it is a step on the way to the closing balance, not one of its own. A
// closing balance carries its colour. A cell with no figure is blank, with no
// hover text: what a figure was made of says nothing about one that is not
// there.
export function gridRows(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows.filter(Boolean) : [];
  const cols = columnsOf(payload);
  const overdraft = num(payload?.overdraft);
  const out = [];
  for (const r of rows) {
    if (HEADINGS[r.key]) out.push({ type: 'heading', key: `heading:${r.key}`, label: HEADINGS[r.key] });
    const grouped = r.group === 'in' || r.group === 'out';
    out.push({
      type: 'row', key: r.key, label: r.label, group: r.group,
      strong: STRONG.includes(r.key), indent: grouped && !/_total$/.test(r.key), info: r.group === 'info',
      cells: cols.map((c, i) => {
        const value = r.values?.[i];
        const blank = isBlank(value);
        return {
          key: c.key, kind: c.kind,
          value: blank ? null : num(value),
          tone: r.key === 'closing' ? closingTone(value, overdraft) : null,
          title: blank ? '' : sourcesText(r, i, payload),
        };
      }),
    });
  }
  return out;
}

// The shading of a column, as the layout tells actual from forecast: the past
// months grey, this month amber as the budget grid marks the month in
// progress, the months ahead plain.
export function columnShade(kind) {
  return kind === 'actual' ? 'var(--bg-secondary)' : kind === 'current' ? 'var(--warning-subtle)' : undefined;
}
