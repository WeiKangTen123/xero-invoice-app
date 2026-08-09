import { useState, useRef, useEffect } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client';

// Assistant replies are markdown (the model is asked to use tables for multi-field
// summaries) — render it properly instead of showing literal ** and | characters.
// User messages are NOT rendered as markdown — a user's own words should show up
// exactly as typed, not be reinterpreted as formatting.
function MarkdownMessage({ content }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

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
      boxShadow: 'var(--shadow-sm)', padding: '12px 13px', maxWidth: '94%',
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
                    <span style={{ color: 'var(--text-muted)', textDecoration: 'line-through' }}>{Number(old.unitAmount).toFixed(2)}</span>
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                    <span style={{ color: 'var(--success)', fontWeight: 700 }}>{Number(item.unitAmount).toFixed(2)}</span>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>{Number(item.unitAmount).toFixed(2)}</span>
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
export default function ChatAssistant() {
  const location = useLocation();
  const params   = useParams();
  const pinnedId = location.pathname.startsWith('/invoices/') ? params.id : null;

  const [open,     setOpen]     = useState(false);
  const [pinInfo,  setPinInfo]  = useState(null);
  const [messages, setMessages] = useState([]); // { role, content, proposals? }
  const [input,    setInput]    = useState('');
  const [sending,  setSending]  = useState(false);
  const [error,    setError]    = useState('');
  const scrollRef = useRef(null);
  const taRef     = useRef(null);

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
      const d = await api.post('/chat', { message: text, history, invoiceId: pinnedId || undefined });
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
      <button
        onClick={() => setOpen(v => !v)}
        title="Ask about your invoices"
        style={{
          position: 'fixed', right: 26, bottom: 26, width: 54, height: 54, borderRadius: '50%',
          background: 'var(--accent-gradient)', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: 'var(--shadow-lg)', color: '#fff', fontSize: 21, zIndex: 200,
        }}
      >
        {open ? '✕' : '💬'}
      </button>

      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 400, maxWidth: '92vw',
        background: 'var(--bg-card)', borderLeft: '1px solid var(--border)',
        boxShadow: '-12px 0 40px rgba(0,0,0,0.18)',
        display: 'flex', flexDirection: 'column',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
        zIndex: 199,
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ color: 'var(--accent)' }}>✦</span> Invoice Assistant
            </h2>
            <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 15 }}>✕</button>
          </div>
          {pinnedId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--accent-subtle)', color: 'var(--accent)', borderRadius: 8, padding: '7px 10px', fontSize: 12, fontWeight: 600 }}>
              📄 {pinInfo ? `${pinInfo.vendorName || 'Invoice'} · #${pinInfo.invoiceNumber || pinnedId}` : 'Loading…'}
              <span style={{ marginLeft: 'auto', fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>this invoice</span>
            </div>
          )}
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 11 }}>
          {messages.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Ask me to look up or change invoice details — e.g. "change the invoice number to 2026099", or "show me pending invoices from Branworks". I'll always show you the exact change before anything is saved.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              {m.role === 'user' ? (
                <div style={{ maxWidth: '84%', padding: '8px 12px', borderRadius: 14, borderBottomRightRadius: 4, fontSize: 13, lineHeight: 1.5, background: 'var(--accent-gradient)', color: '#fff' }}>
                  {m.content}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '100%' }}>
                  {m.content && (
                    <div style={{ maxWidth: '94%', padding: '8px 12px', borderRadius: 14, borderBottomLeftRadius: 4, fontSize: 13, lineHeight: 1.5, background: 'var(--bg-hover)', color: 'var(--text-primary)' }}>
                      <MarkdownMessage content={m.content} />
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

        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 12, padding: '7px 7px 7px 12px' }}>
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              placeholder="e.g. change the invoice number to 2026099"
              onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 90) + 'px'; }}
              onKeyDown={onKeyDown}
              style={{ flex: 1, border: 'none', background: 'none', resize: 'none', outline: 'none', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5, maxHeight: 90, padding: '3px 0' }}
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
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
        .chat-md table {
          border-collapse: collapse; width: 100%; margin: 4px 0 2px; font-size: 12.5px;
          font-variant-numeric: tabular-nums;
        }
        .chat-md th, .chat-md td {
          text-align: left; padding: 6px 9px; border: 1px solid var(--border);
        }
        .chat-md th {
          background: var(--bg-secondary); font-weight: 700; font-size: 11px;
          text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted);
        }
        .chat-md tr:nth-child(even) td { background: var(--bg-secondary); }
      `}</style>
    </>
  );
}
