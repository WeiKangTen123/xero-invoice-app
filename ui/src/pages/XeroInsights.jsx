import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatDateTime, formatRelative } from '../utils/formatDate';
import { fmtMoney, fmtCell } from '../utils/format';
import { MonthRange, OverviewPanel, RevenuePanel, CashFlowPanel, ProfitabilityPanel, AnalysisPanel, BarList, GroupedMonthlyBars } from '../components/performance/PerformancePanels';

const TABS = [
  { key: 'overview', label: 'Overview' },
  // All AI-written commentary in one place, with its own controls. It used to be
  // two blocks on Overview, which already carried twelve.
  { key: 'analysis', label: 'Analysis' },
  { key: 'revenue',  label: 'Revenue' },
  { key: 'cashflow', label: 'Cash Flow' },
  { key: 'profit',   label: 'Profitability' },
  { key: 'banking',  label: 'Banking' },
  // Chart of Accounts moved to Settings: it answers "is my setup right?", not
  // "how is the business doing?". Its route still backs AccountCodeSelect.
  { key: 'contacts', label: 'Contacts' },
  { key: 'budget',   label: 'Budget vs Actual' },
  { key: 'variance', label: 'Budget Variance' },
];
// Nothing left here for now — kept as an array (rather than removed outright)
// since it's the natural place to list whatever needs the next scope widening.
const PHASE2_TABS = [];



// P&L/Cash Flow are Xero Report-API-backed, and Xero rejects >365-day report
// ranges outright — the backend silently clamps a very wide request (like
// "All Time") to the most recent ~10 years instead. Showing the range the
// API actually used (echoed back on the response) rather than the raw
// preset's own range keeps "All Time" from implying more than it delivers.

// Small provenance caption under a card title — which live Xero API/report the
// numbers below it came from, so "where did this come from" never needs asking.
function SourceNote({ children }) {
  return <div style={{ fontSize: 10.5, color: 'var(--text-muted)', opacity: 0.75, marginBottom: 10 }}>Source: {children}</div>;
}


// ── Bar chart: any two values compared — interactive hover ──────────────────
// Generic enough to serve Receivables/Payables (Overview), Income/Expenses
// (P&L), and Cash In/Cash Out (Cash Flow) — same visual language throughout.

// ── Aging bars: outstanding amount bucketed by how soon it's due ────────────
// Mirrors Xero's own "Invoices owed to you" / "Bills to pay" widgets, just
// with fixed day windows instead of Xero's dynamic weekly columns.

// ── Donut: invoice status breakdown — interactive hover ─────────────────────





// The monthly actual/budget grid. 14 columns don't fit any normal screen, so the
// table scrolls horizontally inside its own container while the row-label column
// stays pinned — without that you scroll to December and lose track of the row.
function BudgetGrid({ months, rows }) {
  const firstBudgetIdx = months.findIndex(m => m.source === 'budget');
  const actualCount    = firstBudgetIdx === -1 ? months.length : firstBudgetIdx;

  const labelCell = (extra = {}) => ({
    position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-primary)',
    textAlign: 'left', padding: '7px 12px 7px 0', whiteSpace: 'nowrap', ...extra,
  });
  // The seam between the last actual month and the first budget month. Xero's own
  // PDF only signals this in the column headers, which is easy to miss.
  const seam = i => (i === firstBudgetIdx ? { borderLeft: '2px solid var(--accent)' } : {});

  return (
    <div style={{ overflowX: 'auto', marginTop: 14 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
        <thead>
          {/* Band spanning the two blocks, so ACTUAL and BUDGET read as two things */}
          <tr>
            <th style={labelCell()} />
            {actualCount > 0 && (
              <th colSpan={actualCount} style={{ padding: '2px 8px', fontSize: 10, letterSpacing: '0.08em', color: 'var(--success)', textTransform: 'uppercase' }}>Actual</th>
            )}
            {actualCount < months.length && (
              <th colSpan={months.length - actualCount} style={{ padding: '2px 8px', fontSize: 10, letterSpacing: '0.08em', color: 'var(--accent)', textTransform: 'uppercase', ...seam(firstBudgetIdx) }}>Overall Budget</th>
            )}
            <th style={{ padding: '2px 8px' }} />
          </tr>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={labelCell({ fontSize: 11, color: 'var(--text-muted)' })}>Account</th>
            {months.map((m, i) => (
              <th key={m.key} style={{ padding: '6px 10px', textAlign: 'right', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                                       color: m.source === 'actual' ? 'var(--text-secondary)' : 'var(--text-muted)', ...seam(i) }}>
                {m.label}
              </th>
            ))}
            <th style={{ padding: '6px 10px 6px 16px', textAlign: 'right', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', borderLeft: '1px solid var(--border)' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            if (r.kind === 'section') return (
              <tr key={`s-${idx}`}>
                <td colSpan={months.length + 2} style={{ padding: '14px 0 4px', fontWeight: 700, fontSize: 12 }}>{r.label}</td>
              </tr>
            );
            const strong  = r.kind === 'subtotal' || r.kind === 'summary';
            const rowLine = r.kind === 'summary' ? { borderTop: '1px solid var(--border)' } : {};
            return (
              <tr key={`r-${idx}`} style={rowLine}>
                <td style={labelCell({ paddingLeft: r.kind === 'account' ? 14 : 0, fontWeight: strong ? 700 : 400 })}>{r.label}</td>
                {r.cells.map((v, i) => (
                  <td key={i} style={{ padding: '7px 10px', textAlign: 'right', fontWeight: strong ? 700 : 400,
                                       color: v < 0 ? 'var(--danger)' : undefined, ...seam(i) }}>
                    {fmtCell(v)}
                  </td>
                ))}
                <td style={{ padding: '7px 10px 7px 16px', textAlign: 'right', fontWeight: 700, borderLeft: '1px solid var(--border)',
                             color: r.total < 0 ? 'var(--danger)' : undefined }}>
                  {fmtCell(r.total)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Xero's Budget Variance report: Actual | Budget | Variance | Variance % for one
// or more months side by side. `periods` is a list of { label, of(row) } so the
// same table renders a single month or the year-to-date rollup.
//
// A zero variance prints as a dash, not "0.00%" — matched against the org's own
// Budget Variance report, where an on-budget line shows "-" in both columns.
function VarianceTable({ rows, periods, currency }) {
  const numeric = { textAlign: 'right', padding: '7px 10px', whiteSpace: 'nowrap' };
  const dash    = <span style={{ color: 'var(--text-muted)' }}>-</span>;

  return (
    <div style={{ overflowX: 'auto', marginTop: 14 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
        <thead>
          {periods.length > 1 && (
            <tr>
              <th />
              {periods.map((p, i) => (
                <th key={p.label} colSpan={4} style={{ padding: '2px 10px', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase',
                                                       color: 'var(--accent)', borderLeft: i > 0 ? '1px solid var(--border)' : undefined }}>{p.label}</th>
              ))}
            </tr>
          )}
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ position: 'sticky', left: 0, background: 'var(--bg-primary)', textAlign: 'left', padding: '8px 12px 8px 0',
                         fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Account</th>
            {periods.map((p, pi) => ['Actual', 'Budget', 'Variance', 'Variance %'].map((h, hi) => (
              <th key={`${p.label}-${h}`} style={{ ...numeric, padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600,
                                                   borderLeft: hi === 0 && pi > 0 ? '1px solid var(--border)' : undefined }}>{h}</th>
            )))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            if (r.kind === 'section') return (
              <tr key={`s-${idx}`}>
                <td colSpan={1 + periods.length * 4} style={{ padding: '14px 0 4px', fontWeight: 700, fontSize: 12 }}>{r.label}</td>
              </tr>
            );
            const strong = r.kind === 'subtotal' || r.kind === 'summary';
            return (
              <tr key={`r-${idx}`} style={{ borderTop: r.kind === 'summary' ? '1px solid var(--border)' : undefined }}>
                <td style={{ position: 'sticky', left: 0, background: 'var(--bg-primary)', padding: '7px 12px 7px 0',
                             paddingLeft: r.kind === 'account' ? 14 : 0, fontWeight: strong ? 700 : 400, whiteSpace: 'nowrap' }}>{r.label}</td>
                {periods.map((p, pi) => {
                  const v = p.of(r);
                  // Direction only — for an expense, under budget is good; for
                  // income it's bad. Without each account's sign convention the
                  // colour shows which way it moved, never a verdict.
                  const col = v.variance === 0 ? undefined : v.variance > 0 ? 'var(--success)' : 'var(--danger)';
                  const edge = pi > 0 ? { borderLeft: '1px solid var(--border)' } : {};
                  return (
                    <Fragment key={p.label}>
                      <td style={{ ...numeric, ...edge, fontWeight: strong ? 700 : 400 }}>{v.actual === 0 ? dash : fmtMoney(v.actual, currency)}</td>
                      <td style={{ ...numeric, color: 'var(--text-muted)' }}>{v.budget === 0 ? dash : fmtMoney(v.budget, currency)}</td>
                      <td style={{ ...numeric, fontWeight: 700, color: col }}>{v.variance === 0 ? dash : fmtCell(v.variance)}</td>
                      <td style={{ ...numeric, color: col }}>
                        {v.variance === 0 || v.variancePct === null ? dash : `${(v.variancePct * 100).toFixed(2)}%`}
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Generic "search this table" box, reused for accounts/contacts.
function SearchBox({ value, onChange, placeholder }) {
  return <input type="text" className="form-input" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} style={{ maxWidth: 240 }} />;
}


// The Bank Summary report identifies accounts by NAME only — it carries no
// account id — so balances can only be joined to the Accounts list by name.
// A miss returns null and the UI shows an em dash: a missing balance is honest,
// a balance attached to the wrong account is not.
function balancesByName(cashAccounts = []) {
  const map = new Map();
  for (const a of cashAccounts) {
    const key = String(a.name || '').trim().toLowerCase();
    if (key) map.set(key, a);
  }
  return map;
}

function balanceFor(map, account) {
  return map.get(String(account?.name || '').trim().toLowerCase()) || null;
}

export default function XeroInsights() {
  const { user }   = useAuth();
  const navigate   = useNavigate();
  const [data,      setData]      = useState(null); // null = loading
  const [error,     setError]     = useState('');
  const [refreshing,setRefreshing]= useState(false);
  const [tab,       setTab]       = useState('overview');
  const [activeTenantId, setActiveTenantId] = useState(null);
  const [, forceTick] = useState(0); // re-render every 15s so "synced Xs ago" stays live
  const tickRef = useRef(null);


  // Lazily-loaded directory tabs — fetched once, the first time each is opened.
  // data starts as [] (not null) so the very first render after switching to
  // one of these tabs — before the fetch effect has even fired, while status
  // is still 'idle' — never has to null-check .data.length mid-render.
  const [banking,  setBanking]  = useState({ status: 'idle', data: [], error: '' });
  const [contacts, setContacts] = useState({ status: 'idle', data: [], error: '' });
  const [contactSearch, setContactSearch] = useState('');

  // Banking tab's statement drill-down — which account, and its transactions.
  const [selectedBankAccount, setSelectedBankAccount] = useState(null);
  const [statement, setStatement] = useState({ status: 'idle', data: [], error: '' });

  // Budget vs Actual — lazily loaded like the directory tabs. `data` stays null
  // until loaded (unlike those, it's an object not a list, so there's nothing
  // meaningful to render half-populated).
  const [budget, setBudget] = useState({ status: 'idle', data: null, error: '' });

  // Performance overview — feeds BOTH the Overview and Revenue tabs from one
  // fetch. monthFrom/monthTo index into data.months, so changing the range
  // re-slices in place without touching the network.
  const [perf, setPerf] = useState({ status: 'idle', data: null, error: '' });
  const [monthFrom, setMonthFrom] = useState(0);
  const [monthTo,   setMonthTo]   = useState(11);
  // The period is now server-resolved: either a named preset, or an explicit
  // from/to span of any length. Month range and preset are independent — picking
  // a range simply switches the preset to 'custom'.
  const [perfPreset, setPerfPreset] = useState('fy-ytd');
  const [perfRange,  setPerfRange]  = useState(null); // { from, to } when custom
  const [revenueLine, setRevenueLine] = useState('overall');
  // Fetched separately from the figures so an LLM outage or a missing API key
  // can never delay or blank the dashboard itself.
  const [insights, setInsights] = useState(null);
  // Arrives after the figures, like insights — an LLM outage must never delay
  // or blank the numbers.
  const [narrative, setNarrative] = useState(null);
  const [reanalysing, setReanalysing] = useState(false);
  const [lastAnalysedAt, setLastAnalysedAt] = useState(null);
  // Its own fetch: cash flow needs Payments, Bank Transactions and Invoices that
  // no other tab requires, so nothing else pays for them.
  const [cashflow, setCashflow] = useState({ status: 'idle', data: null, error: '' });
  // Which month the Budget Variance tab compares — a month key, or 'ytd'. Defaults
  // to the current month on load (see fetchBudget), matching Xero's own report,
  // which is titled "For the month ended <current month>".
  const [varianceMonth, setVarianceMonth] = useState('');

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
      setError(err.message || 'Could not load the dashboard');
    } finally {
      setRefreshing(false);
    }
  }







  useEffect(() => { fetchSummary(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeTenantId) fetchSummary();
    // Budget vs Actual is per-organisation, so a tenant switch invalidates it —
    // refetch if it's on screen, otherwise let the lazy loader pick it up.
    if (tab === 'budget' || tab === 'variance') fetchBudget();
    else setBudget({ status: 'idle', data: null, error: '' });
    if (['overview', 'revenue', 'banking', 'profit', 'analysis'].includes(tab)) fetchPerf();
    else setPerf({ status: 'idle', data: null, error: '' });
  }, [activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    tickRef.current = setInterval(() => forceTick(t => t + 1), 15000);
    return () => clearInterval(tickRef.current);
  }, []);

  // Lazy tab loaders — only fire the first time a tab is opened.
  useEffect(() => {
    if (tab === 'banking' && banking.status === 'idle') {
      setBanking(s => ({ ...s, status: 'loading' }));
      api.get(`/xero-reports/bank-accounts${activeTenantId ? `?tenantId=${activeTenantId}` : ''}`)
        .then(d => setBanking({ status: 'done', data: d.bankAccounts || [], error: '' }))
        .catch(err => setBanking({ status: 'done', data: [], error: err.message }));
    }
    if (tab === 'contacts' && contacts.status === 'idle') {
      setContacts(s => ({ ...s, status: 'loading' }));
      api.get(`/xero-reports/contacts${activeTenantId ? `?tenantId=${activeTenantId}` : ''}`)
        .then(d => setContacts({ status: 'done', data: d.contacts || [], error: '' }))
        .catch(err => setContacts({ status: 'done', data: [], error: err.message }));
    }
    // Both budget tabs share one fetch and one cache entry — the Budget Variance
    // view is a different presentation of the same merged data, not a second call.
    if ((tab === 'budget' || tab === 'variance') && budget.status === 'idle') fetchBudget();
    if (['overview', 'revenue', 'banking', 'profit', 'analysis'].includes(tab) && perf.status === 'idle') fetchPerf();
    if (tab === 'cashflow' && cashflow.status === 'idle') fetchCashflow();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  function fetchCashflow(opts = {}) {
    setCashflow(s => ({ ...s, status: 'loading', error: '' }));
    const params = new URLSearchParams();
    if (activeTenantId) params.set('tenantId', activeTenantId);
    const range = opts.range !== undefined ? opts.range : perfRange;
    if (range) { params.set('from', range.from); params.set('to', range.to); }
    else       { params.set('preset', opts.preset || perfPreset); }
    if (opts.force) params.set('force', 'true');
    api.get(`/xero-reports/cash-flow?${params.toString()}`)
      .then(d => setCashflow({ status: 'done', data: d, error: '' }))
      .catch(err => setCashflow({ status: 'done', data: null, error: err.message }));
  }

  // The period the page is currently showing, as query params. Shared so the
  // commentary can never be generated for a different span from the figures.
  function periodParams(opts = {}) {
    const params = new URLSearchParams();
    if (activeTenantId) params.set('tenantId', activeTenantId);
    const range  = opts.range !== undefined ? opts.range : perfRange;
    const preset = opts.preset || perfPreset;
    if (range) { params.set('from', range.from); params.set('to', range.to); }
    else       { params.set('preset', preset); }
    return params;
  }

  function fetchPerf(opts = {}) {
    setPerf(s => ({ ...s, status: 'loading', error: '' }));
    const params = periodParams(opts);
    if (opts.force) params.set('force', 'true');
    // Only Banking renders cash in/out. Asking for it elsewhere would make
    // getBankSummary split a long period into 365-day windows for a number
    // nothing displays.
    if (tab === 'banking') params.set('cashFlow', 'true');
    // Top customers needs an invoice fetch, so only the Revenue tab asks for it.
    if (tab === 'revenue') params.set('customers', 'true');
    api.get(`/xero-reports/performance?${params.toString()}`)
      .then(d => {
        setPerf({ status: 'done', data: d, error: '' });
        // The server already resolved exactly which months this period covers,
        // so the panels span all of them. Narrowing further is done by changing
        // the period itself, not by a second control fighting the first.
        setMonthFrom(0);
        setMonthTo(Math.max(0, (d.months || []).length - 1));
      })
      .catch(err => setPerf({ status: 'done', data: null, error: err.message }));

    // Commentary arrives after the numbers, never blocking them — but it must
    // describe the SAME period, so it takes the identical params.
    const ip = new URLSearchParams(params);
    setInsights(null); // clear stale commentary while the new period loads
    setNarrative(null);
    fetchAnalysis(ip);
  }

  function fetchBudget(opts = {}) {
    setBudget(s => ({ ...s, status: 'loading', error: '' }));
    const params = new URLSearchParams();
    if (activeTenantId) params.set('tenantId', activeTenantId);
    if (opts.force) params.set('force', 'true');
    api.get(`/xero-reports/budget-variance?${params.toString()}`)
      .then(d => {
        setBudget({ status: 'done', data: d, error: '' });
        // Keep an existing selection if it still exists in this org's fiscal year,
        // otherwise land on the current month — the first one still on budget.
        setVarianceMonth(prev => {
          if (prev === 'ytd' || (d.months || []).some(m => m.key === prev)) return prev;
          return (d.months || []).find(m => m.source === 'budget')?.key || d.months?.[0]?.key || '';
        });
      })
      .catch(err => setBudget({ status: 'done', data: null, error: err.message }));
  }

  function viewStatement(account) {
    setSelectedBankAccount(account);
    setStatement({ status: 'loading', data: [], error: '' });
    const params = new URLSearchParams({ accountId: account.accountId });
    if (activeTenantId) params.set('tenantId', activeTenantId);
    api.get(`/xero-reports/bank-transactions?${params.toString()}`)
      .then(d => setStatement({ status: 'done', data: d.transactions || [], error: '' }))
      .catch(err => setStatement({ status: 'done', data: [], error: err.message }));
  }

  // Balances arrive keyed by name from the Bank Summary; the accounts list is
  // keyed by id. Built once rather than per row.
  const bankBalances = useMemo(
    () => balancesByName(perf.data?.cash?.accounts || []),
    [perf.data]);

  // Both AI fetches in one place. `extra` carries the month range when the reader
  // has narrowed it, so the commentary describes the span they are looking at —
  // a narrative sitting above numbers it is not describing is worse than none.
  function fetchAnalysis(baseParams, { reanalyse = false } = {}) {
    const q = new URLSearchParams(baseParams);
    if (reanalyse) q.set('reanalyse', 'true');
    const months = perf.data?.months;
    if (months?.length && (monthFrom > 0 || monthTo < months.length - 1)) {
      q.set('from', months[monthFrom].key);
      q.set('to',   months[monthTo].key);
      q.delete('preset');
      q.delete('window');
    }
    return Promise.allSettled([
      api.get(`/xero-reports/variance-insights?${q.toString()}`).then(d => setInsights(d)),
      api.get(`/xero-reports/narrative?${q.toString()}`).then(d => setNarrative(d)),
    ]).then(() => setLastAnalysedAt(new Date().toISOString()));
  }

  async function reanalyse() {
    setReanalysing(true);
    setInsights(null);
    setNarrative(null);
    try { await fetchAnalysis(periodParams(), { reanalyse: true }); }
    finally { setReanalysing(false); }
  }

  const filteredContacts = useMemo(() => {
    if (!contacts.data) return [];
    const q = contactSearch.trim().toLowerCase();
    if (!q) return contacts.data;
    return contacts.data.filter(c => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
  }, [contacts.data, contactSearch]);

  if (data === null && !error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 32 }}>
        <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
        Loading dashboard...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <div className="page-header"><h1>Dashboard</h1></div>
        <div className="alert alert-error"><span className="alert-icon">✕</span>{error}</div>
      </div>
    );
  }

  if (!data.connected) {
    return (
      <div>
        <div className="page-header">
          <h1>Dashboard</h1>
          <p>Live financial data pulled read-only from your connected Xero organisation.</p>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 34, marginBottom: 12 }}>🔗</div>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>No Xero connection yet</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18, maxWidth: 380, marginInline: 'auto' }}>
            This dashboard reads from whatever connection you already set up — nothing to configure here.
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
          <h1>Dashboard</h1>
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
          <button className="btn btn-outline btn-sm" disabled={refreshing} onClick={() => {
            fetchSummary({ force: true });
            if (['overview', 'revenue', 'banking', 'profit', 'analysis'].includes(tab)) fetchPerf({ force: true });
          }}>
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
        {TABS.map(t => (
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

      {['overview', 'revenue', 'cashflow', 'profit', 'analysis'].includes(tab) && perf.data && !perf.error && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                       gap: 14, flexWrap: 'wrap', marginBottom: 16, padding: '12px 16px' }}>
          <MonthRange months={perf.data.months} from={monthFrom} to={monthTo}
                      label={perf.data.period?.label}
                      chunks={perf.data.period?.chunks}
                      preset={perfRange ? 'custom' : perfPreset}
                      onPreset={p => {
                        if (p === 'custom') return;      // range pickers drive that
                        setPerfPreset(p); setPerfRange(null);
                        fetchPerf({ preset: p, range: null });
                        setCashflow({ status: 'idle', data: null, error: '' });
                      }}
                      onRange={(from, to) => {
                        const r = { from, to };
                        setPerfRange(r); fetchPerf({ range: r });
                        setCashflow({ status: 'idle', data: null, error: '' });
                      }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
              {perf.data.months.filter(m => m.source === 'actual').length} closed · {perf.data.months.filter(m => m.source === 'budget').length} budgeted
            </span>
            <button className="btn btn-outline btn-sm" disabled={perf.status === 'loading'} onClick={() => fetchPerf({ force: true })}>
              {perf.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
            </button>
          </div>
        </div>
      )}

      {tab === 'overview' && (
        <>
          {perf.status === 'loading' && !perf.data && (
            <div className="card" style={{ padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>Loading performance data…</div>
          )}
          {perf.error && (
            <div className="alert alert-error" style={{ marginBottom: 16 }}><span className="alert-icon">✕</span>{perf.error}</div>
          )}
          {perf.data && !perf.error && (
            <OverviewPanel data={perf.data} from={monthFrom} to={monthTo}
                           insights={insights} summary={data} narrative={narrative}
                           onOpenAnalysis={() => setTab('analysis')} />
          )}
        </>
      )}

      {tab === 'analysis' && (
        <>
          {perf.status === 'loading' && !perf.data && (
            <div className="card" style={{ padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>Loading figures…</div>
          )}
          {perf.error && (
            <div className="alert alert-error"><span className="alert-icon">✕</span>{perf.error}</div>
          )}
          {perf.data && !perf.error && (
            <AnalysisPanel
              data={perf.data} from={monthFrom} to={monthTo}
              insights={insights} narrative={narrative}
              onReanalyse={reanalyse} reanalysing={reanalysing} lastAnalysedAt={lastAnalysedAt}
            />
          )}
        </>
      )}

      {tab === 'revenue' && (
        <>
          {perf.status === 'loading' && !perf.data && (
            <div className="card" style={{ padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>Loading revenue data…</div>
          )}
          {perf.error && (
            <div className="alert alert-error"><span className="alert-icon">✕</span>{perf.error}</div>
          )}
          {perf.data && !perf.error && (
            <RevenuePanel data={perf.data} from={monthFrom} to={monthTo}
                          selectedLine={revenueLine} onSelectLine={setRevenueLine} />
          )}
        </>
      )}

      {tab === 'profit' && (
        <>
          {perf.status === 'loading' && !perf.data && (
            <div className="card" style={{ padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>Loading profitability data…</div>
          )}
          {perf.error && (
            <div className="alert alert-error"><span className="alert-icon">✕</span>{perf.error}</div>
          )}
          {perf.data && !perf.error && (
            <ProfitabilityPanel data={perf.data} from={monthFrom} to={monthTo} />
          )}
        </>
      )}

      {tab === 'cashflow' && (
        <>
          {cashflow.status === 'loading' && !cashflow.data && (
            <div className="card" style={{ padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>Loading cash flow…</div>
          )}
          {cashflow.error && (
            <div className="alert alert-error"><span className="alert-icon">✕</span>{cashflow.error}</div>
          )}
          {cashflow.data && !cashflow.error && <CashFlowPanel data={cashflow.data} />}
        </>
      )}


      {tab === 'banking' && (
        <>
          {/* Moved from Overview: cash movement belongs with the accounts it
              moved through. Reads the cached performance payload, so it costs no
              extra Xero call. */}
          {perf.data?.cash?.available && (
            <div className="card" style={{ display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 3 }}>Cash at bank</div>
                <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(perf.data.cash.total, currency)}</div>
              </div>
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', fontSize: 12.5 }}>
                <div><span style={{ color: 'var(--text-muted)' }}>Cash in </span><b style={{ color: 'var(--success)' }}>{fmtMoney(perf.data.cash.cashIn, currency)}</b></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Cash out </span><b style={{ color: 'var(--danger)' }}>{fmtMoney(perf.data.cash.cashOut, currency)}</b></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Net </span><b style={{ color: perf.data.cash.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmtMoney(perf.data.cash.net, currency)}</b></div>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                {perf.data.fiscalYear?.label} · Xero Bank Summary
              </div>
            </div>
          )}

          {/* Both charts read perf.data.cash.accounts, which this tab already
              receives — no extra Xero call. Until now that array was fetched
              and discarded, so the balance of each account was never shown. */}
          {perf.data?.cash?.accounts?.length > 0 && (
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
              <div className="card" style={{ flex: 6, minWidth: 320 }}>
                <div className="card-title">Where the money sits</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Closing balance per account, and its share of total cash.
                </div>
                <BarList
                  currency={currency}
                  showPctOfTotal
                  items={perf.data.cash.accounts
                    .filter(a => a.balance !== 0)
                    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
                    .map(a => ({ label: a.name, value: a.balance }))}
                />
              </div>

              <div className="card" style={{ flex: 6, minWidth: 320 }}>
                <div className="card-title">Movement by account</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Which account is actually doing the work this period.
                </div>
                <GroupedMonthlyBars
                  rawLabels
                  currency={currency}
                  months={perf.data.cash.accounts.map(a => ({ key: a.name, label: a.name }))}
                  series={[
                    { label: 'In',  color: 'var(--success)', values: perf.data.cash.accounts.map(a => a.cashIn  || 0) },
                    { label: 'Out', color: 'var(--danger)',  values: perf.data.cash.accounts.map(a => a.cashOut || 0) },
                  ]}
                />
                <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 10.5, color: 'var(--text-muted)' }}>
                  <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--success)', marginRight: 5 }} />In</span>
                  <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--danger)', marginRight: 5 }} />Out</span>
                </div>
              </div>
            </div>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ marginBottom: 2 }}>Bank &amp; Cash Accounts</div>
            <div className="card-subtitle" style={{ marginBottom: 2 }}>Click an account for its transaction statement.</div>
            <SourceNote>Xero Accounts API (Type=BANK)</SourceNote>
            {banking.status !== 'done' ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
            ) : banking.error ? (
              <div className="alert alert-error"><span className="alert-icon">✕</span>{banking.error}</div>
            ) : banking.data.length === 0 ? (
              <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">🏦</div><div>No bank accounts found in Xero</div></div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                    <th style={{ padding: '6px 10px' }}>Name</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>Balance</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>In</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>Out</th>
                    <th style={{ padding: '6px 10px' }}>Account Number</th><th style={{ padding: '6px 10px' }}>Currency</th>
                    <th style={{ padding: '6px 10px' }}>Status</th><th style={{ padding: '6px 10px' }}></th>
                  </tr></thead>
                  <tbody>{banking.data.map(a => {
                    const bal = balanceFor(bankBalances, a);
                    return (
                    <tr key={a.accountId} style={{ borderTop: '1px solid var(--border)', background: selectedBankAccount?.accountId === a.accountId ? 'var(--bg-hover)' : undefined }}>
                      <td style={{ padding: '9px 10px' }}>
                        {a.name}
                        {a.code ? <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> · {a.code}</span> : null}
                      </td>
                      {/* Em dash when the name join misses, never a wrong number. */}
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                        {bal ? fmtMoney(bal.balance, a.currency || currency) : '—'}
                      </td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: bal?.cashIn ? 'var(--success)' : 'var(--text-muted)' }}>
                        {bal?.cashIn ? fmtMoney(bal.cashIn, a.currency || currency) : '—'}
                      </td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: bal?.cashOut ? 'var(--danger)' : 'var(--text-muted)' }}>
                        {bal?.cashOut ? fmtMoney(bal.cashOut, a.currency || currency) : '—'}
                      </td>
                      <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{a.accountNumber || '—'}</td>
                      <td style={{ padding: '9px 10px' }}>{a.currency || '—'}</td>
                      <td style={{ padding: '9px 10px' }}><span className={`badge ${a.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>{a.status || '—'}</span></td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => viewStatement(a)}>View Transactions</button>
                      </td>
                    </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
          </div>

          {selectedBankAccount && (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>Statement — {selectedBankAccount.name}</div>
                <button type="button" className="btn btn-sm" style={{ background: 'none', color: 'var(--text-muted)', border: 'none' }} onClick={() => setSelectedBankAccount(null)}>✕ Close</button>
              </div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>Most recent transactions for this account</div>
              <SourceNote>Xero Bank Transactions + Payments API — bill/invoice payments show up here too, not just raw bank entries</SourceNote>
              {/* Unreconciled items are the clearest sign the books and the bank
                  disagree. The flag was already on every row, but as a faint dash
                  with no total — easy to scroll past. */}
              {statement.status === 'done' && !statement.error && statement.data.length > 0 && (() => {
                const un = statement.data.filter(t => !t.isReconciled).length;
                return un === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--success)', marginBottom: 10 }}>
                    ✓ All {statement.data.length} transactions shown are reconciled.
                  </div>
                ) : (
                  <div style={{ fontSize: 11.5, color: 'var(--warning)', marginBottom: 10, lineHeight: 1.5 }}>
                    ▲ {un} of {statement.data.length} transactions shown are not reconciled — the books and the
                    bank statement disagree until they are matched in Xero.
                  </div>
                );
              })()}
              {statement.status !== 'done' ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
              ) : statement.error ? (
                <div className="alert alert-error"><span className="alert-icon">✕</span>{statement.error}</div>
              ) : statement.data.length === 0 ? (
                <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">📄</div><div>No transactions found for this account</div></div>
              ) : (
                <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                      <th style={{ padding: '6px 10px' }}>Date</th><th style={{ padding: '6px 10px' }}>Type</th>
                      <th style={{ padding: '6px 10px' }}>Contact</th><th style={{ padding: '6px 10px' }}>Reference</th>
                      <th style={{ padding: '6px 10px' }}>Source</th>
                      <th style={{ padding: '6px 10px' }}>Reconciled</th><th style={{ padding: '6px 10px', textAlign: 'right' }}>Amount</th>
                    </tr></thead>
                    <tbody>{statement.data.map(t => (
                      <tr key={t.transactionId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{formatDateTime(t.date, user?.timezone).split(',')[0]}</td>
                        <td style={{ padding: '9px 10px' }}><span className={`badge ${t.type === 'Money In' ? 'badge-green' : 'badge-red'}`}>{t.type}</span></td>
                        <td style={{ padding: '9px 10px' }}>{t.contact}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{t.reference || '—'}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{t.source === 'payment' ? 'Invoice payment' : 'Bank'}</td>
                        <td style={{ padding: '9px 10px' }}>
                          {t.isReconciled
                            ? <span style={{ color: 'var(--success)' }}>✓</span>
                            : <span className="badge badge-yellow" style={{ fontSize: 9.5 }}>not matched</span>}
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: t.type === 'Money In' ? 'var(--success)' : 'var(--danger)' }}>
                          {t.type === 'Money In' ? '+' : '−'}{fmtMoney(t.total, currency)}
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}


      {tab === 'contacts' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>Contacts</div>
            <SearchBox value={contactSearch} onChange={setContactSearch} placeholder="Search by name or email..." />
          </div>
          <SourceNote>Xero Contacts API</SourceNote>
          {contacts.status !== 'done' ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
          ) : contacts.error ? (
            <div className="alert alert-error"><span className="alert-icon">✕</span>{contacts.error}</div>
          ) : filteredContacts.length === 0 ? (
            <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">👥</div><div>No contacts match</div></div>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                  <th style={{ padding: '6px 10px' }}>Name</th><th style={{ padding: '6px 10px' }}>Email</th>
                  <th style={{ padding: '6px 10px' }}>Customer</th><th style={{ padding: '6px 10px' }}>Supplier</th>
                  <th style={{ padding: '6px 10px' }}>Status</th>
                </tr></thead>
                <tbody>{filteredContacts.map(c => (
                  <tr key={c.contactId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '9px 10px' }}>{c.name}</td>
                    <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{c.email || '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{c.isCustomer ? '✓' : '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{c.isSupplier ? '✓' : '—'}</td>
                    <td style={{ padding: '9px 10px' }}><span className={`badge ${c.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>{c.status || '—'}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}


      {tab === 'budget' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>Budget vs Actual</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>
                {budget.data?.fiscalYear?.label || 'Current financial year by month'}
              </div>
              <SourceNote>Xero Profit &amp; Loss (actuals) + Budget Summary — Overall Budget</SourceNote>
            </div>
            <button className="btn btn-outline btn-sm" disabled={budget.status === 'loading'} onClick={() => fetchBudget({ force: true })}>
              {budget.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
            </button>
          </div>

          {budget.status === 'loading' && <div style={{ padding: 28, color: 'var(--text-muted)', fontSize: 13 }}>Loading budget report...</div>}

          {budget.error && (
            <div className="alert alert-error" style={{ marginTop: 14 }}><span className="alert-icon">✕</span>{budget.error}</div>
          )}

          {budget.status === 'done' && !budget.error && budget.data && (() => {
            const d   = budget.data;
            const cur = d.organisation?.currency || currency;
            const k   = d.kpis;
            const tiles = [
              { label: `Actual to date (${k.monthsElapsed}mo)`, value: k.ytdActualNet, hint: 'Net profit, completed months' },
              { label: `Budget remaining (${k.monthsTotal - k.monthsElapsed}mo)`, value: k.restOfYearNet, hint: 'Net profit still budgeted' },
              { label: 'Full-year forecast', value: k.forecastNet, hint: 'Actual to date + budget ahead' },
            ];
            return (
              <>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '18px 0 4px' }}>
                  {tiles.map(t => (
                    <div key={t.label} className="card" style={{ flex: 1, minWidth: 180, background: 'var(--bg-secondary)' }}>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                      <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t.value < 0 ? 'var(--danger)' : 'var(--success)' }}>
                        {fmtMoney(t.value, cur)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{t.hint}</div>
                    </div>
                  ))}
                  <div className="card" style={{ flex: 1, minWidth: 180, background: 'var(--bg-secondary)' }}>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>Progress</div>
                    <div style={{ fontSize: 21, fontWeight: 800 }}>{k.monthsElapsed} <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>of {k.monthsTotal} months</span></div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
                      {d.months.find(m => m.source === 'budget')?.label || '—'} onward is budget
                    </div>
                  </div>
                </div>

                <BudgetGrid months={d.months} rows={d.rows} />

                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
                  A month shows actuals only once it has fully closed — the current month reads as budget, since its
                  income may be invoiced before its costs are entered. Section names come from Xero&apos;s standard
                  Profit &amp; Loss layout; a custom report layout in Xero may label them differently.
                </div>
              </>
            );
          })()}
        </div>
      )}

      {tab === 'variance' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>Budget Variance</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>
                {varianceMonth === 'ytd'
                  ? `Year to date — ${budget.data?.kpis?.monthsElapsed ?? 0} completed month(s)`
                  : `For the month ended ${budget.data?.months?.find(m => m.key === varianceMonth)?.label || '—'}`}
              </div>
              <SourceNote>Xero Profit &amp; Loss (actuals) vs Budget Summary — variance computed per Xero&apos;s formula</SourceNote>
            </div>
            <button className="btn btn-outline btn-sm" disabled={budget.status === 'loading'} onClick={() => fetchBudget({ force: true })}>
              {budget.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
            </button>
          </div>

          {budget.status === 'loading' && <div style={{ padding: 28, color: 'var(--text-muted)', fontSize: 13 }}>Loading variance report...</div>}
          {budget.error && <div className="alert alert-error" style={{ marginTop: 14 }}><span className="alert-icon">✕</span>{budget.error}</div>}

          {budget.status === 'done' && !budget.error && budget.data && (() => {
            const d   = budget.data;
            const cur = d.organisation?.currency || currency;
            // A stale selection (tenant switched mid-render, say) must not index
            // past the array — fall back to the first month rather than crash.
            const found = d.months.findIndex(m => m.key === varianceMonth);
            const idx   = found >= 0 ? found : 0;

            // Either one month's own figures, or the year-to-date rollup the
            // backend already computed over the completed months.
            const periods = varianceMonth === 'ytd'
              ? [{ label: 'Year to date', of: r => ({ actual: r.actualToDate, budget: r.budgetToDate, variance: r.variance, variancePct: r.variancePct }) }]
              : [{ label: d.months[idx].label, of: r => r.monthly[idx] }];

            const net = d.rows.find(r => r.kind === 'summary' && /^net (profit|loss)/i.test(r.label));
            const nv  = net ? periods[0].of(net) : null;

            return (
              <>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '14px 0 4px' }}>
                  {d.months.map(m => (
                    <button key={m.key} type="button" onClick={() => setVarianceMonth(m.key)} style={{
                      padding: '5px 10px', fontSize: 11.5, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
                      border: `1px solid ${varianceMonth === m.key ? 'transparent' : 'var(--border)'}`,
                      background: varianceMonth === m.key ? 'var(--accent-gradient)' : 'transparent',
                      color: varianceMonth === m.key ? '#fff' : (m.source === 'actual' ? 'var(--text-secondary)' : 'var(--text-muted)'),
                    }}>{m.label}</button>
                  ))}
                  <button type="button" onClick={() => setVarianceMonth('ytd')} style={{
                    padding: '5px 10px', fontSize: 11.5, fontWeight: 700, borderRadius: 7, cursor: 'pointer',
                    border: `1px solid ${varianceMonth === 'ytd' ? 'transparent' : 'var(--border)'}`,
                    background: varianceMonth === 'ytd' ? 'var(--accent-gradient)' : 'transparent',
                    color: varianceMonth === 'ytd' ? '#fff' : 'var(--text-muted)',
                  }}>Year to date</button>
                </div>

                {nv && (
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '16px 0 2px' }}>
                    {[
                      { label: 'Net profit actual', value: fmtMoney(nv.actual, cur), color: undefined },
                      { label: 'Net profit budget', value: fmtMoney(nv.budget, cur), color: undefined },
                      { label: 'Variance', value: `${nv.variance > 0 ? '+' : ''}${fmtMoney(nv.variance, cur)}`,
                        color: nv.variance === 0 ? undefined : nv.variance > 0 ? 'var(--success)' : 'var(--danger)' },
                      { label: 'Variance %', value: nv.variance === 0 || nv.variancePct === null ? '—' : `${(nv.variancePct * 100).toFixed(2)}%`,
                        color: nv.variance === 0 ? undefined : nv.variance > 0 ? 'var(--success)' : 'var(--danger)' },
                    ].map(t => (
                      <div key={t.label} className="card" style={{ flex: 1, minWidth: 165, background: 'var(--bg-secondary)' }}>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>{t.label}</div>
                        <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t.color }}>{t.value}</div>
                      </div>
                    ))}
                  </div>
                )}

                <VarianceTable rows={d.rows} periods={periods} currency={cur} />

                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
                  Variance is actual minus budget; the percentage divides that by the absolute budget, so a negative
                  budget still reads with Xero&apos;s sign. An on-budget line and a line with no budget both show
                  &ldquo;-&rdquo; rather than 0.00%. Unlike the monthly grid, this view compares the current month using
                  the actuals booked so far &mdash; so a part-elapsed month can look far ahead of budget simply because
                  its costs haven&apos;t been entered yet.
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
