import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatRelative } from '../utils/formatDate';
import { fmtMoney, fmtMoneyShort } from '../utils/format';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { useEdgeFade } from '../utils/useEdgeFade';
import { useViewMode } from '../context/ViewModeContext';
import { MonthRange, OverviewPanel, RevenuePanel, CashFlowPanel, ProfitabilityPanel, AnalysisPanel } from '../components/performance/PerformancePanels';
import { balancesByName } from './xero-insights/balances';
import { KpiCard } from './xero-insights/bits';
import BankingTab from './xero-insights/BankingTab';
import ContactsTab from './xero-insights/ContactsTab';
import BudgetTab from './xero-insights/BudgetTab';
import VarianceTab from './xero-insights/VarianceTab';

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



// P&L/Cash Flow are Xero Report-API-backed, and Xero rejects >365-day report
// ranges outright — the backend silently clamps a very wide request (like
// "All Time") to the most recent ~10 years instead. Showing the range the
// API actually used (echoed back on the response) rather than the raw
// preset's own range keeps "All Time" from implying more than it delivers.



// ── Bar chart: any two values compared — interactive hover ──────────────────
// Generic enough to serve Receivables/Payables (Overview), Income/Expenses
// (P&L), and Cash In/Cash Out (Cash Flow) — same visual language throughout.

// ── Aging bars: outstanding amount bucketed by how soon it's due ────────────
// Mirrors Xero's own "Invoices owed to you" / "Bills to pay" widgets, just
// with fixed day windows instead of Xero's dynamic weekly columns.

// ── Donut: invoice status breakdown — interactive hover ─────────────────────












export default function XeroInsights() {
  const { user }   = useAuth();
  const navigate   = useNavigate();
  const { isMobile } = useViewMode();
  const [tabsRef, tabEdges] = useEdgeFade();
  const [monthsRef, monthEdges] = useEdgeFade();
  const [data,      setData]      = useState(null); // null = loading
  const [error,     setError]     = useState('');
  const [refreshing,setRefreshing]= useState(false);
  const [tab,       setTab]       = useState('overview');
  const [activeTenantId, setActiveTenantId] = useState(null);
  const [, forceTick] = useState(0); // re-render every 15s so "synced Xs ago" stays live


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
  // Phones open on six months, desktops on financial-year-to-date. The charts
  // switch to a 520px minimum once a period exceeds six months (see
  // PerformancePanels), which on a 390px screen means every trend chart has to
  // be scrolled sideways to read — and fy-ytd passes six months for half the
  // year. Six also roughly halves the payload, which Xero now bills by volume.
  //
  // Read once, at mount, and deliberately not persisted: the period control is
  // right there, a choice made during a session is respected, and the next
  // visit starts from the default again rather than silently reintroducing the
  // side-scrolling. Note this means a phone and a desktop show different
  // default trend windows for the same page — the period label above the charts
  // always says which, so it reads as a choice rather than a discrepancy.
  const [perfPreset, setPerfPreset] = useState(() => (isMobile ? 'last-6' : 'fy-ytd'));
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
  // 'ytd', not '', and the empty default was doing real damage. Nothing matched
  // '' so the table fell through to index 0 — April, the first month of the
  // financial year, which has no actuals — while the heading above it rendered
  // "For the month ended —", and the PDF export read the same '' as falsy and
  // reported Year to date. Three different answers to which period this is.
  //
  // Year to date is also simply the right thing to open on: it rolls up the
  // completed months, where a single unelapsed month is a wall of -100%.
  const [varianceMonth, setVarianceMonth] = useState('ytd');

  async function fetchSummary(opts = {}) {
    if (opts.force) setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (opts.force) params.set('force', 'true');
      if (activeTenantId) params.set('tenantId', activeTenantId);
      const d = await api.get(`/xero-reports/summary?${params.toString()}`);
      setData(d);
      setError('');
      // The mount fetch has just loaded the default tenant: record it so the
      // tenant effect does not treat learning its id as a switch.
      if (d.activeTenantId && loadedTenantRef.current === null) loadedTenantRef.current = d.activeTenantId;
      if (d.activeTenantId) setActiveTenantId(d.activeTenantId);
    } catch (err) {
      setError(err.message || 'Could not load the dashboard');
    } finally {
      setRefreshing(false);
    }
  }







  useEffect(() => { fetchSummary(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A tenant is "loaded" once its summary is on screen. The first summary
  // resolves the default tenant, which used to re-trigger this effect: the
  // summary was fetched a second time and the performance report a third
  // (the tab effect below had already asked once). Now this runs only for a
  // real switch to a different organisation.
  const loadedTenantRef = useRef(null);
  useEffect(() => {
    if (!activeTenantId || loadedTenantRef.current === activeTenantId) return;
    loadedTenantRef.current = activeTenantId;
    fetchSummary();
    // Budget vs Actual is per-organisation, so a tenant switch invalidates it —
    // refetch if it's on screen, otherwise let the lazy loader pick it up.
    if (tab === 'budget' || tab === 'variance') fetchBudget();
    else setBudget({ status: 'idle', data: null, error: '' });
    if (['overview', 'revenue', 'banking', 'profit', 'analysis'].includes(tab)) fetchPerf();
    else setPerf({ status: 'idle', data: null, error: '' });
  }, [activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only to keep the "synced Xs ago" labels honest — no fetching. It still
  // re-rendered this whole page every 15 s in a backgrounded tab, and the
  // labels are recomputed on return anyway, so it pauses while hidden.
  useVisiblePolling(() => forceTick(t => t + 1), 15000);

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
          {/* The org card below is hidden on a phone, so the one thing worth
              keeping from it — which organisation these figures belong to —
              moves up here. Its other contents (country, year end) are setup
              facts available in Settings, and the currency still rides along on
              every figure. */}
          <p>{isMobile
            ? `${organisation.name} · Connected via Xero`
            : 'Live financial data pulled read-only from your connected Xero organisation.'}</p>
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

      <div className="card org-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, margin: '18px 0' }}>
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

      {/* Three-across and abbreviated on a phone (see .mobile-mode .kpi-row).
          Stacked full-width, these three cards ran to about 270px — so the tab
          strip and every chart began below the fold, and the page opened on
          nothing but summary. */}
      <div className="grid-3 kpi-row" style={{ marginBottom: 20 }}>
        <KpiCard
          icon="↗" tone="success"
          label={isMobile ? 'Receivables' : 'Total Receivables'}
          value={isMobile ? fmtMoneyShort(kpis.totalReceivables, currency) : fmtMoney(kpis.totalReceivables, currency)}
          sub={isMobile
            ? `${kpis.receivablesCount} invoice${kpis.receivablesCount !== 1 ? 's' : ''}`
            : `${kpis.receivablesCount} sales invoice${kpis.receivablesCount !== 1 ? 's' : ''} awaiting payment`}
        />
        <KpiCard
          icon="▣" tone="danger"
          label={isMobile ? 'Payables' : 'Total Payables'}
          value={isMobile ? fmtMoneyShort(kpis.totalPayables, currency) : fmtMoney(kpis.totalPayables, currency)}
          sub={isMobile
            ? `${kpis.payablesCount} bill${kpis.payablesCount !== 1 ? 's' : ''}`
            : `${kpis.payablesCount} bill${kpis.payablesCount !== 1 ? 's' : ''} awaiting payment`}
        />
        <KpiCard
          icon="⏱" tone="warning"
          label={isMobile ? 'Overdue' : 'Overdue Amount'}
          value={isMobile ? fmtMoneyShort(kpis.overdueAmount, currency) : fmtMoney(kpis.overdueAmount, currency)}
          sub={isMobile
            ? `${kpis.statusBreakdown.overdue} past due`
            : `${kpis.statusBreakdown.overdue} invoice${kpis.statusBreakdown.overdue !== 1 ? 's' : ''} past due`}
        />
      </div>

      {/* Gradient overlays rather than a CSS mask on the strip itself: a mask
          would fade the strip's own background and border at the edge, leaving
          the rounded outline looking broken. Each only renders when there is
          actually more to scroll to on that side. */}
      <div style={{ position: 'relative', marginBottom: 18 }}>
        {tabEdges.start && (
          <div aria-hidden="true" style={{
            position: 'absolute', left: 1, top: 1, bottom: 1, width: 36, zIndex: 1,
            borderRadius: '9px 0 0 9px', pointerEvents: 'none',
            background: 'linear-gradient(to left, transparent, var(--bg-card))',
          }} />
        )}
        {tabEdges.end && (
          <div aria-hidden="true" style={{
            position: 'absolute', right: 1, top: 1, bottom: 1, width: 36, zIndex: 1,
            borderRadius: '0 9px 9px 0', pointerEvents: 'none',
            background: 'linear-gradient(to right, transparent, var(--bg-card))',
          }} />
        )}
        <div ref={tabsRef} className="mobile-scroll-x" style={{ display: 'flex', gap: 4, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, maxWidth: '100%', overflowX: 'auto' }}>
          {TABS.map(t => (
            <button key={t.key} type="button" className="tab-pill" onClick={() => setTab(t.key)} style={{
              padding: '7px 16px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
              background: tab === t.key ? 'var(--accent-gradient)' : 'transparent',
              color: tab === t.key ? '#fff' : 'var(--text-muted)',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>{t.label}</button>
          ))}
        </div>
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


      {tab === 'banking' && <BankingTab user={user} isMobile={isMobile} banking={banking} selectedBankAccount={selectedBankAccount} setSelectedBankAccount={setSelectedBankAccount} statement={statement} perf={perf} viewStatement={viewStatement} bankBalances={bankBalances} currency={currency} />}


      {tab === 'contacts' && <ContactsTab isMobile={isMobile} contacts={contacts} contactSearch={contactSearch} setContactSearch={setContactSearch} filteredContacts={filteredContacts} />}


      {tab === 'budget' && <BudgetTab budget={budget} fetchBudget={fetchBudget} currency={currency} />}

      {tab === 'variance' && <VarianceTab isMobile={isMobile} monthsRef={monthsRef} monthEdges={monthEdges} budget={budget} varianceMonth={varianceMonth} setVarianceMonth={setVarianceMonth} fetchBudget={fetchBudget} currency={currency} />}
    </div>
  );
}
