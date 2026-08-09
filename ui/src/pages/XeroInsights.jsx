import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatDateTime, formatRelative } from '../utils/formatDate';

const PHASE2_TABS = [
  { key: 'banking',  label: 'Banking' },
  { key: 'accounts', label: 'Chart of Accounts' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'pnl',      label: 'P&L' },
];

function fmtMoney(n, currency) {
  const v = Number(n || 0);
  return `${currency ? currency + ' ' : ''}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Bar chart: Receivables vs Payables — interactive hover ──────────────────
function ReceivablesPayablesChart({ receivables, payables, currency }) {
  const [hover, setHover] = useState(null); // 'recv' | 'pay' | null
  const max = Math.max(receivables, payables, 1);
  const W = 360, H = 170, PAD_B = 26, PAD_T = 14, barW = 78;
  const scale = v => (v / max) * (H - PAD_T - PAD_B);

  const bars = [
    { key: 'recv', label: 'Receivables', value: receivables, x: 70,  color: 'var(--success)' },
    { key: 'pay',  label: 'Payables',    value: payables,    x: 210, color: 'var(--danger)' },
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <line x1="40" y1={PAD_T} x2="40" y2={H - PAD_B} stroke="var(--border)" strokeWidth="1" />
      <line x1="40" y1={H - PAD_B} x2={W - 20} y2={H - PAD_B} stroke="var(--border)" strokeWidth="1" />
      {bars.map(b => {
        const h = scale(b.value);
        const y = H - PAD_B - h;
        const active = hover === b.key;
        return (
          <g key={b.key}
             onMouseEnter={() => setHover(b.key)} onMouseLeave={() => setHover(null)}
             style={{ cursor: 'pointer' }}>
            <rect x={b.x} y={PAD_T} width={barW} height={H - PAD_T - PAD_B} fill="transparent" />
            <rect x={b.x} y={y} width={barW} height={Math.max(h, 2)} rx="6" fill={b.color} opacity={active ? 1 : 0.82} />
            <text x={b.x + barW / 2} y={y - 8} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--text-primary)">
              {active ? fmtMoney(b.value, currency) : b.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </text>
            <text x={b.x + barW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--text-secondary)">{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Donut: invoice status breakdown — interactive hover ─────────────────────
function StatusDonut({ breakdown }) {
  const [hover, setHover] = useState(null);
  const segments = [
    { key: 'paid',    label: 'Paid',     value: breakdown.paid,    color: 'var(--success)' },
    { key: 'awaiting',label: 'Awaiting', value: breakdown.awaiting,color: 'var(--warning)' },
    { key: 'overdue', label: 'Overdue',  value: breakdown.overdue, color: 'var(--danger)' },
  ];
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const R = 52, CX = 90, CY = 74, CIRC = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div>
      <svg viewBox="0 0 180 150" style={{ width: '100%', height: 'auto', display: 'block' }}>
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--bg-secondary)" strokeWidth="20" />
        {segments.map(s => {
          const frac = s.value / total;
          const dash = frac * CIRC;
          const el = (
            <circle
              key={s.key} cx={CX} cy={CY} r={R} fill="none" stroke={s.color}
              strokeWidth={hover === s.key ? 24 : 20}
              strokeDasharray={`${dash} ${CIRC - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${CX} ${CY})`}
              style={{ cursor: 'pointer', transition: 'stroke-width 0.12s' }}
              onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}
            />
          );
          offset += dash;
          return el;
        })}
        <text x={CX} y={CY - 4} textAnchor="middle" fontSize="19" fontWeight="800" fill="var(--text-primary)">
          {hover ? segments.find(s => s.key === hover).value : total}
        </text>
        <text x={CX} y={CY + 13} textAnchor="middle" fontSize="9.5" fill="var(--text-muted)">
          {hover ? segments.find(s => s.key === hover).label : 'total'}
        </text>
      </svg>
      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap', marginTop: 4 }}>
        {segments.map(s => (
          <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: hover && hover !== s.key ? 0.5 : 1, cursor: 'pointer' }}
                onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, display: 'inline-block' }} />
            {s.label} {s.value}
          </span>
        ))}
      </div>
    </div>
  );
}

const STATUS_BADGE = {
  paid:     { cls: 'badge-green',  label: 'Paid' },
  awaiting: { cls: 'badge-yellow', label: 'Awaiting' },
  overdue:  { cls: 'badge-red',    label: 'Overdue' },
};

export default function XeroInsights() {
  const { user }   = useAuth();
  const navigate   = useNavigate();
  const [data,      setData]      = useState(null); // null = loading
  const [error,     setError]     = useState('');
  const [refreshing,setRefreshing]= useState(false);
  const [tab,       setTab]       = useState('overview');
  const [search,    setSearch]    = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [activeTenantId, setActiveTenantId] = useState(null);
  const [, forceTick] = useState(0); // re-render every 15s so "synced Xs ago" stays live
  const tickRef = useRef(null);

  async function fetchSummary(opts = {}) {
    if (opts.force) setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (opts.force) params.set('force', 'true');
      if (activeTenantId) params.set('tenantId', activeTenantId);
      const d = await api.get(`/xero-reports/summary?${params.toString()}`);
      setData(d);
      setError('');
      if (d.activeTenantId) setActiveTenantId(d.activeTenantId);
    } catch (err) {
      setError(err.message || 'Could not load Insights');
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => { fetchSummary(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeTenantId) fetchSummary();
  }, [activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    tickRef.current = setInterval(() => forceTick(t => t + 1), 15000);
    return () => clearInterval(tickRef.current);
  }, []);

  const filteredInvoices = useMemo(() => {
    if (!data?.invoices) return [];
    const q = search.trim().toLowerCase();
    return data.invoices.filter(inv => {
      if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
      if (!q) return true;
      return inv.contact.toLowerCase().includes(q) || inv.invoiceNumber.toLowerCase().includes(q);
    });
  }, [data, search, statusFilter]);

  if (data === null && !error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 32 }}>
        <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
        Loading Insights...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <div className="page-header"><h1>Insights</h1></div>
        <div className="alert alert-error"><span className="alert-icon">✕</span>{error}</div>
      </div>
    );
  }

  if (!data.connected) {
    return (
      <div>
        <div className="page-header">
          <h1>Insights</h1>
          <p>Live financial data pulled read-only from your connected Xero organisation.</p>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 34, marginBottom: 12 }}>🔗</div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>No Xero connection yet</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18, maxWidth: 380, marginInline: 'auto' }}>
            Insights reads from whatever connection you already set up — nothing to configure here.
            Connect via Custom Connection or your own Xero Web app in Setup first.
          </div>
          <button className="btn btn-primary" onClick={() => navigate('/setup')}>Go to Setup →</button>
        </div>
      </div>
    );
  }

  const { organisation, kpis, tenants } = data;
  const currency = organisation.currency !== '—' ? organisation.currency : '';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Insights</h1>
          <p>Live financial data pulled read-only from your connected Xero organisation.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {tenants?.length > 1 && (
            <select className="form-input" style={{ width: 'auto', fontSize: 12 }} value={activeTenantId || ''}
                    onChange={e => setActiveTenantId(e.target.value)}>
              {tenants.map(t => <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>)}
            </select>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />
            Synced {formatRelative(new Date(data.fetchedAt).toISOString())}
            {data.cached === false && <span style={{ color: 'var(--accent)', fontWeight: 600 }}>· fresh</span>}
          </div>
          <button className="btn btn-outline btn-sm" disabled={refreshing} onClick={() => fetchSummary({ force: true })}>
            {refreshing ? <span className="btn-spinner" /> : '↻'} Refresh
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginTop: 14 }}><span className="alert-icon">✕</span>{error}</div>}

      <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, margin: '18px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>🏢</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{organisation.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Connected via Xero</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="badge badge-gray">Country {organisation.country}</span>
          <span className="badge badge-gray">Currency {organisation.currency}</span>
          <span className="badge badge-gray">Year end {organisation.yearEnd}</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
        <div className="card" style={{ display: 'flex', gap: 13 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--success-subtle)', color: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>↗</div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>Total Receivables</div>
            <div style={{ fontSize: 20, fontWeight: 800, margin: '3px 0 2px' }}>{fmtMoney(kpis.totalReceivables, currency)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{kpis.receivablesCount} sales invoice{kpis.receivablesCount !== 1 ? 's' : ''} awaiting payment</div>
          </div>
        </div>
        <div className="card" style={{ display: 'flex', gap: 13 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--danger-subtle)', color: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>▣</div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>Total Payables</div>
            <div style={{ fontSize: 20, fontWeight: 800, margin: '3px 0 2px' }}>{fmtMoney(kpis.totalPayables, currency)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{kpis.payablesCount} bill{kpis.payablesCount !== 1 ? 's' : ''} awaiting payment</div>
          </div>
        </div>
        <div className="card" style={{ display: 'flex', gap: 13 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--warning-subtle)', color: 'var(--warning)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>⏱</div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600 }}>Overdue Amount</div>
            <div style={{ fontSize: 20, fontWeight: 800, margin: '3px 0 2px' }}>{fmtMoney(kpis.overdueAmount, currency)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{kpis.statusBreakdown.overdue} invoice{kpis.statusBreakdown.overdue !== 1 ? 's' : ''} past due</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, marginBottom: 18, width: 'fit-content', flexWrap: 'wrap' }}>
        {[{ key: 'overview', label: 'Overview' }, { key: 'invoices', label: 'Invoices & Bills' }].map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} style={{
            padding: '7px 16px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
            background: tab === t.key ? 'var(--accent-gradient)' : 'transparent',
            color: tab === t.key ? '#fff' : 'var(--text-muted)',
          }}>{t.label}</button>
        ))}
        {PHASE2_TABS.map(t => (
          <span key={t.key} title="Coming later — needs a wider Xero connection scope" style={{
            padding: '7px 16px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)', opacity: 0.5,
            display: 'flex', alignItems: 'center', gap: 6, cursor: 'not-allowed',
          }}>
            {t.label}
            <span style={{ fontSize: 8.5, fontWeight: 800, background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 5 }}>PHASE 2</span>
          </span>
        ))}
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 }}>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 2 }}>Receivables vs. Payables</div>
            <div className="card-subtitle">Hover a bar for the exact amount</div>
            <ReceivablesPayablesChart receivables={kpis.totalReceivables} payables={kpis.totalPayables} currency={currency} />
          </div>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 2 }}>Invoice Status</div>
            <div className="card-subtitle">Sales &amp; bills combined</div>
            <StatusDonut breakdown={kpis.statusBreakdown} />
          </div>
        </div>
      )}

      {tab === 'invoices' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>Invoices &amp; Bills</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {['all', 'paid', 'awaiting', 'overdue'].map(s => (
                <button key={s} type="button" onClick={() => setStatusFilter(s)} className="btn btn-sm" style={{
                  background: statusFilter === s ? 'var(--accent-gradient)' : 'var(--bg-secondary)',
                  color: statusFilter === s ? '#fff' : 'var(--text-muted)', border: 'none', textTransform: 'capitalize',
                }}>{s}</button>
              ))}
              <input
                type="text" className="form-input" placeholder="Search contact or invoice #..."
                value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 220 }}
              />
            </div>
          </div>

          {filteredInvoices.length === 0 ? (
            <div className="empty-state" style={{ padding: '30px 0' }}>
              <div className="empty-state-icon">📄</div>
              <div>No invoices match</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                    <th style={{ padding: '6px 10px' }}>Type</th>
                    <th style={{ padding: '6px 10px' }}>Contact</th>
                    <th style={{ padding: '6px 10px' }}>Invoice #</th>
                    <th style={{ padding: '6px 10px' }}>Date</th>
                    <th style={{ padding: '6px 10px' }}>Due Date</th>
                    <th style={{ padding: '6px 10px' }}>Status</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>Total</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>Amount Due</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.map(inv => {
                    const badge = STATUS_BADGE[inv.status];
                    return (
                      <tr key={inv.invoiceId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '9px 10px' }}>{inv.type}</td>
                        <td style={{ padding: '9px 10px' }}>{inv.contact}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{inv.invoiceNumber || '—'}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{formatDateTime(inv.date, user?.timezone).split(',')[0]}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{inv.dueDate ? formatDateTime(inv.dueDate, user?.timezone).split(',')[0] : '—'}</td>
                        <td style={{ padding: '9px 10px' }}><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(inv.total, inv.currency)}</td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(inv.amountDue, inv.currency)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
