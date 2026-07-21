import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

// reviewed is blue (not yet in Xero), posted is green (done).
// Keeping them visually distinct prevents the "I clicked Reviewed and it looked
// the same as Posted" confusion.
const STATUS_MAP = {
  pending:        { cls: 'badge-yellow', label: 'Pending' },
  posted:         { cls: 'badge-green',  label: '✓ Posted' },
  reviewed:       { cls: 'badge-blue',   label: '● Ready to Post' },
  reported:       { cls: 'badge-red',    label: '⚠ Reported' },
  error:          { cls: 'badge-red',    label: '✕ Error' },
  duplicate:      { cls: 'badge-gray',   label: 'Duplicate' },
  'review-needed': { cls: 'badge-yellow', label: '⚠ Needs Review' },
};

function TypeBadge({ type }) {
  if (type === 'ACCPAY') return <span className="badge badge-blue">Bill</span>;
  if (type === 'ACCREC') return <span className="badge badge-purple">Invoice</span>;
  return <span className="badge badge-gray">{type || '—'}</span>;
}

export default function Invoices() {
  const navigate = useNavigate();
  const [invoices,     setInvoices]     = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [clearing,      setClearing]      = useState(false);
  const [submittingAll, setSubmittingAll] = useState(false);
  const [submitMsg,     setSubmitMsg]     = useState('');
  const [deleting,      setDeleting]      = useState(new Set());
  const [selected,      setSelected]      = useState(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [filter,       setFilter]       = useState('');
  const [typeFilter,   setTypeFilter]   = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  function fetchInvoices() {
    setLoading(true);
    api.get('/invoices')
      .then(d => setInvoices(d.invoices || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { fetchInvoices(); }, []);

  useEffect(() => {
    setSelected(s => {
      const ids = new Set(invoices.map(i => i.id));
      const next = new Set([...s].filter(id => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [invoices]);

  async function handleSubmitAll() {
    setSubmittingAll(true);
    setSubmitMsg('');
    try {
      const r = await api.post('/invoices/submit-all', {});
      setSubmitMsg(r.message || 'Submitted');
      setTimeout(() => { setSubmitMsg(''); fetchInvoices(); }, 4000);
    } catch (err) {
      setSubmitMsg(err.message);
      setTimeout(() => setSubmitMsg(''), 4000);
    } finally {
      setSubmittingAll(false);
    }
  }

  async function handleClearCache() {
    if (!confirm(`Clear all ${invoices.length} invoice record${invoices.length !== 1 ? 's' : ''} and stored PDFs?\n\nThis cannot be undone.`)) return;
    setClearing(true);
    try {
      await api.delete('/invoices');
      setInvoices([]);
      setSelected(new Set());
    } catch (err) {
      alert(err.message);
    } finally {
      setClearing(false);
    }
  }

  async function handleDeleteOne(id, e) {
    e.stopPropagation();
    setDeleting(prev => new Set([...prev, id]));
    try {
      await api.delete(`/invoices/${id}`);
      setInvoices(prev => prev.filter(i => i.id !== id));
      setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
    } catch (err) {
      alert(err.message);
    } finally {
      setDeleting(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  async function handleDeleteSelected() {
    const ids = [...selected];
    if (!confirm(`Delete ${ids.length} selected invoice${ids.length !== 1 ? 's' : ''}?\n\nThis cannot be undone.`)) return;
    setBulkDeleting(true);
    try {
      await Promise.all(ids.map(id => api.delete(`/invoices/${id}`)));
      setInvoices(prev => prev.filter(i => !selected.has(i.id)));
      setSelected(new Set());
    } catch (err) {
      alert(err.message);
      fetchInvoices();
    } finally {
      setBulkDeleting(false);
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

  // 'needs-action' is a virtual filter covering review-needed + error
  const filtered = invoices.filter(inv => {
    if (statusFilter === 'needs-action') {
      if (!['review-needed', 'error'].includes(inv.status)) return false;
    } else if (statusFilter !== 'all' && inv.status !== statusFilter) {
      return false;
    }
    if (typeFilter !== 'all' && inv.invoiceType !== typeFilter) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      inv.vendorName?.toLowerCase().includes(q) ||
      inv.invoiceNumber?.toLowerCase().includes(q) ||
      inv.sourceEmail?.toLowerCase().includes(q)
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

  const bills       = invoices.filter(i => i.invoiceType === 'ACCPAY').length;
  const invCount    = invoices.filter(i => i.invoiceType === 'ACCREC').length;
  const pending     = invoices.filter(i => i.status === 'pending').length;
  const posted      = invoices.filter(i => i.status === 'posted').length;
  const reviewed    = invoices.filter(i => i.status === 'reviewed').length;
  const reported    = invoices.filter(i => i.status === 'reported').length;
  const needsAction = invoices.filter(i => ['review-needed', 'error'].includes(i.status)).length;

  return (
    <div>
      <div className="page-header">
        <h1>Invoices</h1>
        <p>Persisted across restarts — up to 500 records stored. Click any row to review.</p>
      </div>

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
            <strong>{pending} invoice{pending !== 1 ? 's' : ''}</strong> pending Xero submission
            {submitMsg && <span style={{ marginLeft: 8, color: 'var(--accent)', fontWeight: 500 }}>— {submitMsg}</span>}
          </span>
          <button
            className="btn btn-sm"
            disabled={submittingAll}
            onClick={handleSubmitAll}
            style={{ marginLeft: 'auto', background: 'rgba(99,102,241,0.12)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.3)', flexShrink: 0 }}
          >
            {submittingAll ? '...' : 'Submit all to Xero →'}
          </button>
        </div>
      )}

      {/* Type + Status filter pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 2 }}>Type:</span>
        {[
          { key: 'all',    label: 'All',      count: invoices.length },
          { key: 'ACCPAY', label: 'Bills',    count: bills },
          { key: 'ACCREC', label: 'Invoices', count: invCount },
        ].map(t => (
          <FilterPill key={t.key} active={typeFilter === t.key} onClick={() => setTypeFilter(t.key)} label={t.label} count={t.count} />
        ))}

        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginLeft: 8, marginRight: 2 }}>Status:</span>
        {[
          { key: 'all',          label: 'All',              count: invoices.length },
          { key: 'posted',       label: '✓ Posted',         count: posted },
          { key: 'reviewed',     label: '● Ready to Post',  count: reviewed },
          { key: 'pending',      label: 'Pending',          count: pending },
          { key: 'needs-action', label: '⚠ Needs Review',   count: needsAction },
          { key: 'reported',     label: 'Reported',         count: reported },
        ].map(t => (
          <FilterPill key={t.key} active={statusFilter === t.key} onClick={() => setStatusFilter(t.key)} label={t.label} count={t.count} />
        ))}
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
          <button className="btn btn-outline btn-sm" onClick={fetchInvoices}>↻</button>

          {selected.size > 0 && (
            <button
              className="btn btn-sm"
              disabled={bulkDeleting}
              onClick={handleDeleteSelected}
              style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.25)', whiteSpace: 'nowrap', animation: 'scaleIn 0.15s ease' }}
            >
              {bulkDeleting ? '...' : `🗑 Delete selected (${selected.size})`}
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

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: '28px 0' }}>
            <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
            Loading invoices...
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📭</div>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>No invoices found</div>
            <div style={{ fontSize: 13 }}>
              {invoices.length === 0
                ? 'Processed invoices will appear here once the watcher is running'
                : 'Try adjusting the filters or search term'}
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 36, paddingRight: 0 }}>
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      style={{ cursor: 'pointer', accentColor: 'var(--accent)', width: 15, height: 15 }}
                      title={allFilteredSelected ? 'Deselect all' : 'Select all visible'}
                    />
                  </th>
                  <th>Vendor</th>
                  <th>Invoice #</th>
                  <th>Amount</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th>PDF</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((inv, i) => {
                  const { cls, label } = STATUS_MAP[inv.status] || { cls: 'badge-gray', label: inv.status };
                  const isSelected    = selected.has(inv.id);
                  const isDeleting    = deleting.has(inv.id);
                  const needsAttention = ['review-needed', 'error'].includes(inv.status);
                  return (
                    <tr
                      key={inv.id}
                      style={{
                        cursor: 'pointer',
                        animation: `fadeUp 0.2s ease ${i * 25}ms both`,
                        background: isSelected
                          ? 'var(--accent-subtle)'
                          : needsAttention ? 'rgba(245,158,11,0.04)' : undefined,
                        opacity: isDeleting ? 0.4 : 1,
                        transition: 'background 0.15s, opacity 0.2s',
                      }}
                      onClick={() => navigate(`/invoices/${inv.id}`)}
                    >
                      <td style={{ paddingRight: 0 }} onClick={e => toggleSelect(inv.id, e)}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          style={{ cursor: 'pointer', accentColor: 'var(--accent)', width: 15, height: 15 }}
                        />
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <div style={{
                            width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                            background: needsAttention ? 'rgba(245,158,11,0.12)' : 'var(--accent-subtle)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 11, fontWeight: 700,
                            color: needsAttention ? 'var(--warning)' : 'var(--accent)',
                          }}>
                            {(inv.vendorName || '?').slice(0, 2).toUpperCase()}
                          </div>
                          <span style={{ fontWeight: 500 }}>{inv.vendorName || '—'}</span>
                        </div>
                      </td>
                      <td>
                        <code style={{ fontSize: 12, background: 'var(--bg-secondary)', padding: '2px 7px', borderRadius: 4, color: 'var(--text-secondary)' }}>
                          {inv.invoiceNumber || '—'}
                        </code>
                      </td>
                      <td style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {inv.totalAmount != null
                          ? `${inv.currency || ''} ${Number(inv.totalAmount).toLocaleString('en', { minimumFractionDigits: 2 })}`
                          : '—'}
                      </td>
                      <td><TypeBadge type={inv.invoiceType} /></td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {inv.invoiceDate || '—'}
                      </td>
                      <td>
                        {inv.hasPdf
                          ? <span className="badge badge-green">📄 PDF</span>
                          : <span className="badge badge-gray">✉ Email</span>}
                      </td>
                      <td><span className={`badge ${cls}`}>{label}</span></td>
                      <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => navigate(`/invoices/${inv.id}`)}
                            style={inv.status === 'reviewed'
                              ? { background: 'var(--info-subtle)', color: 'var(--info)', borderColor: 'rgba(59,130,246,0.3)' }
                              : undefined}
                          >
                            {needsAttention
                              ? 'Fix & Post →'
                              : inv.status === 'reviewed'
                                ? 'Post to Xero →'
                                : inv.status === 'posted' || inv.status === 'duplicate'
                                  ? 'View →'
                                  : 'Review →'}
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={isDeleting}
                            onClick={e => handleDeleteOne(inv.id, e)}
                            style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)', minWidth: 28 }}
                            title="Delete this invoice"
                          >
                            {isDeleting ? '...' : '✕'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterPill({ active, onClick, label, count }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 12px', borderRadius: 100, cursor: 'pointer',
        fontSize: 12, fontWeight: 600,
        background: active ? 'var(--accent)' : 'var(--bg-card)',
        color: active ? '#fff' : 'var(--text-secondary)',
        border: active ? '1px solid transparent' : '1px solid var(--border)',
        boxShadow: active ? '0 2px 8px rgba(99,102,241,0.3)' : 'none',
        transition: 'all 0.15s ease',
      }}
    >
      {label}
      <span style={{
        padding: '0 5px', borderRadius: 100, fontSize: 11,
        background: active ? 'rgba(255,255,255,0.2)' : 'var(--bg-hover)',
        color: active ? '#fff' : 'var(--text-muted)',
      }}>
        {count}
      </span>
    </button>
  );
}
