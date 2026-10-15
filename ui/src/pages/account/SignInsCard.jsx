import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client';
import RetryAlert from '../../components/RetryAlert';
import { useAuth } from '../../context/AuthContext';
import { formatDateTime } from '../../utils/formatDate';
import { signInLabel, signInTone, signInEvents } from './account';

// The last twenty sign-in events the server kept for this account (GET
// /api/auth/sign-ins): sign-ins, wrong passwords, locks and unlocks, each
// with the address it came from. For the question "was that me?" — a wrong
// password from an address you do not know is the moment to change yours.
export default function SignInsCard({ idx = 2 }) {
  const { user } = useAuth();
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(true);
  // A failed load is said as one, never shown as a quiet account.
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(signInEvents(await api.get('/auth/sign-ins')));
      setError('');
    } catch (err) {
      setError(err.message || 'Could not load the sign-ins');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: 'var(--accent-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
        }}>🕒</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">Recent sign-ins</div>
          <div className="card-subtitle" style={{ marginBottom: 0 }}>
            The last sign-ins and failed attempts on this account, and where they came from.
          </div>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={load} disabled={loading} aria-label="Refresh sign-ins" title="Refresh sign-ins">↻</button>
      </div>

      {error && (
        <RetryAlert message={`Could not load the sign-ins. ${error}`} onRetry={load} busy={loading} style={{ marginTop: 12 }} />
      )}

      {loading && events.length === 0 && !error ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: '16px 0', fontSize: 13 }}>
          <span style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
          Loading...
        </div>
      ) : events.length === 0 ? (
        !error && (
          <div className="empty-state" style={{ padding: '24px 0' }}>
            <div className="empty-state-icon">🕒</div>
            <div>No sign-ins recorded yet.</div>
          </div>
        )
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table className="data-table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={`${e.at}-${i}`}>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{formatDateTime(e.at, user?.timezone)}</td>
                  <td><span className={signInTone(e.action)}>{signInLabel(e)}</span></td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{e.ip || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
