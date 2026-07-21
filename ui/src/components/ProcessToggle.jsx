import { useState } from 'react';
import { api } from '../api/client';

export default function ProcessToggle({ status, onUpdate }) {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  async function toggle() {
    setLoading(true);
    setError('');
    try {
      if (status?.running) { await api.post('/process/stop'); }
      else                 { await api.post('/process/start'); }
      await onUpdate();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const running = status?.running;

  return (
    <div>
      {error && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          <span className="alert-icon">✕</span>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* Toggle */}
        <button
          onClick={toggle}
          disabled={loading}
          aria-label={running ? 'Stop watcher' : 'Start watcher'}
          style={{
            position: 'relative',
            width: 56, height: 30,
            borderRadius: 15,
            border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer',
            background: running
              ? 'linear-gradient(135deg, #10b981, #059669)'
              : 'var(--bg-hover)',
            transition: 'background 0.3s ease',
            boxShadow: running ? '0 2px 10px rgba(16,185,129,0.4)' : 'none',
            flexShrink: 0,
            outline: 'none',
          }}
        >
          <span style={{
            position: 'absolute',
            top: 3, left: running ? 29 : 3,
            width: 24, height: 24,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.3s cubic-bezier(0.4,0,0.2,1)',
            boxShadow: '0 1px 6px rgba(0,0,0,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10,
          }}>
            {loading && <span style={{ width: 10, height: 10, border: '1.5px solid rgba(0,0,0,0.2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'block' }} />}
          </span>
        </button>

        {/* Text */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`status-dot ${running ? 'active' : 'inactive'}`} style={{ fontWeight: 600, fontSize: 14, color: running ? 'var(--success)' : 'var(--text-muted)' }}>
              {loading ? 'Updating...' : running ? 'Watcher is running' : 'Watcher is stopped'}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            {running
              ? status?.startedAt
                ? `Started ${new Date(status.startedAt).toLocaleString()}`
                : 'Polling emails every 60s'
              : 'Click the toggle to start monitoring emails'}
          </div>
        </div>
      </div>
    </div>
  );
}
