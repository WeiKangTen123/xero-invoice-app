import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import RetryAlert from '../components/RetryAlert';
import { useAuth } from '../context/AuthContext';
import { formatTime } from '../utils/formatDate';
import { fmtMoney, fmtMoneyShort } from '../utils/format';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import { useEdgeFade } from '../utils/useEdgeFade';
import { useViewMode } from '../context/ViewModeContext';
import { MonthRange, OverviewPanel, RevenuePanel, CashFlowPanel, ProfitabilityPanel, AnalysisPanel } from '../components/performance/PerformancePanels';
import { balancesByName } from './xero-insights/balances';
import { KpiCard, LiveStatus, lastLoaded } from './xero-insights/bits';
import { hasChanged, shouldRefetchTab, oldestRead, liveLabel } from './xero-insights/live';
import BankingTab from './xero-insights/BankingTab';
import BudgetTab from './xero-insights/BudgetTab';
import VarianceTab from './xero-insights/VarianceTab';
import AgeingSection from './xero-insights/AgeingSection';

// Tabs that need the performance report. Cash Flow has its own report, but its
// period bar is drawn from this one's months.
const PERF_TABS = ['overview', 'revenue', 'banking', 'profit', 'analysis', 'cashflow'];
// Tabs that show the comparison with the same months last year. It costs a
// second report from Xero (last year's months), so only these ask for it.
const COMPARE_TABS = ['overview', 'profit'];
// The ageing section's two sides. Which one is open lives in the address, like
// the tab, so a reload or a shared link opens on it.
const AGEING_SIDES = ['receivables', 'payables'];
const AGEING_IDLE = { status: 'idle', data: null, error: '' };
// How often the page asks the server whether Xero changed, while it is in
// view. The server does the watching (xero-reports/version); this only asks
// what it saw, so a minute costs nothing against the Xero allowance.
const VERSION_EVERY_MS = 60 * 1000;
// How long "Updated just now from Xero" stays on the status line.
const UPDATED_NOTICE_MS = 8000;

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
  { key: 'budget',   label: 'Budget vs Actual' },
  { key: 'variance', label: 'Budget Variance' },
];



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
  // The open tab is in the address, so a reload, a shared link or Back from
  // another page lands on it instead of on Overview. Replaced rather than
  // pushed, so Back leaves the dashboard rather than stepping through tabs.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = TABS.some(t => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'overview';
  function setTab(key) {
    const next = new URLSearchParams(searchParams);
    if (key === 'overview') next.delete('tab'); else next.set('tab', key);
    setSearchParams(next, { replace: true });
  }
  // Receivables and payables ageing, opened from the two headline cards. Null
  // while closed, and nothing is fetched until it is opened.
  const ageingSide = AGEING_SIDES.includes(searchParams.get('ageing')) ? searchParams.get('ageing') : null;
  function setAgeingSide(side) {
    const next = new URLSearchParams(searchParams);
    if (side) next.set('ageing', side); else next.delete('ageing');
    setSearchParams(next, { replace: true });
  }
  // One entry per side, so switching back to a side already loaded shows it at
  // once; the server answers either from the same cached reads anyway.
  const [ageing, setAgeing] = useState({ receivables: AGEING_IDLE, payables: AGEING_IDLE });
  // Set by a link from further down the page, so the section scrolls into view
  // when it opens; the cards sit directly above it and need no scroll.
  const scrollToAgeing = useRef(false);
  const [activeTenantId, setActiveTenantId] = useState(null);
  // The server's word on whether Xero changed (see fetchVersion): the stamp of
  // the last change it saw, when it last looked, and whether it can look at
  // all. Null until the first read for the active organisation.
  const [version, setVersion] = useState(null);
  // The change stamp as of the previous read, for the active organisation:
  // undefined before any read, so the first one records rather than reacts.
  const seenChangedAt = useRef(undefined);
  // A change seen but not yet acted on, and when the last one brought new
  // figures in (the notice shows while that is set).
  const [pendingChange, setPendingChange] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  // The change each report was last re-asked for on being opened, so a report
  // that comes back still stamped before the change — a cache entry the server
  // kept — is asked for once per change, not on every render of its tab.
  const reasked = useRef({});


  // Banking's account list, loaded lazily — the first time the tab is opened,
  // and again after a switch of organisation.
  // data starts as [] (not null) so the very first render after switching to
  // it — before the fetch effect has even fired, while status is still
  // 'idle' — never has to null-check .data.length mid-render. (A Contacts tab
  // loaded the same way; it was removed as nothing anyone used.)
  const [banking,  setBanking]  = useState({ status: 'idle', data: [], error: '' });

  // Banking tab's statement drill-down — which account, and its transactions.
  const [selectedBankAccount, setSelectedBankAccount] = useState(null);
  const [statement, setStatement] = useState({ status: 'idle', data: [], error: '' });

  // Budget vs Actual — lazily loaded like the Banking tab. `data` stays null
  // until loaded (unlike that, it's an object not a list, so there's nothing
  // meaningful to render half-populated).
  const [budget, setBudget] = useState({ status: 'idle', data: null, error: '' });
  // The budget tabs' own period, separate from the overview's. It opens on the
  // whole financial year rather than year to date: a budget is read a year at
  // a time, and the tabs had no period at all before.
  const [budgetPreset, setBudgetPreset] = useState('fy');
  const [budgetRange,  setBudgetRange]  = useState(null); // { from, to } when custom

  // One counter per report. A response is applied only if no newer request for
  // that report was made since — two quick period changes could otherwise let
  // the slower, older answer land last and sit under the newer period's label.
  // The summary, the bank account list, a bank statement and the version read
  // are counted the same way, as a switch of organisation can leave any of
  // them in flight.
  const seq = useRef({ perf: 0, cashflow: 0, budget: 0, analysis: 0, summary: 0, banking: 0, statement: 0, ageingReceivables: 0, ageingPayables: 0, version: 0 });

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
  // Which month the Budget Variance tab compares — a month key, or 'ytd'. It
  // opens on year to date; a month picked later falls back to the current month
  // when a newly loaded report no longer has it (see fetchBudget).
  //
  // 'ytd', not '', and the empty default was doing real damage. Nothing matched
  // '' so the table fell through to index 0 — April, the first month of the
  // financial year, which has no actuals — while the heading above it rendered
  // "For the month ended —", and the PDF export read the same '' as falsy and
  // reported Year to date. Three different answers to which period this is.
  //
  // Year to date is also simply the right thing to open on: it rolls up the
  // completed months, where a single unelapsed month is a wall of -100%.
  const [varianceMonth, setVarianceMonth] = useState('ytd');

  // Only the newest summary is used. It also names the active organisation, so
  // a slow one — a forced refresh of the previous organisation, say — landing
  // after a switch used to switch the page back and reload everything for it.
  // `quiet` is a re-read after a change seen in Xero: the figures stay up until
  // the new ones land, and a failure keeps them rather than putting an error
  // over figures that are still the last Xero gave.
  async function fetchSummary(opts = {}) {
    const n = ++seq.current.summary;
    const fresh = () => n === seq.current.summary;
    if (opts.force) setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (opts.force) params.set('force', 'true');
      if (activeTenantId) params.set('tenantId', activeTenantId);
      const d = await api.get(`/xero-reports/summary?${params.toString()}`);
      if (!fresh()) return;
      setData(d);
      setError('');
      // The mount fetch has just loaded the default tenant: record it so the
      // tenant effect does not treat learning its id as a switch.
      if (d.activeTenantId && loadedTenantRef.current === null) loadedTenantRef.current = d.activeTenantId;
      if (d.activeTenantId) setActiveTenantId(d.activeTenantId);
    } catch (err) {
      if (fresh() && !opts.quiet) setError(err.message || 'Could not load the dashboard');
    } finally {
      // A superseded refresh leaves the spinner to the request that replaced
      // it, which clears it when it lands.
      if (fresh()) setRefreshing(false);
    }
  }







  // Whether Xero changed since the reports on screen were read, from the
  // server: it watches Xero itself (new journals, a budget edit) and drops the
  // company's cached reports when it sees a change, so after one a plain
  // fetch of each is fresh — no force, and no second read of Xero from here.
  // The first read for an organisation records where the stamp stands; a
  // later one that finds it moved asks for everything on screen again (see
  // refetchShown). `adopt` records without asking, after a manual Refresh
  // that has already brought everything up to date. A failed read is not news
  // about Xero: the status line keeps the last answer, and the next minute
  // asks again.
  async function fetchVersion({ adopt = false } = {}) {
    const n = ++seq.current.version;
    try {
      const params = new URLSearchParams();
      if (activeTenantId) params.set('tenantId', activeTenantId);
      const v = await api.get(`/xero-reports/version?${params.toString()}`);
      if (n !== seq.current.version) return;
      setVersion(v);
      const prev = seenChangedAt.current;
      seenChangedAt.current = v.changedAt || null;
      if (!adopt && hasChanged(prev, v.changedAt)) setPendingChange(v.changedAt);
    } catch (_) {
      // See above: nothing on screen changes for it.
    }
  }

  // Everything on screen asked for again, quietly: the figures stay up until
  // the new ones land, nothing says "loading", and a failure leaves the old
  // figures rather than putting an error over them. Reports not on screen are
  // left alone — the tab and ageing effects ask for them when next opened, as
  // read before the change (shouldRefetchTab). The AI commentary is left alone
  // too: it is regenerated on request from the Analysis tab, not spent on every
  // journal Xero gains. The notice goes up once all of it has landed, so
  // "updated" never runs ahead of the update.
  async function refetchShown() {
    const jobs = [fetchSummary({ quiet: true })];
    if (PERF_TABS.includes(tab))                jobs.push(fetchPerf({ quiet: true }));
    if (tab === 'cashflow')                     jobs.push(fetchCashflow({ quiet: true }));
    if (tab === 'budget' || tab === 'variance') jobs.push(fetchBudget({ quiet: true }));
    if (tab === 'banking')                      jobs.push(fetchBanking({ quiet: true }));
    if (ageingSide)                             jobs.push(fetchAgeing(ageingSide, { quiet: true }));
    await Promise.allSettled(jobs);
    setUpdatedAt(Date.now());
  }

  // Whether a report read at `fetchedAt` must be asked for again on being
  // opened, once per change (see `reasked`).
  function staleOnOpen(key, fetchedAt) {
    const changedAt = version?.changedAt;
    if (!shouldRefetchTab(fetchedAt, changedAt) || reasked.current[key] === changedAt) return false;
    reasked.current[key] = changedAt;
    return true;
  }

  useEffect(() => { fetchSummary(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Acted on in an effect rather than where it was seen, so the tab and the
  // ageing side it reads are the ones open now, not the ones open when the
  // question was asked a moment ago.
  useEffect(() => {
    if (!pendingChange) return;
    setPendingChange(null);
    refetchShown();
  }, [pendingChange]); // eslint-disable-line react-hooks/exhaustive-deps

  // The version is read as soon as the organisation is known, and again on a
  // switch: the stamp is per company, so the one seen for the previous
  // company says nothing about the next, and the first read for it must
  // record rather than react.
  useEffect(() => {
    if (!activeTenantId) return;
    seenChangedAt.current = undefined;
    reasked.current = {};
    setVersion(null);
    setPendingChange(null);
    setUpdatedAt(null);
    fetchVersion();
  }, [activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // Cleared before the refetch too: a failed load keeps the last good report
    // to draw the period bar from, and here that is the previous organisation's.
    if (tab === 'budget' || tab === 'variance') { setBudget({ status: 'idle', data: null, error: '' }); fetchBudget(); }
    else { seq.current.budget++; setBudget({ status: 'idle', data: null, error: '' }); }
    // Cash flow is listed too: its period bar is drawn from the performance
    // months, and the bar vanished on a switch made from the Cash Flow tab.
    // Cleared first for the same reason as the budget above.
    if (PERF_TABS.includes(tab)) { setPerf({ status: 'idle', data: null, error: '' }); fetchPerf(); }
    else { seq.current.perf++; setPerf({ status: 'idle', data: null, error: '' }); }
    // Cash flow was never reset here, so it kept showing the previous
    // organisation's figures.
    if (tab === 'cashflow') fetchCashflow();
    else { seq.current.cashflow++; setCashflow({ status: 'idle', data: null, error: '' }); }
    // Nor were the bank accounts and the open statement, so Banking went on
    // listing the previous organisation's accounts.
    seq.current.statement++;
    setSelectedBankAccount(null);
    setStatement({ status: 'idle', data: [], error: '' });
    if (tab === 'banking') fetchBanking();
    else { seq.current.banking++; setBanking({ status: 'idle', data: [], error: '' }); }
    // Both sides of the ageing belong to the previous organisation. Dropped,
    // and the open side, if any, is fetched again by the effect below.
    seq.current.ageingReceivables++;
    seq.current.ageingPayables++;
    setAgeing({ receivables: AGEING_IDLE, payables: AGEING_IDLE });
  }, [activeTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The ageing is fetched when a side is opened and that side has not been
  // loaded yet: on opening it, on switching side, after a switch of
  // organisation, or on arriving with ?ageing= in the address. Waits for the
  // summary, which it is built from, so the two share one read of Xero. A side
  // read before the last change seen in Xero is asked for again, quietly, so
  // what it shows stays up until the new figures land.
  useEffect(() => {
    if (!ageingSide || !data?.connected) return;
    const s = ageing[ageingSide];
    if (s.status === 'idle') fetchAgeing(ageingSide);
    else if (staleOnOpen(`ageing:${ageingSide}`, s.data?.fetchedAt)) fetchAgeing(ageingSide, { quiet: true });
  }, [ageingSide, data?.connected, ageing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ageingSide || !scrollToAgeing.current) return;
    scrollToAgeing.current = false;
    document.getElementById('dashboard-ageing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [ageingSide]);

  // Asks every minute while the page is in view whether Xero changed, and at
  // once on coming back to it, since a change while away is the likeliest
  // kind. Not before the organisation is known: the first summary names it.
  // (This replaced a 15 s re-render that kept a "synced 3m ago" label honest;
  // the status line now shows clock times, which need no ticking.)
  useVisiblePolling(() => { if (activeTenantId && data?.connected) return fetchVersion(); }, VERSION_EVERY_MS);

  // The notice that a change brought new figures in stays for a few seconds.
  useEffect(() => {
    if (!updatedAt) return undefined;
    const id = setTimeout(() => setUpdatedAt(null), UPDATED_NOTICE_MS);
    return () => clearTimeout(id);
  }, [updatedAt]);

  // The chat assistant answers about whichever company and period this page is
  // showing. It lives outside the page, so the page announces them; without
  // this the chat answered about the first connected company and the
  // financial year to date, whatever was on screen.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('xero-dashboard-context', {
      detail: {
        tenantId: activeTenantId || '',
        period:   perfRange ? { from: perfRange.from, to: perfRange.to } : { preset: perfPreset },
      },
    }));
  }, [activeTenantId, perfPreset, perfRange]);

  // Lazy tab loaders — fire the first time a tab is opened, and again, quietly,
  // when its report was read before the last change seen in Xero: the figures
  // it has stay up until the new ones land (see fetchVersion).
  useEffect(() => {
    if (tab === 'banking') {
      if (banking.status === 'idle') fetchBanking();
      else if (staleOnOpen('banking', banking.fetchedAt)) fetchBanking({ quiet: true });
    }
    // Both budget tabs share one fetch and one cache entry — the Budget Variance
    // view is a different presentation of the same merged data, not a second call.
    if (tab === 'budget' || tab === 'variance') {
      if (budget.status === 'idle') fetchBudget();
      else if (staleOnOpen('budget', budget.data?.fetchedAt)) fetchBudget({ quiet: true });
    }
    if (PERF_TABS.includes(tab)) {
      if (perf.status === 'idle') fetchPerf();
      else if (staleOnOpen('perf', perf.data?.fetchedAt)) fetchPerf({ quiet: true });
    }
    if (tab === 'cashflow') {
      if (cashflow.status === 'idle') fetchCashflow();
      else if (staleOnOpen('cashflow', cashflow.data?.fetchedAt)) fetchCashflow({ quiet: true });
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // A report loaded for another tab carries no comparison with last year, and
  // Overview and Profitability show one. So it is asked for again, with it, on
  // arriving at either — or when a report asked for elsewhere lands while one
  // of them is open. This year's figures come back from the server's cache;
  // only last year's months are new. A reply to a request that already asked
  // for the comparison is never asked again, so one that somehow comes back
  // without it cannot set off a loop of requests.
  const compareReply = useRef(null);
  useEffect(() => {
    const d = perf.data;
    if (!COMPARE_TABS.includes(tab) || perf.status !== 'done' || perf.error || !d || d.priorYear) return;
    if (d === compareReply.current) return;
    fetchPerf({ figuresOnly: true });
  }, [tab, perf.status, perf.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // `quiet` (a re-read after a change seen in Xero) keeps the list on screen
  // while it reloads, and keeps it on a failure too. The read's stamp is kept
  // with the list, to tell one read before a change from one read after.
  function fetchBanking(opts = {}) {
    const n = ++seq.current.banking;
    if (!opts.quiet) setBanking({ status: 'loading', data: [], error: '' });
    return api.get(`/xero-reports/bank-accounts${activeTenantId ? `?tenantId=${activeTenantId}` : ''}`)
      .then(d => { if (n === seq.current.banking) setBanking({ status: 'done', data: d.bankAccounts || [], error: '', fetchedAt: d.fetchedAt }); })
      .catch(err => {
        if (n !== seq.current.banking) return;
        if (opts.quiet) setBanking(s => (s.status === 'done' ? s : { ...s, status: 'done' }));
        else setBanking({ status: 'done', data: [], error: err.message });
      });
  }

  // Counted per side, so a quick switch from one side to the other cannot let
  // the first answer land under the second's switch, nor strand the first as
  // loading. A Refresh keeps the figures on screen while it reloads; a quiet
  // re-read (after a change seen in Xero) keeps them on a failure as well, and
  // leaves the state alone then so the effect that asked is not asked again.
  function fetchAgeing(side, opts = {}) {
    const k = side === 'payables' ? 'ageingPayables' : 'ageingReceivables';
    const n = ++seq.current[k];
    if (!opts.quiet) setAgeing(s => ({ ...s, [side]: { status: 'loading', error: '', data: s[side].data } }));
    const params = new URLSearchParams({ side });
    if (activeTenantId) params.set('tenantId', activeTenantId);
    if (opts.force) params.set('force', 'true');
    return api.get(`/xero-reports/ageing?${params.toString()}`)
      .then(d => { if (n === seq.current[k]) setAgeing(s => ({ ...s, [side]: { status: 'done', data: d, error: '' } })); })
      .catch(err => {
        if (n !== seq.current[k]) return;
        if (opts.quiet) setAgeing(s => (s[side].status === 'done' ? s : { ...s, [side]: { ...s[side], status: 'done' } }));
        else setAgeing(s => ({ ...s, [side]: { status: 'done', data: s[side].data, error: err.message || 'Something went wrong' } }));
      });
  }

  // From a link further down the page: open the side and bring it into view.
  function openAgeingFromBelow(side) {
    if (ageingSide === side) {
      document.getElementById('dashboard-ageing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    scrollToAgeing.current = true;
    setAgeingSide(side);
  }

  // A Refresh keeps the figures on screen while it reloads; a new period or
  // organisation clears them, so last period's cash flow is never shown under
  // this period's label. A quiet re-read (after a change seen in Xero) keeps
  // them, says nothing while it loads, and keeps them on a failure too.
  function fetchCashflow(opts = {}) {
    const n = ++seq.current.cashflow;
    if (!opts.quiet) setCashflow(s => ({ status: 'loading', error: '', data: opts.force ? s.data : null }));
    const params = new URLSearchParams();
    if (activeTenantId) params.set('tenantId', activeTenantId);
    const range = opts.range !== undefined ? opts.range : perfRange;
    if (range) { params.set('from', range.from); params.set('to', range.to); }
    else       { params.set('preset', opts.preset || perfPreset); }
    if (opts.force) params.set('force', 'true');
    return api.get(`/xero-reports/cash-flow?${params.toString()}`)
      .then(d => { if (n === seq.current.cashflow) setCashflow({ status: 'done', data: d, error: '' }); })
      .catch(err => {
        if (n !== seq.current.cashflow) return;
        if (opts.quiet) setCashflow(s => (s.status === 'done' ? s : { ...s, status: 'done' }));
        else setCashflow({ status: 'done', data: null, error: err.message });
      });
  }

  // Cash flow is fetched only for its own tab, and opening the tab was the
  // only thing that fetched it. A period picked ON the Cash Flow tab cleared
  // it and nothing asked again, which is the blank page this replaces. Off the
  // tab it is just dropped, for the tab to fetch when next opened.
  function cashflowForPeriod(opts) {
    if (tab === 'cashflow') fetchCashflow(opts);
    else { seq.current.cashflow++; setCashflow({ status: 'idle', data: null, error: '' }); }
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

  // `quiet` is a re-read after a change seen in Xero: the report on screen
  // stays, nothing under it says "loading", a failure keeps it, and the
  // commentary is left alone as on a figuresOnly re-ask.
  function fetchPerf(opts = {}) {
    const n = ++seq.current.perf;
    if (!opts.quiet) setPerf(s => ({ ...s, status: 'loading', error: '' }));
    const params = periodParams(opts);
    if (opts.force) params.set('force', 'true');
    // Only Banking renders cash in/out. Asking for it elsewhere would make
    // getBankSummary split a long period into 365-day windows for a number
    // nothing displays.
    if (tab === 'banking') params.set('cashFlow', 'true');
    // Top customers needs an invoice fetch, so only the Revenue tab asks for it.
    if (tab === 'revenue') params.set('customers', 'true');
    // Last year's same months are a second report, so only the tabs that show
    // them ask for them.
    if (COMPARE_TABS.includes(tab)) params.set('compare', 'prior-year');
    const req = api.get(`/xero-reports/performance?${params.toString()}`)
      .then(d => {
        if (n !== seq.current.perf) return;
        if (params.has('compare')) compareReply.current = d;
        setPerf({ status: 'done', data: d, error: '' });
        // The server already resolved exactly which months this period covers,
        // so the panels span all of them. Narrowing further is done by changing
        // the period itself, not by a second control fighting the first.
        setMonthFrom(0);
        setMonthTo(Math.max(0, (d.months || []).length - 1));
      })
      // The last good report is kept, as fetchBudget does: the period bar is
      // drawn from it, and without it the bar vanished, leaving no way to pick
      // a period other than the one that failed. The panels still require no
      // error, so its figures are never shown as the new period's.
      .catch(err => {
        if (n !== seq.current.perf) return;
        if (opts.quiet) setPerf(s => (s.status === 'done' ? s : { ...s, status: 'done' }));
        else setPerf(s => ({ status: 'done', data: s.data, error: err.message }));
      });

    // A quiet re-ask after a change leaves the commentary alone as well, and
    // hands back the request so the caller can wait for it to land.
    if (opts.quiet) return req;
    // Re-asked only to add last year's months: the period is unchanged, so the
    // commentary on screen still describes it, and is left alone.
    if (opts.figuresOnly) return;

    // Commentary arrives after the numbers, never blocking them — but it must
    // describe the SAME period, so it takes the identical params.
    const ip = new URLSearchParams(params);
    setInsights(null); // clear stale commentary while the new period loads
    setNarrative(null);
    fetchAnalysis(ip);
  }

  // The organisation and period the budget tabs show, as query values. The
  // exports take the same ones, so a PDF is the report on screen.
  function budgetQuery(opts = {}) {
    const q = {};
    if (activeTenantId) q.tenantId = activeTenantId;
    const range = opts.range !== undefined ? opts.range : budgetRange;
    if (range) { q.from = range.from; q.to = range.to; }
    else       { q.preset = opts.preset || budgetPreset; }
    return q;
  }

  // `quiet` is a re-read after a change seen in Xero: the grid stays — the
  // budget tabs show it only while the status is 'done', so the status is not
  // touched — and a failure keeps it.
  function fetchBudget(opts = {}) {
    const n = ++seq.current.budget;
    if (!opts.quiet) setBudget(s => ({ ...s, status: 'loading', error: '' }));
    const params = new URLSearchParams(budgetQuery(opts));
    if (opts.force) params.set('force', 'true');
    return api.get(`/xero-reports/budget-variance?${params.toString()}`)
      .then(d => {
        if (n !== seq.current.budget) return;
        setBudget({ status: 'done', data: d, error: '' });
        // Keep an existing selection if it still exists in this org's fiscal year,
        // otherwise land on the current month — the first one still on budget.
        setVarianceMonth(prev => {
          if (prev === 'ytd' || (d.months || []).some(m => m.key === prev)) return prev;
          return (d.months || []).find(m => m.source === 'budget')?.key || d.months?.[0]?.key || '';
        });
      })
      // The last good report is kept, not shown: the tabs show the error, but
      // the period bar is drawn from it, so the reader can pick another period
      // instead of being stuck on the one that failed.
      .catch(err => {
        if (n !== seq.current.budget) return;
        if (opts.quiet) setBudget(s => (s.status === 'done' ? s : { ...s, status: 'done' }));
        else setBudget(s => ({ status: 'done', data: s.data, error: err.message }));
      });
  }

  // Counted so that a quick second click, or a switch of organisation, can't
  // let an older account's statement land under the newer heading.
  function viewStatement(account) {
    const n = ++seq.current.statement;
    setSelectedBankAccount(account);
    setStatement({ status: 'loading', data: [], error: '' });
    const params = new URLSearchParams({ accountId: account.accountId });
    if (activeTenantId) params.set('tenantId', activeTenantId);
    api.get(`/xero-reports/bank-transactions?${params.toString()}`)
      .then(d => { if (n === seq.current.statement) setStatement({ status: 'done', data: d.transactions || [], error: '' }); })
      .catch(err => { if (n === seq.current.statement) setStatement({ status: 'done', data: [], error: err.message }); });
  }

  // Banking reads the performance report without checking its error, and a
  // failed load now keeps the last good report (see fetchPerf). Handed nothing
  // instead, so it never shows the previous period's cash as this one's.
  const bankingPerf = perf.error ? { ...perf, data: null } : perf;

  // Balances arrive keyed by name from the Bank Summary; the accounts list is
  // keyed by id. Built once rather than per row.
  const bankBalances = useMemo(
    () => balancesByName((!perf.error && perf.data?.cash?.accounts) || []),
    [perf.data, perf.error]);

  // Both AI fetches in one place. `extra` carries the month range when the reader
  // has narrowed it, so the commentary describes the span they are looking at —
  // a narrative sitting above numbers it is not describing is worse than none.
  function fetchAnalysis(baseParams, { reanalyse = false } = {}) {
    const n = ++seq.current.analysis;
    const fresh = () => n === seq.current.analysis;
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
      api.get(`/xero-reports/variance-insights?${q.toString()}`).then(d => { if (fresh()) setInsights(d); }),
      api.get(`/xero-reports/narrative?${q.toString()}`).then(d => { if (fresh()) setNarrative(d); }),
    ]).then(() => { if (fresh()) setLastAnalysedAt(new Date().toISOString()); });
  }

  async function reanalyse() {
    setReanalysing(true);
    setInsights(null);
    setNarrative(null);
    try { await fetchAnalysis(periodParams(), { reanalyse: true }); }
    finally { setReanalysing(false); }
  }


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
        <RetryAlert message={error} onRetry={() => fetchSummary({ force: true })} busy={refreshing} />
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

  // When Xero was read for each report on screen: the summary always, the open
  // tab's report while its figures are showing, and the open ageing side. The
  // status line names the oldest, which is the most it can claim for all of
  // them. A report that failed is left out: its last good copy is not showing.
  function shownReads() {
    const reads = [data.fetchedAt];
    if (PERF_TABS.includes(tab) && !perf.error)                      reads.push(perf.data?.fetchedAt);
    if (tab === 'cashflow' && !cashflow.error)                       reads.push(cashflow.data?.fetchedAt);
    if ((tab === 'budget' || tab === 'variance') && !budget.error)   reads.push(budget.data?.fetchedAt);
    if (tab === 'banking' && !banking.error)                         reads.push(banking.fetchedAt);
    if (ageingSide && !ageing[ageingSide].error)                     reads.push(ageing[ageingSide].data?.fetchedAt);
    return reads;
  }
  const status = liveLabel(
    { fetchedAt: oldestRead(shownReads()), checkedAt: version?.checkedAt, live: version?.live, liveReason: version?.liveReason },
    t => formatTime(t, user?.timezone));

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
          {/* "Xero data as of 10:02 · checked 10:04": when Xero was last read
              for what is on screen, and when the server last asked it whether
              anything changed. It replaced "Synced 3m ago", which said neither:
              a report served from the cache was "synced" the moment it arrived.
              The version is re-read after a manual Refresh so the two agree. */}
          <LiveStatus label={status} updated={!!updatedAt} onSetup={() => navigate('/setup')} />
          {/* Reloads what the open tab shows as well as the summary. It kept its
              own list of tabs, which had fallen behind PERF_TABS, and never
              reloaded cash flow or the budget at all. */}
          <button className="btn btn-outline btn-sm" disabled={refreshing} onClick={() => {
            fetchSummary({ force: true }).then(() => fetchVersion({ adopt: true }));
            if (PERF_TABS.includes(tab)) fetchPerf({ force: true });
            if (tab === 'cashflow') fetchCashflow({ force: true });
            if (tab === 'budget' || tab === 'variance') fetchBudget({ force: true });
            // The open side is re-read; the other is dropped and reloads from
            // the refreshed cache when it is next opened.
            if (ageingSide) {
              const other = ageingSide === 'receivables' ? 'payables' : 'receivables';
              seq.current[other === 'payables' ? 'ageingPayables' : 'ageingReceivables']++;
              setAgeing(s => ({ ...s, [other]: AGEING_IDLE }));
              fetchAgeing(ageingSide, { force: true });
            }
          }}>
            {refreshing ? <span className="btn-spinner" /> : '↻'} Refresh
          </button>
        </div>
      </div>

      {error && <RetryAlert message={error} onRetry={() => fetchSummary({ force: true })} busy={refreshing} style={{ marginTop: 14 }} />}

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
          onClick={() => setAgeingSide(ageingSide === 'receivables' ? null : 'receivables')}
          active={ageingSide === 'receivables'} controls="dashboard-ageing" actionLabel="Receivables by age and customer"
          value={isMobile ? fmtMoneyShort(kpis.totalReceivables, currency) : fmtMoney(kpis.totalReceivables, currency)}
          sub={isMobile
            ? `${kpis.receivablesCount} invoice${kpis.receivablesCount !== 1 ? 's' : ''}`
            : `${kpis.receivablesCount} sales invoice${kpis.receivablesCount !== 1 ? 's' : ''} awaiting payment`}
        />
        <KpiCard
          icon="▣" tone="danger"
          label={isMobile ? 'Payables' : 'Total Payables'}
          onClick={() => setAgeingSide(ageingSide === 'payables' ? null : 'payables')}
          active={ageingSide === 'payables'} controls="dashboard-ageing" actionLabel="Payables by age and supplier"
          value={isMobile ? fmtMoneyShort(kpis.totalPayables, currency) : fmtMoney(kpis.totalPayables, currency)}
          sub={isMobile
            ? `${kpis.payablesCount} bill${kpis.payablesCount !== 1 ? 's' : ''}`
            : `${kpis.payablesCount} bill${kpis.payablesCount !== 1 ? 's' : ''} awaiting payment`}
        />
        {/* Two figures, never one sum. This card used to add bills you are late
            paying to invoices customers are late paying, which netted two
            opposite positions into a number that described neither. Each is
            labelled with which way the money is owed. */}
        <KpiCard
          icon="⏱" tone="warning"
          label="Overdue"
          value={(
            <span style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 8, rowGap: 1,
                           alignItems: 'baseline', justifyContent: 'start', fontSize: isMobile ? 12 : 15 }}>
              <span style={{ fontSize: isMobile ? 9.5 : 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                {isMobile ? 'Owed to you' : 'Customers owe you'}
              </span>
              <span>{isMobile ? fmtMoneyShort(kpis.overdueReceivables, currency) : fmtMoney(kpis.overdueReceivables, currency)}</span>
              <span style={{ fontSize: isMobile ? 9.5 : 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                {isMobile ? 'You owe' : 'You owe suppliers'}
              </span>
              <span>{isMobile ? fmtMoneyShort(kpis.overduePayables, currency) : fmtMoney(kpis.overduePayables, currency)}</span>
            </span>
          )}
          sub={isMobile
            ? `${kpis.overdueReceivablesCount} inv · ${kpis.overduePayablesCount} bill${kpis.overduePayablesCount !== 1 ? 's' : ''}`
            : `${kpis.overdueReceivablesCount} invoice${kpis.overdueReceivablesCount !== 1 ? 's' : ''} and ${kpis.overduePayablesCount} bill${kpis.overduePayablesCount !== 1 ? 's' : ''} past due`}
        />
      </div>

      {/* Under the two cards that open it, on every tab: what is owed each way
          is "right now", not part of any tab's period. */}
      {ageingSide && (
        <AgeingSection side={ageingSide} onSide={setAgeingSide} state={ageing[ageingSide]} isMobile={isMobile}
                       onRetry={() => fetchAgeing(ageingSide, { force: true })} onClose={() => setAgeingSide(null)} />
      )}

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
        <div ref={tabsRef} role="tablist" aria-label="Dashboard sections" className="mobile-scroll-x" style={{ display: 'flex', gap: 4, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, maxWidth: '100%', overflowX: 'auto' }}>
          {TABS.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="tab-pill" onClick={() => setTab(t.key)} style={{
              padding: '7px 16px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
              background: tab === t.key ? 'var(--accent-gradient)' : 'transparent',
              color: tab === t.key ? '#fff' : 'var(--text-muted)',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Shown after a failed load too, from the last good report, so another
          period can still be picked; its label then says it is the last one
          loaded, since the select already shows the period that failed. */}
      {['overview', 'revenue', 'cashflow', 'profit', 'analysis'].includes(tab) && perf.data && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                       gap: 14, flexWrap: 'wrap', marginBottom: 16, padding: '12px 16px' }}>
          <MonthRange months={perf.data.months} from={monthFrom} to={monthTo}
                      label={lastLoaded(perf.data.period?.label, !!perf.error)}
                      chunks={perf.data.period?.chunks}
                      preset={perfRange ? 'custom' : perfPreset}
                      onPreset={p => {
                        if (p === 'custom') return;      // range pickers drive that
                        setPerfPreset(p); setPerfRange(null);
                        fetchPerf({ preset: p, range: null });
                        cashflowForPeriod({ preset: p, range: null });
                      }}
                      onRange={(from, to) => {
                        const r = { from, to };
                        setPerfRange(r); fetchPerf({ range: r });
                        cashflowForPeriod({ range: r });
                      }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
              {perf.data.months.filter(m => m.source === 'actual').length} closed · {perf.data.months.filter(m => m.source === 'budget').length} budgeted
            </span>
            {/* On Cash Flow this refreshes cash flow too; it used to reload
                only the overview figures underneath it. */}
            {(() => {
              const busy = perf.status === 'loading' || (tab === 'cashflow' && cashflow.status === 'loading');
              return (
                <button className="btn btn-outline btn-sm" disabled={busy}
                        onClick={() => { fetchPerf({ force: true }); if (tab === 'cashflow') fetchCashflow({ force: true }); }}>
                  {busy ? <span className="btn-spinner" /> : '↻'} Refresh
                </button>
              );
            })()}
          </div>
        </div>
      )}

      {/* The other tabs under the bar show this error themselves. Cash Flow
          shows only its own report's, so a failed load of the report the bar
          is drawn from said nothing there — unless both failed alike. */}
      {tab === 'cashflow' && perf.error && perf.error !== cashflow.error && (
        <RetryAlert message={perf.error} onRetry={() => fetchPerf({ force: true })} busy={perf.status === 'loading'} style={{ marginBottom: 16 }} />
      )}

      {/* The budget tabs' period. Monthly, like the budgets themselves: Xero
          holds a budget per month, so there is no day to pick. */}
      {['budget', 'variance'].includes(tab) && budget.data?.months?.length > 0 && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                       gap: 14, flexWrap: 'wrap', marginBottom: 16, padding: '12px 16px' }}>
          <MonthRange months={budget.data.months} from={0} to={budget.data.months.length - 1}
                      label={lastLoaded(budget.data.period?.label, !!budget.error)}
                      chunks={budget.data.period?.chunks}
                      preset={budgetRange ? 'custom' : budgetPreset}
                      onPreset={p => {
                        if (p === 'custom') return;
                        setBudgetPreset(p); setBudgetRange(null);
                        fetchBudget({ preset: p, range: null });
                      }}
                      onRange={(from, to) => {
                        const r = { from, to };
                        setBudgetRange(r); fetchBudget({ range: r });
                      }} />
        </div>
      )}

      {tab === 'overview' && (
        <>
          {perf.status === 'loading' && !perf.data && (
            <div className="card" style={{ padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>Loading performance data…</div>
          )}
          {perf.error && (
            <RetryAlert message={perf.error} onRetry={() => fetchPerf({ force: true })} busy={perf.status === 'loading'} style={{ marginBottom: 16 }} />
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
            <RetryAlert message={perf.error} onRetry={() => fetchPerf({ force: true })} busy={perf.status === 'loading'} />
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
            <RetryAlert message={perf.error} onRetry={() => fetchPerf({ force: true })} busy={perf.status === 'loading'} />
          )}
          {perf.data && !perf.error && (
            <RevenuePanel data={perf.data} from={monthFrom} to={monthTo}
                          selectedLine={revenueLine} onSelectLine={setRevenueLine}
                          onRecurringChange={() => fetchPerf()} />
          )}
        </>
      )}

      {tab === 'profit' && (
        <>
          {perf.status === 'loading' && !perf.data && (
            <div className="card" style={{ padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>Loading profitability data…</div>
          )}
          {perf.error && (
            <RetryAlert message={perf.error} onRetry={() => fetchPerf({ force: true })} busy={perf.status === 'loading'} />
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
            <RetryAlert message={cashflow.error} onRetry={() => fetchCashflow({ force: true })} busy={cashflow.status === 'loading'} />
          )}
          {cashflow.data && !cashflow.error && <CashFlowPanel data={cashflow.data} onOpenAgeing={openAgeingFromBelow} />}
        </>
      )}


      {/* Banking's cash figures come from the performance report, and without
          this a failed load just left them out with no word why. */}
      {tab === 'banking' && perf.error && (
        <RetryAlert message={perf.error} onRetry={() => fetchPerf({ force: true })} busy={perf.status === 'loading'} style={{ marginBottom: 16 }} />
      )}
      {tab === 'banking' && <BankingTab user={user} isMobile={isMobile} banking={banking} selectedBankAccount={selectedBankAccount} setSelectedBankAccount={setSelectedBankAccount} statement={statement} perf={bankingPerf} viewStatement={viewStatement} bankBalances={bankBalances} currency={currency} />}




      {tab === 'budget' && <BudgetTab budget={budget} fetchBudget={fetchBudget} currency={currency} exportQuery={budgetQuery()} />}

      {tab === 'variance' && <VarianceTab isMobile={isMobile} monthsRef={monthsRef} monthEdges={monthEdges} budget={budget} varianceMonth={varianceMonth} setVarianceMonth={setVarianceMonth} fetchBudget={fetchBudget} currency={currency} exportQuery={budgetQuery()} />}
    </div>
  );
}
