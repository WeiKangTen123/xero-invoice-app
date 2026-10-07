import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import RetryAlert from '../components/RetryAlert';
import ReceiptUpload from '../components/receipts/ReceiptUpload';
import BillIntake from '../components/bills/BillIntake';
import InvoiceIntake from '../components/invoices/InvoiceIntake';
import ClaimImport from '../components/receipts/ClaimImport';
import DeleteConfirmModal from '../components/DeleteConfirmModal';
import { ATTENTION_STATUSES } from '../utils/badges';
import { useViewMode } from '../context/ViewModeContext';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useToast } from '../context/ToastContext';
import { usePipeline } from '../context/PipelineContext';
import { useVisiblePolling } from '../utils/useVisiblePolling';
import ActiveClaimBanner from './invoices/ActiveClaimBanner';
import ClaimBatchCards from './invoices/ClaimBatchCards';
import DesktopTable from './invoices/DesktopTable';
import { FilterPill } from './invoices/FilterPill';
import MobileList from './invoices/MobileList';
import MobileSelectionBar from './invoices/MobileSelectionBar';
import { DEFAULT_TAB, TABS, countOf, currencyTotals, receivedBucket, receivedCutoff, scannedNote, tabByKey } from './invoices/helpers';
import { syncSummary } from './invoices/xero-status';

// What "Clear all" did, in the server's words. The server decides what is kept
// (anything in Xero or mid-send) and replies { removed, kept, message }, so its
// message is the account to show, not the counts this page had before asking.
function clearedMessage(r) {
  return r?.message || 'Cleared. Anything already posted to Xero was kept.';
}

// The filters a link or a Back can restore, with the value each takes when the
// parameter is absent. A value outside the known set falls back too, so a stale
// or hand-edited link narrows nothing rather than hiding every row.
const STATUS_KEYS   = ['all', 'posted', 'reviewed', 'pending', 'needs-action', 'duplicate', 'reported'];
const RECEIVED_KEYS = ['all', 'today', '7d', '30d', 'month', 'custom'];
const DATE_RE       = /^\d{4}-\d{2}-\d{2}$/;

// Moves in the pipeline that change what this list holds or how its rows read:
// a document read off an email, a send to Xero starting, landing or failing.
// When any of them moves, the list is fetched again in the background.
function pipelineSignature(s) {
  if (!s) return '';
  return [s.invoiceCount, s.queue?.pending, s.queue?.processing,
          s.xero?.pending, s.xero?.submitting, s.xero?.posted, s.xero?.error].join('|');
}

export default function Invoices() {
  const { isMobile } = useViewMode();
  const { user } = useAuth();
  const confirm = useConfirm();
  const toast   = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { status: pipelineStatus, refresh: refreshPipeline } = usePipeline();
  const [invoices,     setInvoices]     = useState([]);
  // `loading` is the first load only, the one time there are no rows to keep on
  // screen. Every later fetch runs behind the table (`refreshing`): swapping
  // the list for a spinner on each refresh lost the place of whoever was reading.
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [loaded,       setLoaded]       = useState(false);
  const [loadError,    setLoadError]    = useState('');
  const [clearing,      setClearing]      = useState(false);
  const [submittingAll, setSubmittingAll] = useState(false);
  const [syncingXero,   setSyncingXero]   = useState(false);
  const [submitMsg,     setSubmitMsg]     = useState('');
  const [selected,      setSelected]      = useState(new Set());
  const [deleteTarget,  setDeleteTarget]  = useState(null); // { type: 'single', invoice } | { type: 'bulk', count, ids } | { type: 'clear' }
  const [deleteLoading, setDeleteLoading] = useState(false);
  // The tab lives in the URL so Back from a review lands where you left, and so
  // a link can point at one. A query param rather than /invoices/claims because
  // /invoices/:id already exists and a path segment invites a collision there
  // for no gain.
  //
  // The filters live there too, for the same reason: they were component state,
  // so opening a bill and coming back reset status, search and date range, and
  // the reader had to find their place again. Written with `replace`, so typing
  // in the search box does not leave one history entry per letter for Back to
  // step through.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab    = tabByKey(searchParams.get('tab')).key;
  const paramIn = (key, allowed) => (allowed.includes(searchParams.get(key)) ? searchParams.get(key) : 'all');
  const statusFilter   = paramIn('status', STATUS_KEYS);
  const receivedFilter = paramIn('received', RECEIVED_KEYS);
  const customFrom     = DATE_RE.test(searchParams.get('from') || '') ? searchParams.get('from') : '';
  const customTo       = DATE_RE.test(searchParams.get('to')   || '') ? searchParams.get('to')   : '';
  const filter         = searchParams.get('q') || '';
  // A parameter at its default is removed rather than written out, so the
  // plain list keeps its plain address.
  function setParam(key, value, fallback = '') {
    const next = new URLSearchParams(searchParams);
    if (!value || value === fallback) next.delete(key); else next.set(key, value);
    setSearchParams(next, { replace: true });
  }
  const setStatusFilter   = v => setParam('status', v, 'all');
  const setReceivedFilter = v => setParam('received', v, 'all');
  const setCustomFrom     = v => setParam('from', v);
  const setCustomTo       = v => setParam('to', v);
  const setFilter         = v => setParam('q', v);
  const setTab = (key) => {
    // Selection is a set of ids from the tab you were on. Carrying it across
    // would let a bulk delete on AP remove the AR rows you ticked earlier.
    setSelected(new Set());
    const next = new URLSearchParams(searchParams);
    if (key === DEFAULT_TAB) next.delete('tab'); else next.set('tab', key);
    setSearchParams(next, { replace: true });
  };
  const [activeClaimJob, setActiveClaimJob] = useState(null);
  const [claimModalJobId, setClaimModalJobId] = useState(null);

  // A background claim import drives the persistent progress banner. Asked on
  // arrival and with every refetch of the list (an import adds rows, so that
  // is when one may have started), then polled every 3.5 s only while one is
  // running. It used to poll for as long as the page was open, almost always
  // to hear that nothing was running.
  const checkActiveClaim = useCallback(() => (
    api.get('/claims/active').then(res => setActiveClaimJob(res.job || null)).catch(() => {})
  ), []);
  useVisiblePolling(checkActiveClaim, 3500, !!activeClaimJob);

  // Only the newest request is applied, so a slow fetch started before a
  // delete cannot land afterwards and put the deleted row back.
  const fetchSeq = useRef(0);
  const fetchInvoices = useCallback(async () => {
    const n = ++fetchSeq.current;
    setRefreshing(true);
    checkActiveClaim();
    try {
      const d = await api.get('/invoices');
      if (n !== fetchSeq.current) return;
      setInvoices(d.invoices || []);
      setLoaded(true);
      setLoadError('');
    } catch (err) {
      if (n === fetchSeq.current) setLoadError(err.message || 'Could not load the list');
    } finally {
      if (n === fetchSeq.current) { setLoading(false); setRefreshing(false); }
    }
  }, [checkActiveClaim]);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  // A fetch already out when rows are removed here predates the removal, and
  // would put them back when it lands. Its answer is dropped instead.
  function dropFetchInFlight() {
    fetchSeq.current++;
    setRefreshing(false);
  }

  // The chat assistant changes records from outside this page and announces
  // each one. Any of them may be on this list, so the list is fetched again.
  useEffect(() => {
    const onUpdated = () => fetchInvoices();
    window.addEventListener('invoice-updated', onUpdated);
    return () => window.removeEventListener('invoice-updated', onUpdated);
  }, [fetchInvoices]);

  // New mail read, a send landing in Xero: the pipeline status (polled for the
  // sidebar anyway) moves, and the list follows it. The first status seen is
  // only remembered, not acted on: it is not a change, and the mount fetch is
  // already out.
  const pipelineSig  = pipelineSignature(pipelineStatus);
  const lastPipeline = useRef(null);
  useEffect(() => {
    if (!pipelineSig) return;
    if (lastPipeline.current !== null && lastPipeline.current !== pipelineSig) fetchInvoices();
    lastPipeline.current = pipelineSig;
  }, [pipelineSig, fetchInvoices]);

  // A claim import finishing in the background has just added its claims;
  // the banner going away is the moment to show them.
  const hadClaimJob = useRef(false);
  useEffect(() => {
    if (hadClaimJob.current && !activeClaimJob) fetchInvoices();
    hadClaimJob.current = !!activeClaimJob;
  }, [activeClaimJob, fetchInvoices]);

  // Opening a record takes this list's address along (tab, filters, search),
  // so Back on the review page returns here as it was. `depth` counts the
  // history entries between here and the record: stepping between receipts in
  // a batch adds one each, and Back goes that many steps back.
  const openRecord = id => navigate(`/invoices/${id}`, {
    state: { from: `${location.pathname}${location.search}`, depth: 1 },
  });

  useEffect(() => {
    setSelected(s => {
      const ids = new Set(invoices.map(i => i.id));
      const next = new Set([...s].filter(id => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [invoices]);

  // The banner counts the pending rows on the open tab, so exactly those are
  // sent: their ids are listed rather than leaving the server to post
  // "everything pending", which used to include the other two kinds as well.
  // The question names the count and the kind, so "Send 3 bills" cannot turn
  // out to mean seven documents. The ids are taken when the button is pressed;
  // the server skips any that stopped being pending in the meantime and says
  // how many.
  async function handleSubmitAll() {
    const tabNow = activeTab;
    const ids = tabRows.filter(i => i.status === 'pending').map(i => i.id);
    if (!ids.length) return;
    const what = countOf(ids.length, tabNow);
    if (!(await confirm({
      title:        `Send ${what} to Xero?`,
      message:      `Each pending ${tabNow.one} on this tab is posted to Xero, one after another. Pending items on the other tabs are not sent.`,
      confirmLabel: `Send ${what}`,
    }))) return;

    setSubmittingAll(true);
    setSubmitMsg('');
    try {
      const r = await api.post('/invoices/submit-all', { ids });
      // { submitted, skipped }: how many of these ids went, and how many had
      // stopped being pending (sent, edited or deleted) since the page loaded.
      const sent = Number(r.submitted) || 0, skipped = Number(r.skipped) || 0;
      setSubmitMsg([
        sent ? `sending ${countOf(sent, tabNow)}` : 'nothing sent',
        skipped ? `${skipped} skipped — no longer pending` : '',
      ].filter(Boolean).join(', '));
      // The rows turn "Submitting" now, and each one's arrival in Xero moves
      // the pipeline counts, which refetch the list as it happens (see above).
      // It used to be fetched once, four seconds later, whether or not
      // anything had been sent by then.
      fetchInvoices();
      refreshPipeline();
      setTimeout(() => setSubmitMsg(''), 4000);
    } catch (err) {
      setSubmitMsg(err.message);
      setTimeout(() => setSubmitMsg(''), 4000);
    } finally {
      setSubmittingAll(false);
    }
  }

  // Asks Xero now what became of everything posted (approved, paid, voided…)
  // rather than waiting for the server's 3-hourly check, then shows it. The
  // server allows one of these a minute per account and says so in its 429,
  // which is what the error toast shows.
  async function handleRefreshFromXero() {
    setSyncingXero(true);
    try {
      const r = await api.post('/invoices/sync-xero-status', {});
      if (Number(r.failedTenants) > 0) toast.error(syncSummary(r));
      else toast.success(syncSummary(r));
      fetchInvoices();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSyncingXero(false);
    }
  }

  // "Clear all" does more than its name says, so the question lists all of it
  // before anything happens: it reaches every tab, not just the open one; it
  // stops the mailbox watcher and empties the email queue; and it keeps
  // whatever is already posted to Xero. The counts in the question are this
  // page's view; what the server actually kept is in its reply, so that is
  // what the toast reports.
  async function handleClearCache() {
    // Across every tab, unlike the tab-scoped status counts further down. The
    // same rule the server keeps by: a row holding a Xero invoice ID is in Xero
    // whatever its status says, and a row mid-send may be about to be.
    const kept          = i => i.status === 'posted' || i.status === 'submitting' || !!i.xeroInvoiceId;
    const unposted      = invoices.filter(i => !kept(i)).length;
    const alreadyPosted = invoices.length - unposted;
    const records       = n => `${n} record${n === 1 ? '' : 's'}`;
    const message       = [
      `Deletes ${records(unposted)} not yet posted to Xero — invoices, bills and expense claims, on every tab, not just this one — with their stored PDFs and receipt photos.`,
      'Stops the mailbox watcher and clears the queue of emails waiting to be read. Start the watcher again from Automation.',
      alreadyPosted ? `Keeps the ${records(alreadyPosted)} already in Xero or being sent to it.` : 'Keeps anything already in Xero or being sent to it.',
      'This cannot be undone.',
    ].join('\n\n');
    if (!(await confirm({ title: `Clear ${records(unposted)}?`, message, confirmLabel: 'Clear all', danger: true }))) return;
    setClearing(true);
    try {
      const r = await api.delete('/invoices');
      setSelected(new Set());
      fetchInvoices();
      toast.success(clearedMessage(r));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setClearing(false);
    }
  }

  function promptDeleteOne(inv, e) {
    e.stopPropagation();
    setDeleteTarget({ type: 'single', invoice: inv });
  }

  function promptDeleteSelected() {
    if (!selected.size) return;
    setDeleteTarget({ type: 'bulk', count: selected.size, ids: [...selected] });
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      if (deleteTarget.type === 'single') {
        const id = deleteTarget.invoice.id;
        await api.delete(`/invoices/${id}`);
        dropFetchInFlight();
        setInvoices(prev => prev.filter(i => i.id !== id));
        setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
      } else if (deleteTarget.type === 'bulk') {
        // Settled one by one rather than Promise.all: a selection can include
        // something already posted to Xero, which the server refuses (409), and
        // that refusal must not hide that the rest were deleted — nor leave
        // them on screen as if they were not.
        const ids     = deleteTarget.ids;
        const results = await Promise.allSettled(ids.map(id => api.delete(`/invoices/${id}`)));
        const gone    = new Set(ids.filter((_, k) => results[k].status === 'fulfilled'));
        const refused = results.filter(r => r.status === 'rejected').map(r => r.reason);
        dropFetchInFlight();
        setInvoices(prev => prev.filter(i => !gone.has(i.id)));
        setSelected(prev => new Set([...prev].filter(id => !gone.has(id))));
        if (refused.length) {
          toast.error(refused.length === 1
            ? refused[0].message
            : `${refused.length} of ${ids.length} were not deleted — ${refused[0].message}`);
        }
      }
      setDeleteTarget(null);
    } catch (err) {
      // The server's own reason, e.g. that a posted document cannot be deleted
      // here. The dialog closes, because asking again gets the same answer.
      toast.error(err.message);
      setDeleteTarget(null);
    } finally {
      setDeleteLoading(false);
    }
  }

  function toggleSelect(id, e) {
    e.stopPropagation();
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  // Groups of claims imported in batches
  const claimBatches = useMemo(() => {
    const map = new Map();
    for (const inv of invoices) {
      if (inv.receiptGroup) {
        if (!map.has(inv.receiptGroup)) {
          map.set(inv.receiptGroup, { groupId: inv.receiptGroup, items: [] });
        }
        map.get(inv.receiptGroup).items.push(inv);
      }
    }
    return [...map.values()].map(b => ({ ...b, totals: currencyTotals(b.items) }));
  }, [invoices]);

  async function handleBatchApprove(ids) {
    try {
      await api.post('/invoices/batch-status', { ids, status: 'reviewed' });
      fetchInvoices();
    } catch (err) {
      toast.error(err.message || 'Could not approve batch');
    }
  }

  async function handleUndoBatch(groupId) {
    if (!(await confirm({ title: 'Undo this batch?', message: 'All its claims and receipt files are removed. This cannot be undone.', confirmLabel: 'Undo batch', danger: true }))) return;
    try {
      await api.delete(`/claims/group/${groupId}`);
      fetchInvoices();
    } catch (err) {
      toast.error(err.message || 'Could not undo batch');
    }
  }

  const activeTab = tabByKey(tab);
  // Everything belonging to this tab, before status / search / date narrow it.
  // Both the status counts and the visible rows derive from this, which is what
  // stops a tab claiming "8 posted" while showing three.
  const tabRows = invoices.filter(activeTab.match);

  // 'needs-action' is a virtual filter covering review-needed + error
  const filtered = tabRows.filter(inv => {
    if (statusFilter === 'needs-action') {
      if (!ATTENTION_STATUSES.includes(inv.status)) return false;
    } else if (statusFilter === 'duplicate') {
      if (inv.status !== 'duplicate' && !inv.duplicateOf && !(inv.errorMsg && /duplicate/i.test(inv.errorMsg))) return false;
    } else if (statusFilter !== 'all' && inv.status !== statusFilter) {
      return false;
    }
    // Filters on WHEN IT ARRIVED, not the date on the document.
    if (receivedFilter !== 'all') {
      const at = (inv.receivedAt || inv.processedAt) ? new Date(inv.receivedAt || inv.processedAt) : null;
      if (!at || Number.isNaN(at.getTime())) return false;
      if (receivedFilter === 'custom') {
        if (customFrom && at < new Date(`${customFrom}T00:00:00`)) return false;
        if (customTo   && at > new Date(`${customTo}T23:59:59`))   return false;
      } else {
        const cutoff = receivedCutoff(receivedFilter);
        if (cutoff && at < cutoff) return false;
      }
    }

    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      inv.vendorName?.toLowerCase().includes(q) ||
      inv.invoiceNumber?.toLowerCase().includes(q) ||
      inv.sourceEmail?.toLowerCase().includes(q) ||
      inv.description?.toLowerCase().includes(q)
    );
  });

  const allFilteredSelected = filtered.length > 0 && filtered.every(i => selected.has(i.id));

  function toggleSelectAll(e) {
    e.stopPropagation();
    if (allFilteredSelected) {
      setSelected(prev => { const n = new Set(prev); filtered.forEach(i => n.delete(i.id)); return n; });
    } else {
      setSelected(prev => new Set([...prev, ...filtered.map(i => i.id)]));
    }
  }

  // Grouped by ARRIVAL, not document date — the question is "what came in and
  // when", and grouping by invoice date would scatter one day's intake across
  // months. Order within a group is untouched, so the existing sort still holds.
  const groups = useMemo(() => {
    const now = new Date();
    const byKey = new Map();
    for (const inv of filtered) {
      const b = receivedBucket(inv.receivedAt || inv.processedAt, now);
      if (!byKey.has(b.key)) byKey.set(b.key, { ...b, rows: [] });
      byKey.get(b.key).rows.push(inv);
    }
    return [...byKey.values()]
      .sort((a, b) => a.rank - b.rank)
      .map(g => ({
        ...g,
        totals: currencyTotals(g.rows),
        note:  scannedNote(g.rows),
        // Recent buckets open; history collapsed, because everything expanded is
        // the same wall of rows this is meant to fix.
        openByDefault: g.rank <= 2,
      }));
  }, [filtered]);

  // Only the groups the user has actually clicked are remembered; everything
  // else follows openByDefault. Storing the exceptions rather than the state
  // means a new month appears collapsed without anyone updating a list.
  const [toggled, setToggled] = useState(() => new Set());
  const isOpen = g => (toggled.has(g.key) ? !g.openByDefault : g.openByDefault);
  const toggleGroup = key => setToggled(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // A tab's own count spans every document of that kind, so the strip reads as a
  // map of the whole workspace regardless of which tab is open.
  const tabCounts = Object.fromEntries(TABS.map(t => [t.key, invoices.filter(t.match).length]));

  // Status counts are scoped to the open tab. Counting across all three would
  // put "✓ Posted 48" above a list of three receivables.
  const isDuplicate = i => i.status === 'duplicate' || i.duplicateOf || (i.errorMsg && /duplicate/i.test(i.errorMsg));
  const pending     = tabRows.filter(i => i.status === 'pending').length;
  const posted      = tabRows.filter(i => i.status === 'posted').length;
  const reviewed    = tabRows.filter(i => i.status === 'reviewed').length;
  const reported    = tabRows.filter(i => i.status === 'reported').length;
  const needsAction = tabRows.filter(i => ATTENTION_STATUSES.includes(i.status)).length;
  const duplicates  = tabRows.filter(isDuplicate).length;

  return (
    <div>
      <div className="page-header">
        {/* "AR & AP" covers all three tabs, despite the third being named
            separately. An expense claim posts to Xero as an ACCPAY bill (see
            xero/invoices.js) — EXPENSE is this app's note about how the document
            arrived, photographed by an employee rather than emailed by a
            supplier, not a different kind of Xero document. Naming the heading
            "AR, AP & Claims" implied a third category that does not exist. */}
        <h1>AR &amp; AP</h1>
        <p>Receivables, payables and expense claims on their way to Xero. Click any row to review.</p>
      </div>

      {/* Active background claim import banner */}
      {activeClaimJob && <ActiveClaimBanner activeClaimJob={activeClaimJob} setClaimModalJobId={setClaimModalJobId} />}

      {/* Claim Batches Action Cards */}
      {claimBatches.length > 0 && <ClaimBatchCards claimBatches={claimBatches} handleBatchApprove={handleBatchApprove} handleUndoBatch={handleUndoBatch} />}

      {/* Reviewed-but-not-posted banner */}
      {reviewed > 0 && (
        <div className="alert alert-info" style={{ marginBottom: 8 }}>
          <span className="alert-icon">●</span>
          <span>
            <strong>{reviewed} invoice{reviewed !== 1 ? 's' : ''}</strong> marked as reviewed but not yet posted to Xero —
            open each one and click "Post to Xero".
          </span>
          <button
            className="btn btn-sm"
            onClick={() => setStatusFilter('reviewed')}
            style={{ marginLeft: 'auto', background: 'var(--info-subtle)', color: 'var(--info)', border: '1px solid rgba(59,130,246,0.3)', flexShrink: 0 }}
          >
            Show only →
          </button>
        </div>
      )}

      {/* Needs-action banner */}
      {needsAction > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          <span className="alert-icon">⚠</span>
          <span>
            <strong>{needsAction} invoice{needsAction !== 1 ? 's' : ''}</strong> failed to process automatically —
            open each one to review the PDF, correct any fields, then post to Xero manually.
          </span>
          <button
            className="btn btn-sm"
            onClick={() => setStatusFilter('needs-action')}
            style={{ marginLeft: 'auto', background: 'var(--warning-subtle)', color: 'var(--warning)', border: '1px solid rgba(245,158,11,0.3)', flexShrink: 0 }}
          >
            Show only →
          </button>
        </div>
      )}

      {/* Pending-but-not-submitted banner */}
      {pending > 0 && (
        <div className="alert alert-info" style={{ marginBottom: 16, background: 'rgba(99,102,241,0.06)', borderColor: 'rgba(99,102,241,0.2)', color: 'var(--text-primary)' }}>
          <span className="alert-icon" style={{ color: 'var(--accent)' }}>⟳</span>
          <span>
            <strong>{countOf(pending, activeTab)}</strong> pending Xero submission
            {submitMsg && <span style={{ marginLeft: 8, color: 'var(--accent)', fontWeight: 500 }}>— {submitMsg}</span>}
          </span>
          <button
            className="btn btn-sm"
            disabled={submittingAll}
            onClick={handleSubmitAll}
            style={{ marginLeft: 'auto', background: 'rgba(99,102,241,0.12)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.3)', flexShrink: 0 }}
          >
            {submittingAll ? '...' : `Send ${countOf(pending, activeTab)} to Xero →`}
          </button>
        </div>
      )}

      {/* AR / AP / Expense Claims. These are three kinds of document, not three
          filters over one kind, so they read as tabs rather than pills — the
          status pills below then narrow whichever kind is open. */}
      <div
        role="tablist"
        aria-label="Document type"
        className={isMobile ? 'mobile-scroll-x' : ''}
        style={{
          display: 'flex', gap: 4, alignItems: 'center',
          borderBottom: '1px solid var(--border)',
          marginBottom: 14, paddingBottom: 0,
          flexWrap: isMobile ? 'nowrap' : 'wrap',
        }}
      >
        {TABS.map(t => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: isMobile ? '9px 12px' : '9px 16px',
                border: 'none', background: 'none', cursor: 'pointer',
                whiteSpace: 'nowrap', flexShrink: 0,
                fontSize: 13.5, fontWeight: active ? 700 : 500,
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                // The underline sits on the container's border, so the active
                // tab reads as joined to the list beneath it.
                boxShadow: active ? 'inset 0 -2px 0 var(--accent)' : 'none',
                transition: 'color .15s ease',
              }}
            >
              {isMobile ? t.label : t.long}
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 9,
                background: active ? 'var(--accent-subtle)' : 'var(--bg-secondary)',
                color: active ? 'var(--accent)' : 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}>{tabCounts[t.key]}</span>
            </button>
          );
        })}
      </div>

      {/* Each kind of document has its own ways in, and the controls for them
          sit on that kind's tab and nowhere else. Bills: a PDF, or a batch of
          them. Claims: a photo, a claim form, or the phone. Invoices: a form,
          or a spreadsheet — there is no file to upload for a document we
          produce ourselves. */}
      {tab === 'ar' && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12,
          flexWrap: isMobile ? 'nowrap' : 'wrap',
          overflowX: isMobile ? 'auto' : 'visible', paddingBottom: isMobile ? 2 : 0,
        }}>
          <InvoiceIntake onUploaded={fetchInvoices} />
        </div>
      )}
      {tab === 'ap' && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12,
          flexWrap: isMobile ? 'nowrap' : 'wrap',
          overflowX: isMobile ? 'auto' : 'visible', paddingBottom: isMobile ? 2 : 0,
        }}>
          <BillIntake onUploaded={fetchInvoices} />
        </div>
      )}
      {tab === 'claims' && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12,
          flexWrap: isMobile ? 'nowrap' : 'wrap',
          overflowX: isMobile ? 'auto' : 'visible', paddingBottom: isMobile ? 2 : 0,
        }}>
          <ReceiptUpload onUploaded={fetchInvoices} />
        </div>
      )}

      {/* Status pills, scoped to the open tab */}
      <div className={isMobile ? "mobile-scroll-x" : ""} style={{
        display: 'flex',
        gap: 8,
        marginBottom: 10,
        flexWrap: isMobile ? 'nowrap' : 'wrap',
        alignItems: 'center',
        paddingBottom: isMobile ? 4 : 0,
      }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 2, flexShrink: 0 }}>Status:</span>
        {[
          { key: 'all',          label: 'All',              count: tabRows.length },
          { key: 'posted',       label: '✓ Posted',         count: posted },
          { key: 'reviewed',     label: '● Ready to Post',  count: reviewed },
          { key: 'pending',      label: 'Pending',          count: pending },
          { key: 'needs-action', label: '⚠ Needs Review',   count: needsAction },
          ...(duplicates > 0 ? [{ key: 'duplicate', label: '⚠ Duplicate', count: duplicates }] : []),
          { key: 'reported',     label: 'Reported',         count: reported },
        ].map(t => (
          <FilterPill key={t.key} active={statusFilter === t.key} onClick={() => setStatusFilter(t.key)} label={t.label} count={t.count} />
        ))}
      </div>

      {/* Received — WHEN IT ARRIVED here, not the date printed on the document.
          Applies to all three types: "what came in this week" is the same
          bookkeeping question for an emailed bill and a photographed receipt. */}
      <div className={isMobile ? "mobile-scroll-x" : ""} style={{
        display: 'flex',
        gap: 8,
        marginBottom: 10,
        flexWrap: isMobile ? 'nowrap' : 'wrap',
        alignItems: 'center',
        paddingBottom: isMobile ? 4 : 0,
      }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 2, flexShrink: 0 }}>Received:</span>
        {[
          { key: 'all',    label: 'All time' },
          { key: 'today',  label: 'Today' },
          { key: '7d',     label: 'Last 7 days' },
          { key: '30d',    label: 'Last 30 days' },
          { key: 'month',  label: 'This month' },
          { key: 'custom', label: 'Custom' },
        ].map(t => (
          <FilterPill
            key={t.key}
            active={receivedFilter === t.key}
            onClick={() => setReceivedFilter(t.key)}
            label={t.label}
            count={t.key === 'all' ? undefined : invoices.filter(i => {
              const at = (i.receivedAt || i.processedAt) ? new Date(i.receivedAt || i.processedAt) : null;
              if (!at || Number.isNaN(at.getTime())) return false;
              if (t.key === 'custom') return false;
              const c = receivedCutoff(t.key);
              return !c || at >= c;
            }).length}
          />
        ))}

        {receivedFilter === 'custom' && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 4, flexShrink: 0 }}>
            <input type="date" className="form-input" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                   style={{ padding: '4px 8px', fontSize: 12, width: 140 }} aria-label="Received from" />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>to</span>
            <input type="date" className="form-input" value={customTo} onChange={e => setCustomTo(e.target.value)}
                   style={{ padding: '4px 8px', fontSize: 12, width: 140 }} aria-label="Received to" />
          </span>
        )}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: 380, minWidth: 160 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 14 }}>⌕</span>
            <input
              type="search"
              className="form-input"
              placeholder="Search vendor, invoice #, or email..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              style={{ paddingLeft: 34 }}
            />
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {filtered.length} of {invoices.length}
          </span>
          {/* Refreshes behind the table: the rows stay put and only this
              button shows that a fetch is out. */}
          <button className="btn btn-outline btn-sm" onClick={fetchInvoices} disabled={refreshing}
                  aria-label="Refresh the list" title="Refresh the list">
            {refreshing ? <span className="btn-spinner" style={{ borderColor: 'rgba(0,0,0,0.15)', borderTopColor: 'var(--accent)' }} /> : '↻'}
          </button>
          {/* Only once something is in Xero; before that there is nothing to ask about. */}
          {invoices.some(i => i.xeroInvoiceId) && (
            <button className="btn btn-outline btn-sm" onClick={handleRefreshFromXero} disabled={syncingXero}
                    title="Ask Xero now whether posted records were approved, paid, voided or deleted there"
                    style={{ whiteSpace: 'nowrap' }}>
              {syncingXero ? 'Checking Xero…' : 'Refresh from Xero'}
            </button>
          )}

          {selected.size > 0 && (
            <button
              className="btn btn-sm"
              disabled={deleteLoading}
              onClick={promptDeleteSelected}
              style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.25)', whiteSpace: 'nowrap', animation: 'scaleIn 0.15s ease' }}
            >
              {deleteLoading ? '...' : `🗑 Delete selected (${selected.size})`}
            </button>
          )}

          {invoices.length > 0 && selected.size === 0 && (
            <button
              className="btn btn-sm"
              disabled={clearing}
              onClick={handleClearCache}
              style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)', whiteSpace: 'nowrap' }}
            >
              {clearing ? '...' : '🗑 Clear all'}
            </button>
          )}
        </div>

        {/* A list that loaded once and then failed to refresh keeps its rows,
            and says they may be out of date. */}
        {loaded && loadError && (
          <RetryAlert message={`Could not refresh the list — showing it as last loaded. ${loadError}`}
                      onRetry={fetchInvoices} busy={refreshing} />
        )}

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: '28px 0' }}>
            <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
            Loading invoices...
          </div>
        ) : !loaded ? (
          // Never loaded at all. The empty state here used to say "No bills
          // yet", which is a claim about the account this page could not check.
          <RetryAlert message={`Could not load your ${activeTab.long.toLowerCase()}. ${loadError}`}
                      onRetry={fetchInvoices} busy={refreshing} style={{ marginBottom: 0 }} />
        ) : filtered.length === 0 ? (
          // Three different situations read very differently, and lumping them
          // under "No invoices found" leaves someone on an empty Claims tab
          // waiting for a watcher that is never going to produce one.
          <div className="empty-state">
            <div className="empty-state-icon">{tab === 'claims' ? '🧾' : '📭'}</div>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>
              {tabRows.length > 0
                ? `No ${activeTab.long.toLowerCase()} match these filters`
                : `No ${activeTab.long.toLowerCase()} yet`}
            </div>
            <div style={{ fontSize: 13 }}>
              {tabRows.length > 0
                ? 'Try adjusting the status filter or search term'
                : tab === 'claims'
                  ? 'Add one above, import a claim form, or photograph receipts with your phone'
                  : tab === 'ap'
                    ? 'They arrive by email once the watcher is running — or add a PDF above'
                    : 'They arrive as the emailed template — or type one in, or import a spreadsheet, above'}
            </div>
          </div>
        ) : isMobile ? <MobileList openRecord={openRecord} invoices={invoices} selected={selected} deleteTarget={deleteTarget} deleteLoading={deleteLoading} promptDeleteOne={promptDeleteOne} toggleSelect={toggleSelect} filtered={filtered} allFilteredSelected={allFilteredSelected} toggleSelectAll={toggleSelectAll} groups={groups} isOpen={isOpen} toggleGroup={toggleGroup} /> : <DesktopTable user={user} openRecord={openRecord} invoices={invoices} selected={selected} deleteTarget={deleteTarget} deleteLoading={deleteLoading} promptDeleteOne={promptDeleteOne} toggleSelect={toggleSelect} allFilteredSelected={allFilteredSelected} toggleSelectAll={toggleSelectAll} groups={groups} isOpen={isOpen} toggleGroup={toggleGroup} />}
      </div>

      {/* Floating Mobile Selection Bar */}
      {isMobile && selected.size > 0 && <MobileSelectionBar selected={selected} setSelected={setSelected} deleteLoading={deleteLoading} promptDeleteSelected={promptDeleteSelected} />}

      <DeleteConfirmModal
        isOpen={!!deleteTarget}
        title={deleteTarget?.type === 'bulk' ? 'Delete Selected Items' : (deleteTarget?.invoice?.invoiceType === 'EXPENSE' || deleteTarget?.invoice?.receiptFile ? 'Delete Receipt' : 'Delete Invoice')}
        itemName={deleteTarget?.invoice ? (deleteTarget.invoice.vendorName || deleteTarget.invoice.invoiceNumber || deleteTarget.invoice.id) : undefined}
        isExpense={deleteTarget?.invoice ? (deleteTarget.invoice.invoiceType === 'EXPENSE' || !!deleteTarget.invoice.receiptFile) : false}
        count={deleteTarget?.type === 'bulk' ? deleteTarget.count : 1}
        confirmLabel={deleteTarget?.type === 'bulk' ? `Delete ${deleteTarget.count} Items` : (deleteTarget?.invoice?.invoiceType === 'EXPENSE' || deleteTarget?.invoice?.receiptFile ? 'Delete Receipt' : 'Delete Invoice')}
        loading={deleteLoading}
        onConfirm={handleConfirmDelete}
        onClose={() => { if (!deleteLoading) setDeleteTarget(null); }}
      />

      {claimModalJobId && (
        <ClaimImport
          initialJobId={claimModalJobId}
          onClose={() => { setClaimModalJobId(null); setTab('claims'); fetchInvoices(); }}
          onImported={() => { setClaimModalJobId(null); setTab('claims'); fetchInvoices(); }}
        />
      )}
    </div>
  );
}
