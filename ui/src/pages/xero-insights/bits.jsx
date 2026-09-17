// Small provenance caption under a card title — which live Xero API/report the
// numbers below it came from, so "where did this come from" never needs asking.
export function SourceNote({ children }) {
  return <div style={{ fontSize: 10.5, color: 'var(--text-muted)', opacity: 0.75, marginBottom: 10 }}>Source: {children}</div>;
}

// Generic "search this table" box, reused for accounts/contacts.
export function SearchBox({ value, onChange, placeholder }) {
  return <input type="text" className="form-input" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} style={{ maxWidth: 240 }} />;
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
