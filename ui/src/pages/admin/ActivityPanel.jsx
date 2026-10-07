import { useState, useEffect, useRef } from 'react';
import { api } from '../../api/client';
import RetryAlert from '../../components/RetryAlert';
import { formatDateTime } from '../../utils/formatDate';
import { activityQuery } from '../../utils/audit';

// ── Activity panel ────────────────────────────────────────────────────────────
// What admins have done to accounts (and each person's own password changes),
// newest first, from the server's admin trail (GET /api/admin/events). Kept
// apart from Logs on purpose: a log rotates within days and is for debugging;
// this is the record of who changed whose account, kept for two years, and
// it still names an account after it has been deleted.

const EMPTY_FILTERS = { userId: '', action: '', from: '', to: '' };

export default function ActivityPanel({ timezone }) {
  const [filters,    setFilters]    = useState(EMPTY_FILTERS);
  const [accounts,   setAccounts]   = useState([]);
  const [actions,    setActions]    = useState({});
  const [events,     setEvents]     = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [loadErr,    setLoadErr]    = useState('');
  const latest = useRef(0);
  // The filters the list on screen was searched with. "Show older" pages
  // with these, not with a date typed since and not yet searched.
  const applied = useRef(EMPTY_FILTERS);

  // `f` is passed in rather than read from state: a filter that is set and
  // searched in the same breath would otherwise search with the old value.
  async function fetchEvents(f = filters, before = null) {
    const ask = ++latest.current;
    if (!before) applied.current = f;
    setLoading(true);
    try {
      const qs = activityQuery(f, before);
      const d = await api.get(`/admin/events${qs ? `?${qs}` : ''}`);
      if (ask !== latest.current) return;
      setEvents(prev => (before ? [...prev, ...(d.events || [])] : (d.events || [])));
      setNextBefore(d.nextBefore || null);
      if (d.actions) setActions(d.actions);
      setLoadErr('');
    } catch (err) {
      if (ask === latest.current) setLoadErr(err.message || 'Could not load the activity');
    } finally {
      if (ask === latest.current) setLoading(false);
    }
  }

  useEffect(() => {
    fetchEvents(EMPTY_FILTERS);
    // The account filter lists current accounts; a deleted one's events are
    // still in the unfiltered list, under its email.
    api.get('/admin/users').then(d => setAccounts(d.users || [])).catch(() => setAccounts([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function setFilter(key, value) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    // Picking from a list searches straight away; dates wait for Search, so
    // typing a date does not fire a request per keystroke.
    if (key === 'userId' || key === 'action') fetchEvents(next);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    fetchEvents(EMPTY_FILTERS);
  }

  const filtered = Object.values(filters).some(Boolean);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="card-title">Activity</div>
          <div className="card-subtitle" style={{ marginBottom: 0 }}>
            What admins changed on accounts, and password changes. Kept for two years.
          </div>
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => fetchEvents()} aria-label="Refresh activity" title="Refresh activity">↻</button>
      </div>

      <form
        onSubmit={e => { e.preventDefault(); fetchEvents(); }}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 14 }}
      >
        <select className="form-input" aria-label="Account" value={filters.userId}
          onChange={e => setFilter('userId', e.target.value)} style={{ maxWidth: 230 }}>
          <option value="">All accounts</option>
          {accounts.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}
        </select>
        <select className="form-input" aria-label="Action" value={filters.action}
          onChange={e => setFilter('action', e.target.value)} style={{ maxWidth: 230 }}>
          <option value="">All actions</option>
          {Object.entries(actions).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          From
          <input type="date" className="form-input" value={filters.from} max={filters.to || undefined}
            onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} style={{ maxWidth: 160 }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
          To
          <input type="date" className="form-input" value={filters.to} min={filters.from || undefined}
            onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} style={{ maxWidth: 160 }} />
        </label>
        <button type="submit" className="btn btn-primary btn-sm">Search</button>
        {filtered && <button type="button" className="btn btn-outline btn-sm" onClick={clearFilters}>Clear</button>}
      </form>

      {loadErr && (
        <RetryAlert message={`Could not load the activity. ${loadErr}`} onRetry={() => fetchEvents(applied.current)} busy={loading} style={{ marginBottom: 12 }} />
      )}

      {loading && !events.length ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: '16px 0' }}>
          <span style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
          Loading...
        </div>
      ) : events.length === 0 ? (
        !loadErr && (
          <div className="empty-state" style={{ padding: '30px 0' }}>
            <div className="empty-state-icon">🕑</div>
            <div>{filtered ? 'Nothing matches these filters' : 'No admin activity recorded yet'}</div>
          </div>
        )
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {events.map((e, i) => (
            <li key={e.id} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', padding: '10px 0', borderTop: i > 0 ? '1px solid var(--border)' : 'none', alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', minWidth: 140 }}>
                {formatDateTime(e.at, timezone)}
              </span>
              <span style={{ flex: '1 1 260px', fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                {e.summary}
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  by {e.actorEmail || 'an account since deleted'}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}

      {nextBefore && (
        <button type="button" className="btn btn-outline btn-sm" style={{ marginTop: 10 }} disabled={loading}
          onClick={() => fetchEvents(applied.current, nextBefore)}>
          Show older
        </button>
      )}
    </div>
  );
}
