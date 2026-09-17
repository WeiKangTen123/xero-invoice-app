import { useState } from 'react';
import { api } from '../../api/client';
import Modal from '../../components/Modal';

// ── Report modal ──────────────────────────────────────────────────────────────
export function ReportModal({ invoiceId, onClose, onDone }) {
  const [note,    setNote]    = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!note.trim()) { setError('Please describe the issue.'); return; }
    setLoading(true); setError('');
    try {
      await api.post(`/invoices/${invoiceId}/report`, { note });
      onDone();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <Modal onClose={onClose} busy={loading} maxWidth={440} label="Report an issue" style={{ padding: '28px 28px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Report an Issue</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Describe the problem and an admin will review it.</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 20, lineHeight: 1, padding: 2 }}>×</button>
        </div>
        {error && <div className="alert alert-error"><span className="alert-icon">✕</span>{error}</div>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label htmlFor="report-note" className="form-label">What's wrong?</label>
            <textarea id="report-note"
              className="form-input"
              placeholder="e.g. Wrong vendor name extracted, incorrect total amount, missing line items..."
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={4}
              style={{ resize: 'vertical', minHeight: 100, fontFamily: 'inherit', lineHeight: 1.5 }}
              autoFocus
            />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" className="btn btn-danger" disabled={loading}>
              {loading ? <><span className="btn-spinner" /> Sending...</> : '⚠ Send Report'}
            </button>
          </div>
        </form>
    </Modal>
  );
}
