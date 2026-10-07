import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api/client';
import { formatDateTime } from '../../utils/formatDate';
import { actorLabel } from '../../utils/audit';

// ── History ───────────────────────────────────────────────────────────────────
// What happened to this record, newest first: how it arrived, each edit, each
// change of status, what Xero said, from the audit trail the server keeps
// (GET /api/invoices/:id/events). Open by default on a desktop, where it sits
// beside the document; closed on a phone, where everything is one column and
// a long history would bury what is below it. Fetched only while open.

const SPINNER = { width: 12, height: 12, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' };

function Changes({ changes }) {
  return (
    <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: '8px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, lineHeight: 1.6 }}>
      {changes.map(c => (
        <li key={c.field} style={{ wordBreak: 'break-word' }}>
          <span style={{ color: 'var(--text-muted)' }}>{c.label}: </span>
          <span style={{ color: 'var(--text-secondary)', textDecoration: c.from ? 'line-through' : 'none' }}>{c.from ?? '—'}</span>
          {' → '}
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{c.to ?? '—'}</span>
        </li>
      ))}
    </ul>
  );
}

// `refreshKey` changes whenever the record does (a save, a status move, a
// send landing), so an open history picks up the event that change wrote.
export default function HistoryCard({ id, user, isMobile, refreshKey }) {
  const [open,       setOpen]       = useState(!isMobile);
  const [events,     setEvents]     = useState(null);   // null = not loaded yet
  const [nextBefore, setNextBefore] = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [shown,      setShown]      = useState(() => new Set());   // event ids with their changes open
  // An answer for an older request (the record changed again meanwhile)
  // must not overwrite a newer one.
  const latest = useRef(0);

  const load = useCallback(async (before = null) => {
    const ask = ++latest.current;
    setLoading(true);
    try {
      const d = await api.get(`/invoices/${id}/events${before ? `?before=${before}` : ''}`);
      if (ask !== latest.current) return;
      setEvents(prev => (before ? [...(prev || []), ...(d.events || [])] : (d.events || [])));
      setNextBefore(d.nextBefore || null);
      setError('');
    } catch (err) {
      if (ask === latest.current) setError(err.message || 'Could not load the history');
    } finally {
      if (ask === latest.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => { if (open) load(); }, [open, load, refreshKey]);

  function toggleChanges(eventId) {
    setShown(prev => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId); else next.add(eventId);
      return next;
    });
  }

  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}
      >
        <span style={{ display: 'inline-block', transition: 'transform 0.15s ease', transform: open ? 'rotate(90deg)' : 'none' }}>▸</span>
        History
        {loading && <span style={{ ...SPINNER, marginLeft: 6 }} aria-label="Loading" />}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {error && (
            <div className="alert alert-error" style={{ marginBottom: 8, alignItems: 'center' }}>
              <span className="alert-icon">✕</span>
              <span style={{ flex: 1 }}>{error}</span>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => load()}>Retry</button>
            </div>
          )}
          {events && events.length === 0 && !error && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>Nothing recorded for this record yet.</div>
          )}
          {events && events.length > 0 && (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {events.map((e, i) => {
                const changes = Array.isArray(e.details?.changes) ? e.details.changes : [];
                const expanded = shown.has(e.id);
                return (
                  <li key={e.id} style={{ padding: '8px 0', borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.45, wordBreak: 'break-word' }}>{e.summary}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                      <span>{formatDateTime(e.at, user?.timezone)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{actorLabel(e, user)}</span>
                      {changes.length > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleChanges(e.id)}
                          aria-expanded={expanded}
                          style={{ marginLeft: 'auto', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: 'var(--accent)' }}
                        >
                          {expanded ? 'Hide changes' : `Show ${changes.length === 1 ? 'change' : `${changes.length} changes`}`}
                        </button>
                      )}
                    </div>
                    {expanded && <Changes changes={changes} />}
                  </li>
                );
              })}
            </ol>
          )}
          {nextBefore && (
            <button type="button" className="btn btn-outline btn-sm" style={{ marginTop: 8 }} disabled={loading} onClick={() => load(nextBefore)}>
              Show older
            </button>
          )}
        </div>
      )}
    </div>
  );
}
