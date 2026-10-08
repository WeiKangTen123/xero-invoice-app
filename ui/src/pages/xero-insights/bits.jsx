// Small provenance caption under a card title — which live Xero API/report the
// numbers below it came from, so "where did this come from" never needs asking.
export function SourceNote({ children }) {
  return <div style={{ fontSize: 10.5, color: 'var(--text-muted)', opacity: 0.75, marginBottom: 10 }}>Source: {children}</div>;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// '2026-10-06' -> '6 Oct 2026', read from the string so no timezone moves it.
// Same wording as the exports (main/reports/budget-doc.js#dayLabel).
export function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}` : '';
}

// The month in progress written out, 'October', from its key '2026-10' — or
// from its label 'Oct 2026' on a payload whose key is not a month.
export function monthName(cm) {
  const k = /^\d{4}-(\d{2})$/.exec(String(cm?.key || ''));
  if (k) return MONTH_FULL[Number(k[1]) - 1] || '';
  const i = MONTH_ABBR.indexOf(String(cm?.label || '').slice(0, 3));
  return i >= 0 ? MONTH_FULL[i] : '';
}

// What the month in progress's figure is. It is the whole month's Profit and
// Loss as Xero held it on the day it was read — an invoice dated the 25th is
// in it on the 8th — so "booked as of 8 Oct" read as the 1st to the 8th, which
// it never was. The short form is for a tile hint or a button, where the month
// is already named beside it: "dated in Oct, read 8 Oct". The exports word it
// the same way (main/reports/budget-doc.js#soFarCaption).
export function soFarRead(cm) {
  const abbr = String(cm?.label || '').split(' ')[0];
  const read = dayLabel(cm?.asOf).replace(/ \d{4}$/, '');
  return `dated in ${abbr}${read ? `, read ${read}` : ''}`;
}

export function soFarCaption(cm, { short = false } = {}) {
  if (!cm) return '';
  const abbr = String(cm.label || '').split(' ')[0];
  if (short) return `${abbr} so far · ${soFarRead(cm)}`;
  const read = dayLabel(cm.asOf);
  return `${cm.label} so far — everything dated in ${monthName(cm) || abbr} as Xero holds it${read ? `, read on ${read}` : ''}`;
}

// Whether a month of the Budget Variance report can be chosen: one that has
// closed, or the one in progress. A budget month after that has nothing in it
// yet, so every line of it read "-100.00%" under "For the month ended Dec
// 2026". Same rule as the export (main/reports/budget-doc.js#monthStarted).
export function monthSelectable(m) {
  return !!m && !(m.source === 'budget' && !m.current);
}

// The month the Budget Variance tab shows for a selection: the key when it
// names a month that can be chosen, otherwise the to-date rollup. The
// selection outlives the report — the period or the organisation changes
// under it — and a month that is not in the report, or has not started, must
// not be shown. The export resolves a stale key the same way
// (main/reports/budget-doc.js#resolveMonth), so the file and the screen agree.
export function varianceSelection(d, key) {
  if (!key || key === 'ytd') return 'ytd';
  return monthSelectable((d?.months || []).find(m => m.key === key)) ? key : 'ytd';
}

// The to-date group shown beside a month, as Xero's Budget Variance report
// shows it: from the period's first month through the chosen one. Whether that
// is a year to date is the server's call (period.toDateLabel); over a quarter
// or a custom range the months are named instead, so "YTD" is never assumed.
// A month in progress is said to be so far, since the total ends in it.
export function cumulativeLabel(d, idx) {
  const months = d.months;
  const m      = months[idx];
  const tail   = m.current ? ' so far' : '';
  if (d.period?.toDateLabel === 'Year to date') return `YTD to ${m.label}${tail}`;
  // The period's first month alone is not a range: "Jul 2026 – Jul 2026".
  const range = months[0].key === m.key ? m.label : `${months[0].label} – ${m.label}`;
  return `To date (${range}${tail})`;
}

// The closed months a to-date figure covers: 'Apr 2026 – Sep 2026', just
// 'Apr 2026' for one, or '' while none has closed. The server names them; a
// payload from before it did falls back to the first and last of the elapsed
// months, which are the same two months.
export function closedRange(d) {
  const n = d?.kpis?.monthsElapsed ?? 0;
  if (n <= 0) return '';
  const from = d?.period?.closedFromLabel || d?.months?.[0]?.label;
  const to   = d?.period?.closedToLabel   || d?.months?.[n - 1]?.label;
  if (!from || !to) return '';
  return from === to ? from : `${from} – ${to}`;
}

// A to-date figure's title, naming its months: "Year to date · Apr 2026 –
// Sep 2026 (6 completed months)". "Year to date" alone reads the same for this
// year and last, and does not say that the month in progress is left out.
// Whether it is a year or a period to date is the server's call, so the
// exports and the screen cannot word it differently; without that word from
// it the title stays neutral rather than guessing.
export function toDateText(d, { count = true } = {}) {
  const label = d?.period?.toDateLabel || 'To date';
  const range = closedRange(d);
  if (!range) return `${label} · no completed months yet`;
  if (!count) return `${label} · ${range}`;
  const n = d.kpis.monthsElapsed;
  return `${label} · ${range} (${n} completed month${n === 1 ? '' : 's'})`;
}

// Said outright when Xero has no Overall Budget for the period. Every budget
// cell would otherwise read "-", the same as a line budgeted at nil, and every
// variance would equal its actual with nothing on screen saying why.
export function BudgetMissingNote() {
  return (
    <div className="alert alert-warning" style={{ marginTop: 14 }}>
      <span className="alert-icon">⚠</span>
      Xero returned no Overall Budget for this period, so budget figures are blank.
    </div>
  );
}

// An account Xero has actuals for but no budget line at all. Its budget prints
// "-" exactly like a line budgeted at nil, so the tag says which one it is.
export function NotBudgeted() {
  return (
    <span style={{ marginLeft: 6, padding: '0 5px', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
                   border: '1px solid var(--border)', borderRadius: 4, whiteSpace: 'nowrap' }}>
      not budgeted
    </span>
  );
}

// A forecast runs to the end of the period, so it is a full-year forecast only
// when the period is a whole year. The year-to-date periods count as a year
// above but end this month, so they are left out here. No key means a payload
// from before periods existed, which was always the whole financial year.
const FULL_YEAR_PERIODS = new Set(['fy', 'prev-fy', 'next-fy', 'cy']);
export function isFullYear(period) {
  return !period?.key || FULL_YEAR_PERIODS.has(period.key);
}

// The text describing a report's period, once a newer request for another
// period has failed. The report kept on screen is the last one that loaded, and
// the period picker already shows the period that failed, so the two would
// otherwise disagree with nothing saying which is which.
export function lastLoaded(text, failed) {
  return failed && text ? `Last loaded: ${text}` : text;
}

// One headline figure. The three at the top of the page were identical but for
// their colour, icon and wording, and the phone treatment has to apply to all
// three the same way — so it lives in one place now.
//
// On a phone these sit three-across at roughly 118px each, which is why the
// caller passes already-shortened text: "SGD 48.1K" rather than "SGD 48,120.55",
// and "12 invoices" rather than "12 sales invoices awaiting payment". The icon
// is dropped there by CSS (see .mobile-mode .kpi-card-icon) because a 40px
// square leaves too little beside it to read.
//
// With `onClick` the card opens something below it (the ageing for its side):
// it becomes a button for the keyboard and screen readers, says so with a
// chevron, and `active` marks it while what it opened is showing.
export function KpiCard({ icon, tone, label, value, sub, onClick, active = false, controls, actionLabel }) {
  const action = onClick ? {
    role: 'button', tabIndex: 0, onClick, 'aria-expanded': active, 'aria-controls': controls,
    title: actionLabel,
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } },
  } : {};
  return (
    <div className="card kpi-card" {...action} style={{
      display: 'flex', gap: 13,
      ...(onClick ? { cursor: 'pointer' } : {}),
      ...(active ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)' } : {}),
    }}>
      <div className="kpi-card-icon" style={{
        width: 40, height: 40, borderRadius: 10,
        background: `var(--${tone}-subtle)`, color: `var(--${tone})`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 17, flexShrink: 0,
      }}>{icon}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="kpi-card-label" style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>
          {label}
          {onClick && (
            <span aria-hidden="true" style={{ marginLeft: 5, color: active ? 'var(--accent)' : 'var(--text-muted)' }}>
              {active ? '▴' : '▾'}
            </span>
          )}
        </div>
        <div className="kpi-card-value" style={{ fontSize: 20, fontWeight: 800, margin: '3px 0 2px' }}>{value}</div>
        <div className="kpi-card-sub" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>
      </div>
    </div>
  );
}
