// Small provenance caption under a card title — which live Xero API/report the
// numbers below it came from, so "where did this come from" never needs asking.
export function SourceNote({ children }) {
  return <div style={{ fontSize: 10.5, color: 'var(--text-muted)', opacity: 0.75, marginBottom: 10 }}>Source: {children}</div>;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// '2026-10-06' -> '6 Oct 2026', read from the string so no timezone moves it.
// Same wording as the exports (main/reports/budget-doc.js#dayLabel).
export function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTH_ABBR[Number(m[2]) - 1]} ${m[1]}` : '';
}

// "Year to date" only when the period is a year; a quarter or the last six
// months is a period to date. Matches budget-doc.js#varianceLabel.
const YEAR_PERIODS = new Set(['fy', 'fy-ytd', 'prev-fy', 'next-fy', 'cy', 'cy-ytd']);
export function toDateLabel(period) {
  return !period?.key || YEAR_PERIODS.has(period.key) ? 'Year to date' : 'Period to date';
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
export function KpiCard({ icon, tone, label, value, sub }) {
  return (
    <div className="card kpi-card" style={{ display: 'flex', gap: 13 }}>
      <div className="kpi-card-icon" style={{
        width: 40, height: 40, borderRadius: 10,
        background: `var(--${tone}-subtle)`, color: `var(--${tone})`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 17, flexShrink: 0,
      }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div className="kpi-card-label" style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
        <div className="kpi-card-value" style={{ fontSize: 20, fontWeight: 800, margin: '3px 0 2px' }}>{value}</div>
        <div className="kpi-card-sub" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>
      </div>
    </div>
  );
}
