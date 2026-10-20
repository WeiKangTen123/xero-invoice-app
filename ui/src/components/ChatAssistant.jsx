import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useViewMode } from '../context/ViewModeContext';
import { fmtMoney } from '../utils/format';
import { getVisibleInvoices } from '../utils/visible-invoices';
import { chatMode, DOCK_MIN_VIEWPORT, EXPANDED_KEY } from './chat-layout';

// The ⤢ choice, remembered on this browser. Storage can be refused (a private
// window, blocked site data); the chat then opens at its usual width.
function readExpanded() {
  try { return localStorage.getItem(EXPANDED_KEY) === '1'; } catch (_) { return false; }
}
function saveExpanded(on) {
  try { localStorage.setItem(EXPANDED_KEY, on ? '1' : '0'); } catch (_) { /* kept for this visit only */ }
}

// react-markdown + remark-gfm are the heaviest dependency in the bundle and are
// only needed once an assistant reply is on screen, so the renderer loads on
// demand rather than shipping with the entry chunk. The fallback prints the raw
// reply, which is already readable text — the chunk only upgrades it to tables
// and emphasis, so there is nothing to hide behind a spinner.
const MarkdownMessage = lazy(() => import('./MarkdownMessage'));

// Fired after a chat-confirmed action changes an invoice, so InvoiceReview (if open
// on that invoice) can refetch without ChatAssistant needing to know about it directly.
function notifyInvoiceChanged(invoiceId) {
  window.dispatchEvent(new CustomEvent('invoice-updated', { detail: { invoiceId } }));
}

function Spinner() {
  return <span style={{ width: 13, height: 13, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />;
}

// ── One proposal, rendered as a confirm/cancel card ─────────────────────────────
function ActionCard({ proposal, invoiceId }) {
  const [state, setState] = useState('pending'); // pending | working | done | cancelled | error
  const [error, setError] = useState('');
  const isBulk = proposal.type.startsWith('bulk_');
  const isXero = proposal.type === 'submit_to_xero' || proposal.type === 'bulk_submit_to_xero';

  async function applyOne(id) {
    if (proposal.type === 'field_update') {
      await api.patch(`/invoices/${id}`, { [proposal.field]: proposal.newValue });
    } else if (proposal.type === 'submit_to_xero') {
      await api.post(`/invoices/${id}/submit`, {});
    } else if (proposal.type === 'mark_reviewed') {
      await api.patch(`/invoices/${id}/status`, { status: 'reviewed' });
    }
    notifyInvoiceChanged(id);
  }

  async function confirm() {
    setState('working');
    setError('');
    try {
      if (proposal.type === 'bulk_field_update') {
        for (const item of proposal.items) {
          await api.patch(`/invoices/${item.invoiceId}`, { [proposal.field]: proposal.newValue });
          notifyInvoiceChanged(item.invoiceId);
        }
      } else if (proposal.type === 'bulk_submit_to_xero') {
        // Sequential with a gap — mirrors the existing submit-all endpoint's pacing
        // so a chat-triggered bulk submit can't flood Xero's 60-calls/minute limit.
        for (const item of proposal.items) {
          await api.post(`/invoices/${item.invoiceId}/submit`, {});
          notifyInvoiceChanged(item.invoiceId);
          await new Promise(r => setTimeout(r, 1500));
        }
      } else {
        await applyOne(proposal.invoiceId);
      }
      setState('done');
    } catch (err) {
      setError(err.message || 'Failed to apply');
      setState('error');
    }
  }

  function cancel() { setState('cancelled'); }

  // A plain object-literal lookup would evaluate every value up front — including
  // the bulk branches' `proposal.items.length` — even for a non-bulk proposal that
  // has no `items` at all, crashing the whole panel. A function only evaluates the
  // branch that's actually taken.
  function kindLabelFor(p) {
    switch (p.type) {
      case 'field_update':       return '✎ Field update';
      case 'submit_to_xero':     return '→ Xero action';
      case 'mark_reviewed':      return '✓ Mark reviewed';
      case 'bulk_field_update':  return `✎ Bulk field update — ${p.items.length} invoice${p.items.length > 1 ? 's' : ''}`;
      case 'bulk_submit_to_xero':return `→ Bulk Xero action — ${p.items.length} invoice${p.items.length > 1 ? 's' : ''}`;
      default:                  return '';
    }
  }
  const kindLabel = kindLabelFor(proposal);

  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border-card)', borderRadius: 12,
      boxShadow: 'var(--shadow-sm)', padding: '12px 13px', maxWidth: '94%', alignSelf: 'stretch',
      display: 'flex', flexDirection: 'column', gap: 9,
      ...(isXero ? { borderColor: 'rgba(245,158,11,0.35)', background: 'var(--warning-subtle)' } : {}),
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: isXero ? 'var(--warning)' : 'var(--accent)' }}>
        {kindLabel}
      </div>

      {!isBulk && proposal.label && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{proposal.label}</div>
      )}

      {proposal.type === 'field_update' && proposal.field === 'lineItems' && Array.isArray(proposal.newValue) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {proposal.newValue.map((item, i) => {
            const old = Array.isArray(proposal.oldValue) ? proposal.oldValue[i] : null;
            const changed = old && Number(old.unitAmount) !== Number(item.unitAmount);
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, background: 'var(--bg-hover)', borderRadius: 8, padding: '6px 9px' }}>
                <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{item.description}</span>
                {changed ? (
                  <>
                    <span style={{ color: 'var(--text-muted)', textDecoration: 'line-through' }}>{fmtMoney(old.unitAmount)}</span>
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                    <span style={{ color: 'var(--success)', fontWeight: 700 }}>{fmtMoney(item.unitAmount)}</span>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>{fmtMoney(item.unitAmount)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {proposal.type === 'field_update' && proposal.field !== 'lineItems' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, background: 'var(--bg-hover)', borderRadius: 8, padding: '7px 9px' }}>
          <span style={{ color: 'var(--text-muted)', textDecoration: 'line-through' }}>{String(proposal.oldValue ?? '—')}</span>
          <span style={{ color: 'var(--text-muted)' }}>→</span>
          <span style={{ color: 'var(--success)', fontWeight: 700 }}>{String(proposal.newValue)}</span>
        </div>
      )}

      {(proposal.type === 'submit_to_xero' || proposal.type === 'mark_reviewed') && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{proposal.label}</div>
      )}

      {isBulk && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 160, overflowY: 'auto' }}>
          {proposal.items.map((item, i) => (
            <div key={i} style={{ fontSize: 12, background: 'var(--bg-hover)', borderRadius: 6, padding: '5px 8px' }}>
              {item.label}
              {proposal.type === 'bulk_field_update' && (
                <span style={{ color: 'var(--text-muted)' }}> — {String(item.oldValue ?? '—')} → <span style={{ color: 'var(--success)', fontWeight: 600 }}>{String(proposal.newValue)}</span></span>
              )}
            </div>
          ))}
        </div>
      )}

      {state === 'pending' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={isXero ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
            style={isXero ? { background: 'var(--warning)', color: '#1a1206' } : undefined}
            onClick={confirm}
          >
            ✓ Confirm
          </button>
          <button className="btn btn-outline btn-sm" onClick={cancel}>Cancel</button>
        </div>
      )}
      {state === 'working' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}><Spinner /> Applying…</div>
      )}
      {state === 'done' && (
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--success)' }}>✓ Done</div>
      )}
      {state === 'cancelled' && (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>— Cancelled, no changes made</div>
      )}
      {state === 'error' && (
        <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>✕ {error}</div>
      )}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
// onDockChange(width) tells Layout how much room to keep free on the right of
// the page: the chat's width while it is docked beside the page, else 0.
export default function ChatAssistant({ onDockChange }) {
  const { isMobile } = useViewMode();
  const location = useLocation();
  const params   = useParams();
  const pinnedId = location.pathname.startsWith('/invoices/') ? params.id : null;

  const [open,     setOpen]     = useState(false);
  const [expanded, setExpanded] = useState(readExpanded);
  // The window's width, read again only when it crosses the docking width:
  // that is all chatMode asks of it, and a resize listener would re-render
  // every message on each pixel of a drag.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql  = window.matchMedia(`(min-width: ${DOCK_MIN_VIEWPORT}px)`);
    const sync = () => setViewportWidth(window.innerWidth);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);

  // Docked (a column beside the page, which makes room for it), floating over
  // the page, or the whole screen on a phone (chat-layout.js). `shape` is how
  // it looks open, kept while it slides away after closing.
  const layout = chatMode({ open, isMobile, viewportWidth, expanded });
  const shape  = chatMode({ open: true, isMobile, viewportWidth, expanded });
  const docked = layout.mode === 'docked';
  const dockWidth = docked ? layout.width : 0;
  useEffect(() => { onDockChange?.(dockWidth); }, [onDockChange, dockWidth]);
  useEffect(() => () => onDockChange?.(0), [onDockChange]);

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    saveExpanded(next);
  }
  const [pinInfo,  setPinInfo]  = useState(null);
  const [messages, setMessages] = useState([]); // { role, content, proposals? }
  const [input,    setInput]    = useState('');
  const [sending,  setSending]  = useState(false);
  const [error,    setError]    = useState('');
  const scrollRef = useRef(null);
  const taRef     = useRef(null);
  const panelRef  = useRef(null);
  const buttonRef = useRef(null);

  // Which Xero company, and which period, a financial answer is about. The
  // server used to take the first connected company whatever the dashboard was
  // showing, so with two connected the assistant could answer about the other
  // one. Every message now names the company: the one picked below, or the one
  // the dashboard announces with a 'xero-dashboard-context' event
  // ({ tenantId, period }). '' leaves it to the server — the default company
  // for sending, else the first connected. The server checks the company is
  // this account's own, and the period, before using either.
  const [companies, setCompanies] = useState(null); // null until loaded
  const [tenantId,  setTenantId]  = useState('');
  const [period,    setPeriod]    = useState(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.get('/xero/tenants')
      .then(d => { if (live) setCompanies(Array.isArray(d.tenants) ? d.tenants : []); })
      .catch(() => { if (live) setCompanies([]); });
    return () => { live = false; };
  }, [open]);

  useEffect(() => {
    function onDashboardContext(e) {
      const d = (e && e.detail) || {};
      if (typeof d.tenantId === 'string') setTenantId(d.tenantId);
      if (d.period && typeof d.period === 'object') setPeriod(d.period);
    }
    window.addEventListener('xero-dashboard-context', onDashboardContext);
    return () => window.removeEventListener('xero-dashboard-context', onDashboardContext);
  }, []);

  // A company chosen earlier and since disconnected falls back to the server's
  // choice rather than failing every message.
  const activeTenantId = companies && tenantId && !companies.some(c => c.tenantId === tenantId) ? '' : tenantId;

  // Close when pressing 'Escape' or clicking outside the chat panel. Docked,
  // the chat sits beside the page rather than over it, so working on the page
  // leaves it open, and only an Escape pressed inside the chat closes it (one
  // pressed on the page is for the page, such as closing one of its dialogs).
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e) {
      if (e.key !== 'Escape') return;
      if (docked && !panelRef.current?.contains(document.activeElement)) return;
      setOpen(false);
    }

    function handleClickOutside(e) {
      if (docked) return;
      if (
        panelRef.current && !panelRef.current.contains(e.target) &&
        buttonRef.current && !buttonRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open, docked]);

  // Focus follows the panel: into the message box when it opens, back to the
  // launcher when it closes — but only if focus was inside the panel, so
  // closing it by clicking elsewhere does not pull focus away from that click.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      taRef.current?.focus({ preventScroll: true });
    } else if (wasOpen.current && panelRef.current?.contains(document.activeElement)) {
      buttonRef.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!pinnedId) { setPinInfo(null); return; }
    api.get(`/invoices/${pinnedId}`).then(d => setPinInfo(d.invoice)).catch(() => setPinInfo(null));
  }, [pinnedId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight + 200;
  }, [messages, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setError('');

    const history = messages.map(m => ({ role: m.role, content: m.content }));
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setSending(true);

    try {
      // visibleInvoices: the AR & AP list as last shown, so "#5" is its row 5
      // (utils/visible-invoices.js), asked from the list or from a record
      // opened from it.
      const d = await api.post('/chat', {
        message: text, history,
        invoiceId: pinnedId || undefined,
        tenantId:  activeTenantId || undefined,
        period:    period || undefined,
        visibleInvoices: getVisibleInvoices(),
      });
      setMessages(prev => [...prev, { role: 'assistant', content: d.reply, proposals: d.proposals || [] }]);
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  return (
    <>
      {/* Hidden while the panel is open. It sat at bottom-right on zIndex 200
          with the panel on 199, so it floated ON TOP of the message box and
          covered the send button. The panel header already has its own close,
          which makes this one redundant exactly when it is in the way.
          Kept mounted so the fade is not a pop. */}
      <button
        ref={buttonRef}
        onClick={() => setOpen(true)}
        title="Ask about your invoices"
        aria-label="Open the invoice assistant"
        aria-expanded={open}
        aria-hidden={open}
        // Invisible while the panel is open, so out of the Tab order too.
        tabIndex={open ? -1 : 0}
        // Size and corner from globals.css (--fab-size, --fab-offset), which
        // also define --fab-clearance: the room every bottom-pinned bar keeps
        // free on its right so this button never covers a Save or Send.
        style={{
          position: 'fixed',
          right: 'var(--fab-offset)',
          bottom: isMobile ? 'calc(var(--bottom-nav-total) + 14px)' : 'var(--fab-offset)',
          width: 'var(--fab-size)',
          height: 'var(--fab-size)',
          borderRadius: '50%',
          background: 'var(--accent-gradient)',
          border: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: 'var(--shadow-lg)',
          color: '#fff',
          fontSize: isMobile ? 19 : 21,
          zIndex: 200,
          cursor: open ? 'default' : 'pointer',
          opacity: open ? 0 : 1,
          pointerEvents: open ? 'none' : 'auto',
          transform: open ? 'scale(0.8)' : 'scale(1)',
          transition: 'opacity 0.18s ease, transform 0.18s ease',
        }}
      >
        💬
      </button>

      {/* Slid off-screen when closed, but still in the page, and its buttons
          and message box were still reached by Tab — focus vanished off the
          edge of the screen. `visibility: hidden` takes it out of the Tab
          order and away from screen readers; it flips only after the slide
          out has finished, so closing still animates.

          On the web it starts under the header, which stays whole above it:
          the page's own controls there (Setup's Save box) are never covered.
          Docked, it is a column beside the page and Layout keeps its width
          free (onDockChange); floating, it is over the page with a shadow.
          zIndex 201 either way: over the header (50), sidebar (100) and phone
          nav (90), and under the admin's account window (300/301), the
          dialogs (Modal, 1000) and the toasts (1200), which all open over it. */}
      <div
        ref={panelRef}
        role={shape.mode === 'docked' ? 'complementary' : 'dialog'}
        aria-label="Invoice assistant"
        aria-hidden={!open}
        style={{
        visibility: open ? 'visible' : 'hidden',
        position: 'fixed',
        top: shape.mode === 'fullscreen' ? 0 : 'var(--header-height)',
        right: 0,
        bottom: 0,
        width: shape.width,
        maxWidth: shape.mode === 'overlay' ? '92vw' : '100vw',
        background: 'var(--bg-card)',
        borderLeft: shape.mode === 'fullscreen' ? 'none' : '1px solid var(--border)',
        boxShadow: shape.mode === 'docked' ? 'none' : '-12px 0 40px rgba(0,0,0,0.25)',
        display: 'flex',
        flexDirection: 'column',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: open
          ? 'transform 0.25s cubic-bezier(0.4,0,0.2,1), width 0.2s ease, visibility 0s'
          : 'transform 0.25s cubic-bezier(0.4,0,0.2,1), width 0.2s ease, visibility 0s linear 0.25s',
        zIndex: 201,
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ color: 'var(--accent)' }}>✦</span> Invoice Assistant
            </h2>
            {/* Wider for a wide table, and back; docked only, where the page
                makes room for it. Remembered on this browser. */}
            {shape.mode === 'docked' && (
              <button type="button" onClick={toggleExpanded} aria-pressed={expanded}
                      aria-label={expanded ? 'Make the assistant narrower' : 'Make the assistant wider'}
                      title={expanded ? 'Narrower' : 'Wider'}
                      style={{ marginLeft: 'auto', background: expanded ? 'var(--accent-subtle)' : 'none', border: 'none', borderRadius: 6, cursor: 'pointer', color: expanded ? 'var(--accent)' : 'var(--text-muted)', fontSize: 15, padding: '2px 6px' }}>⤢</button>
            )}
            <button onClick={() => setOpen(false)} aria-label="Close the assistant" title="Close"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 15 }}>✕</button>
          </div>
          {companies && companies.length > 1 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              Company
              <select
                className="form-input" style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '5px 8px' }}
                value={activeTenantId} onChange={e => setTenantId(e.target.value)}
              >
                <option value="">Default company</option>
                {companies.map(c => <option key={c.tenantId} value={c.tenantId}>{c.tenantName}</option>)}
              </select>
            </label>
          )}
          {pinnedId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--accent-subtle)', color: 'var(--accent)', borderRadius: 8, padding: '7px 10px', fontSize: 12, fontWeight: 600 }}>
              📄 {pinInfo ? `${pinInfo.vendorName || 'Invoice'} · #${pinInfo.invoiceNumber || pinnedId}` : 'Loading…'}
              <span style={{ marginLeft: 'auto', fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>this invoice</span>
            </div>
          )}
        </div>

        {/* Never scrolls sideways: a wide table scrolls inside its own box
            (MarkdownMessage.jsx), and every flex item on the way down may
            shrink (minWidth 0) rather than grow to the table's width. */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 11 }}>
          {messages.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Ask me to look up or change invoice details — e.g. "change the invoice number to 2026099", "show me pending invoices from Branworks", or "what is #5?" (a row of the AR &amp; AP list, by its # number). I'll always show you the exact change before anything is saved.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', minWidth: 0 }}>
              {m.role === 'user' ? (
                <div style={{ maxWidth: '84%', minWidth: 0, overflowWrap: 'anywhere', padding: '8px 12px', borderRadius: 14, borderBottomRightRadius: 4, fontSize: 13, lineHeight: 1.5, background: 'var(--accent-gradient)', color: '#fff' }}>
                  {m.content}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, flex: 1, minWidth: 0 }}>
                  {m.content && (
                    // Clipped only top and bottom, to its rounded corners;
                    // anything wide still scrolls rather than being cut off.
                    <div style={{ maxWidth: '94%', minWidth: 0, overflowX: 'auto', overflowY: 'hidden', padding: '8px 12px', borderRadius: 14, borderBottomLeftRadius: 4, fontSize: 13, lineHeight: 1.5, background: 'var(--bg-hover)', color: 'var(--text-primary)' }}>
                      <Suspense fallback={<div className="chat-md" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>}>
                        <MarkdownMessage content={m.content} />
                      </Suspense>
                    </div>
                  )}
                  {(m.proposals || []).map((p, pi) => (
                    <ActionCard key={pi} proposal={p} />
                  ))}
                </div>
              )}
            </div>
          ))}
          {sending && (
            <div style={{ display: 'flex', gap: 4, padding: '9px 12px', background: 'var(--bg-hover)', borderRadius: 14, borderBottomLeftRadius: 4, width: 'fit-content' }}>
              {[0, 1, 2].map(i => (
                <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)', animation: `bounce 1.2s ${i * 0.15}s infinite ease-in-out` }} />
              ))}
            </div>
          )}
          {error && <div className="alert alert-error" style={{ fontSize: 12 }}><span className="alert-icon">✕</span>{error}</div>}
        </div>

        {/* The panel is fixed to bottom:0 and sits above the bottom nav, so the
            composer only has to clear the home indicator — not the nav too. */}
        <div style={{
          padding: '10px 12px',
          paddingBottom: isMobile ? 'calc(10px + var(--safe-bottom))' : 10,
          borderTop: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 12, padding: '7px 7px 7px 12px' }}>
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              placeholder={pinnedId ? 'Ask about this invoice' : 'e.g. change the invoice number to 2026099'}
              onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 90) + 'px'; }}
              onKeyDown={onKeyDown}
              aria-label="Message the assistant"
              style={{ flex: 1, border: 'none', background: 'none', resize: 'none', outline: 'none', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5, maxHeight: 90, padding: '3px 0' }}
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              aria-label="Send message"
              title="Send"
              style={{ width: 29, height: 29, borderRadius: 8, border: 'none', cursor: 'pointer', background: 'var(--accent-gradient)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: sending || !input.trim() ? 0.5 : 1 }}
            >
              ➤
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-3px); opacity: 1; } }

        .chat-md p { margin: 0 0 6px; }
        .chat-md p:last-child { margin-bottom: 0; }
        .chat-md strong { color: var(--text-primary); font-weight: 700; }
        .chat-md ul, .chat-md ol { margin: 4px 0; padding-left: 18px; }
        .chat-md li { margin-bottom: 2px; }
        .chat-md li:last-child { margin-bottom: 0; }
        .chat-md code { background: var(--bg-input); border-radius: 4px; padding: 1px 5px; font-size: 12px; font-family: ui-monospace, 'SF Mono', Consolas, monospace; }
        .chat-md p, .chat-md li { overflow-wrap: anywhere; }
        .chat-md pre { overflow-x: auto; max-width: 100%; }

        /* A table fills the bubble, and when its columns cannot fit it
           scrolls inside this box instead of being squeezed or cut off. */
        .chat-md-table { max-width: 100%; overflow-x: auto; margin: 4px 0 2px; }
        .chat-md table {
          border-collapse: collapse; min-width: 100%; font-size: 12.5px;
          font-variant-numeric: tabular-nums;
        }
        .chat-md th, .chat-md td {
          text-align: left; padding: 6px 9px; border: 1px solid var(--border); vertical-align: top;
        }
        .chat-md th {
          background: var(--bg-secondary); font-weight: 700; font-size: 11px; white-space: nowrap;
          text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted);
        }
        /* Amounts, dates and references on one line, amounts to the right;
           a sentence wraps, but no thinner than a few words. */
        .chat-md td { min-width: 6em; }
        .chat-md td.cell-num { text-align: right; white-space: nowrap; }
        .chat-md td.cell-short { white-space: nowrap; }
        .chat-md td.cell-long { min-width: 12em; }
        .chat-md tr:nth-child(even) td { background: var(--bg-secondary); }
      `}</style>
    </>
  );
}
