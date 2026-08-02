import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

// Statuses that allow the user to trigger a Xero submission.
// 'posted' is included so a correction can be re-posted — this updates the existing
// Xero bill in place rather than creating a duplicate (see backend submitDraftInvoice).
const SUBMITTABLE = new Set(['pending', 'review-needed', 'error', 'reviewed', 'posted']);
// Statuses that allow the user to mark as reviewed (i.e. not yet finalised)
const MARKABLE    = new Set(['pending', 'review-needed', 'error', 'reported']);

// ── Report modal ──────────────────────────────────────────────────────────────
function ReportModal({ invoiceId, onClose, onDone }) {
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
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'fadeIn 0.15s ease' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 18, padding: '28px 28px 24px', width: '100%', maxWidth: 440, boxShadow: 'var(--shadow-lg)', animation: 'scaleIn 0.2s ease' }}>
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
            <label className="form-label">What's wrong?</label>
            <textarea
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
      </div>
    </div>
  );
}

// ── Info row ──────────────────────────────────────────────────────────────────
function InfoRow({ label, value, mono }) {
  if (!value && value !== 0) return null;
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ width: 140, flexShrink: 0, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', paddingTop: 1 }}>
        {label}
      </div>
      <div style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-word' }}>
        {value}
      </div>
    </div>
  );
}

// ── Mini field (compact 2-per-row variant of InfoRow, for the summary grid) ─────
function MiniField({ label, value, mono }) {
  if (!value && value !== 0) return null;
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-word' }}>
        {value}
      </div>
    </div>
  );
}

// ── Status pill ───────────────────────────────────────────────────────────────
function StatusPill({ status }) {
  const map = {
    pending:        { cls: 'badge-yellow', label: '⏳ Pending Review' },
    submitting:     { cls: 'badge-blue',   label: '⟳ Submitting to Xero…' },
    reviewed:       { cls: 'badge-blue',   label: '✓ Reviewed' },
    posted:         { cls: 'badge-green',  label: '✓ Posted to Xero' },
    reported:       { cls: 'badge-red',    label: '⚠ Issue Reported' },
    error:          { cls: 'badge-red',    label: '✕ Submission Error' },
    duplicate:      { cls: 'badge-gray',   label: 'Duplicate' },
    'review-needed': { cls: 'badge-yellow', label: '⚠ Needs Review' },
  };
  const { cls, label } = map[status] || { cls: 'badge-gray', label: status };
  return <span className={`badge ${cls}`} style={{ fontSize: 12, padding: '4px 12px' }}>{label}</span>;
}

// ── Spinner ───────────────────────────────────────────────────────────────────
function Spinner() {
  return <span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />;
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function InvoiceReview() {
  const { id }   = useParams();
  const navigate = useNavigate();

  const [inv,        setInv]        = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [fetchErr,   setFetchErr]   = useState('');
  const [pdfUrl,     setPdfUrl]     = useState(null);
  const [pdfErr,     setPdfErr]     = useState('');
  const [pdfRetry,   setPdfRetry]   = useState(0);
  const [reporting,  setReporting]  = useState(false);
  const [marking,    setMarking]    = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr,  setSubmitErr]  = useState('');
  const [submitOk,   setSubmitOk]   = useState(false);
  const [wasRepost,  setWasRepost]  = useState(false);
  const [editing,    setEditing]    = useState(false);
  const [form,       setForm]       = useState(null);
  const [saving,     setSaving]     = useState(false);
  const [saveErr,    setSaveErr]    = useState('');
  const [showMeta,   setShowMeta]   = useState(false);

  // ── Fetch invoice ─────────────────────────────────────────────────────────
  async function fetchInvoice() {
    try {
      const d = await api.get(`/invoices/${id}`);
      setInv(d.invoice);
    } catch (err) {
      setFetchErr(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchInvoice(); }, [id]);

  // Re-fetch if the chat assistant confirms a change to this invoice while it's
  // the one open on screen — keeps the visible fields in sync without polling.
  useEffect(() => {
    function onExternalUpdate(e) {
      if (e.detail?.invoiceId === id) fetchInvoice();
    }
    window.addEventListener('invoice-updated', onExternalUpdate);
    return () => window.removeEventListener('invoice-updated', onExternalUpdate);
  }, [id]);

  // ── Signed PDF URL — fetched with Bearer JWT, refreshed before it expires ─
  // The iframe/anchor cannot send Authorization headers on direct navigation,
  // so we get a short-lived signed URL first and use that instead.
  useEffect(() => {
    if (!inv?.hasPdf) return;
    let active = true;
    setPdfErr('');
    setPdfUrl(null);

    async function refresh() {
      try {
        const d = await api.get(`/invoices/${id}/pdf-url`);
        if (active) { setPdfUrl(d.url); setPdfErr(''); }
      } catch (err) {
        if (active) setPdfErr(err.message || 'Could not load PDF');
      }
    }

    refresh();
    // Token lifetime is 5 min; refresh at 4 min so the iframe never gets a stale URL
    const timer = setInterval(refresh, 4 * 60 * 1000);
    return () => { active = false; clearInterval(timer); };
  }, [inv?.hasPdf, id, pdfRetry]);

  // ── Actions ───────────────────────────────────────────────────────────────
  async function markReviewed() {
    setMarking(true);
    try {
      await api.patch(`/invoices/${id}/status`, { status: 'reviewed' });
      setInv(prev => ({ ...prev, status: 'reviewed' }));
    } catch (err) {
      alert(err.message);
    } finally {
      setMarking(false);
    }
  }

  const _pollRef = useRef(null);

  async function submitToXero() {
    setSubmitting(true);
    setSubmitErr('');
    setWasRepost(inv.status === 'posted');
    try {
      // Server fires submission in background and returns 202 immediately.
      await api.post(`/invoices/${id}/submit`, {});
      setInv(prev => ({ ...prev, status: 'submitting' }));

      // Poll every 2s until status is no longer 'submitting'.
      _pollRef.current = setInterval(async () => {
        try {
          const d = await api.get(`/invoices/${id}`);
          const status = d.invoice?.status;
          if (status !== 'submitting') {
            clearInterval(_pollRef.current);
            setSubmitting(false);
            setInv(d.invoice);
            if (status === 'posted') setSubmitOk(true);
            else if (status === 'error') setSubmitErr(d.invoice?.errorMsg || 'Xero submission failed');
          }
        } catch (_) {}
      }, 2000);
    } catch (err) {
      setSubmitErr(err.message);
      setSubmitting(false);
    }
  }

  useEffect(() => () => clearInterval(_pollRef.current), []);

  // ── Edit mode ─────────────────────────────────────────────────────────────
  function startEdit() {
    setForm({
      vendorName:       inv.vendorName       || '',
      contactEmail:     inv.contactEmail     || '',
      contactAddress:   inv.contactAddress   || '',
      invoiceNumber:    inv.invoiceNumber    || '',
      invoiceDate:      inv.invoiceDate      || '',
      dueDate:          inv.dueDate          || '',
      totalAmount:      inv.totalAmount      ?? 0,
      subTotal:         inv.subTotal         ?? 0,
      taxAmount:        inv.taxAmount        ?? 0,
      currency:         inv.currency         || '',
      invoiceType:      inv.invoiceType      || 'ACCPAY',
      accountCode:      inv.accountCode      || '',
      paymentReference: inv.paymentReference || '',
      lineItems:        (inv.lineItems || []).map(li => ({ ...li })),
    });
    setSaveErr('');
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setForm(null);
    setSaveErr('');
  }

  function updateField(key, value) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function updateLineItem(idx, key, value) {
    setForm(f => ({
      ...f,
      lineItems: f.lineItems.map((li, i) => i === idx ? { ...li, [key]: value } : li),
    }));
  }

  async function saveEdit() {
    setSaving(true);
    setSaveErr('');
    try {
      const d = await api.patch(`/invoices/${id}`, form);
      setInv(d.invoice);
      setEditing(false);
      setForm(null);
    } catch (err) {
      setSaveErr(err.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Loading / error states ────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 32 }}>
        <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
        Loading invoice...
      </div>
    );
  }

  if (fetchErr || !inv) {
    return (
      <div style={{ padding: 32 }}>
        <div className="alert alert-error"><span className="alert-icon">✕</span>{fetchErr || 'Invoice not found'}</div>
        <button className="btn btn-outline" onClick={() => navigate('/invoices')}>← Back to Invoices</button>
      </div>
    );
  }

  const typeLabel  = inv.invoiceType === 'ACCPAY' ? 'Bill (ACCPAY)' : 'Invoice (ACCREC)';
  const canSubmit  = SUBMITTABLE.has(inv.status) && !submitOk && !editing;
  const canReview  = MARKABLE.has(inv.status) && !editing;
  const canEdit    = SUBMITTABLE.has(inv.status); // same set the backend allows PATCH /:id for
  const isError    = inv.status === 'error' || inv.status === 'review-needed';

  return (
    <>
      {reporting && (
        <ReportModal
          invoiceId={id}
          onClose={() => setReporting(false)}
          onDone={() => {
            setReporting(false);
            setInv(prev => ({ ...prev, status: 'reported' }));
          }}
        />
      )}

      <div style={{ animation: 'fadeUp 0.3s ease' }}>

        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/invoices')} style={{ gap: 6 }}>← Back</button>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.4px' }}>
                {inv.vendorName || 'Unknown Vendor'}
              </h1>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                {inv.pdfFilename || inv.invoiceNumber}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StatusPill status={inv.status} />

            {/* Post to Xero — creates a new draft, or (for an already-posted invoice)
                updates the existing Xero bill in place rather than duplicating it */}
            {canSubmit && (
              <button
                className="btn btn-primary btn-sm"
                onClick={submitToXero}
                disabled={submitting}
                style={{ gap: 6 }}
                title={inv.status === 'posted' ? 'Updates the existing Xero bill — does not create a duplicate' : undefined}
              >
                {submitting
                  ? <><Spinner /> {inv.status === 'posted' ? 'Updating...' : 'Posting...'}</>
                  : inv.status === 'posted'
                    ? '↻ Re-post to Xero'
                    : inv.status === 'error'
                      ? '↺ Retry Xero'
                      : '→ Post to Xero'}
              </button>
            )}

            {/* Mark Reviewed — only available while not yet finalized */}
            {canReview && (
              <button
                className="btn btn-success btn-sm"
                onClick={markReviewed}
                disabled={marking}
              >
                {marking ? '...' : '✓ Mark Reviewed'}
              </button>
            )}

            {!editing && (
              <button
                className="btn btn-sm"
                style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)' }}
                onClick={() => setReporting(true)}
              >
                ⚠ Report Issue
              </button>
            )}

            {/* Edit — correct LLM-extracted fields before/instead of posting to Xero */}
            {canEdit && !editing && (
              <button className="btn btn-outline btn-sm" onClick={startEdit}>
                ✎ Edit
              </button>
            )}
            {editing && (
              <>
                <button className="btn btn-outline btn-sm" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </button>
                <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={saving} style={{ gap: 6 }}>
                  {saving ? <><Spinner /> Saving...</> : '✓ Save Changes'}
                </button>
              </>
            )}
          </div>
        </div>

        {saveErr && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            <span className="alert-icon">✕</span>{saveErr}
          </div>
        )}

        {/* Xero submission result banners */}
        {submitOk && (
          <div className="alert alert-success" style={{ marginBottom: 12 }}>
            <span className="alert-icon">✓</span>
            {wasRepost ? 'Existing Xero bill updated successfully.' : 'Invoice posted to Xero successfully.'}
            {inv.xeroInvoiceId && (
              <span style={{ marginLeft: 8, opacity: 0.7, fontSize: 12 }}>ID: {inv.xeroInvoiceId}</span>
            )}
          </div>
        )}
        {submitErr && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            <span className="alert-icon">✕</span>
            <div>
              <strong>Xero submission failed</strong> — {submitErr}
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                Correct any fields in the panel on the right, then try again.
              </div>
            </div>
          </div>
        )}

        {/* Parsing / previous submission error */}
        {isError && inv.errorMsg && !submitErr && (
          <div className="alert alert-warning" style={{ marginBottom: 12 }}>
            <span className="alert-icon">⚠</span>
            <div>
              <strong>{inv.status === 'review-needed' ? 'Could not auto-process' : 'Previous submission failed'}</strong>
              {' — '}{inv.errorMsg}
              {inv.status === 'review-needed' && (
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                  Review the PDF, correct any fields below, then click "Post to Xero".
                </div>
              )}
            </div>
          </div>
        )}

        {/* Reported banner */}
        {inv.status === 'reported' && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            <span className="alert-icon">⚠</span>
            Issue reported — an admin will review this invoice.
            {inv.reports?.length > 0 && (
              <span style={{ marginLeft: 8, opacity: 0.7 }}>({inv.reports.length} report{inv.reports.length > 1 ? 's' : ''})</span>
            )}
          </div>
        )}

        {/* Posted banner */}
        {inv.status === 'posted' && inv.xeroInvoiceId && !submitOk && (
          <div className="alert alert-success" style={{ marginBottom: 12 }}>
            <span className="alert-icon">✓</span>
            Posted to Xero — Invoice ID: <span style={{ fontFamily: 'monospace', marginLeft: 4 }}>{inv.xeroInvoiceId}</span>
          </div>
        )}

        {/* Main layout: PDF left, info panel right (sticky — stays in view while the PDF scrolls) */}
        <div style={{ display: 'grid', gridTemplateColumns: inv.hasPdf ? '1fr 500px' : '1fr', gap: 20, alignItems: 'start' }}>

          {/* PDF Viewer — fills its full grid column; the #zoom=page-width fragment on
              the iframe src (below) tells the native PDF viewer to fit-scale itself,
              so it never letterboxes no matter how wide the column is */}
          {inv.hasPdf ? (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>📄</span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{inv.pdfFilename || 'Invoice PDF'}</span>
                </div>
                {pdfUrl && (
                  <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm" style={{ gap: 5 }}>
                    ↗ Open in tab
                  </a>
                )}
              </div>
              {pdfUrl ? (
                <iframe
                  src={`${pdfUrl}#zoom=page-width`}
                  title="Invoice PDF"
                  style={{ width: '100%', height: 'calc(100vh - 240px)', minHeight: 500, border: 'none', display: 'block', background: '#525659' }}
                />
              ) : pdfErr ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 300, gap: 14, padding: 24 }}>
                  <span style={{ fontSize: 28, opacity: 0.4 }}>📄</span>
                  <div style={{ fontSize: 13, color: 'var(--danger)', fontWeight: 600 }}>PDF could not be loaded</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 280 }}>{pdfErr}</div>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => setPdfRetry(n => n + 1)}
                  >
                    ↻ Retry
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, color: 'var(--text-muted)', gap: 10 }}>
                  <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
                  Loading PDF...
                </div>
              )}
            </div>
          ) : (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 18 }}>✉</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Email Body</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No PDF attachment — invoice was extracted from email text</div>
                </div>
              </div>
              <pre style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: 8, padding: '14px 16px', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 400, overflowY: 'auto', border: '1px solid var(--border)', lineHeight: 1.6 }}>
                {inv.description || 'No content available'}
              </pre>
            </div>
          )}

          {/* Info panel — sticky + independently scrollable so it stays visible while
              you scroll a multi-page PDF, instead of scrolling away with the page */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 16,
            position: inv.hasPdf ? 'sticky' : 'static', top: 0,
            maxHeight: inv.hasPdf ? 'calc(100vh - 88px)' : 'none',
            overflowY: inv.hasPdf ? 'auto' : 'visible',
            paddingRight: inv.hasPdf ? 4 : 0,
          }}>

            {/* Summary card */}
            <div className="card">
              {editing ? (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="form-group" style={{ width: 90 }}>
                      <label className="form-label">Currency</label>
                      <input className="form-input" value={form.currency} maxLength={3}
                        onChange={e => updateField('currency', e.target.value.toUpperCase())} />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="form-label">Total Amount</label>
                      <input className="form-input" type="number" step="0.01" value={form.totalAmount}
                        onChange={e => updateField('totalAmount', e.target.value)} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Type</label>
                    <select className="form-input" value={form.invoiceType}
                      onChange={e => updateField('invoiceType', e.target.value)}>
                      <option value="ACCPAY">Bill (ACCPAY)</option>
                      <option value="ACCREC">Invoice (ACCREC)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Invoice #</label>
                    <input className="form-input" value={form.invoiceNumber}
                      onChange={e => updateField('invoiceNumber', e.target.value)} />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="form-label">Invoice Date</label>
                      <input className="form-input" type="date" value={form.invoiceDate || ''}
                        onChange={e => updateField('invoiceDate', e.target.value)} />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label className="form-label">Due Date</label>
                      <input className="form-input" type="date" value={form.dueDate || ''}
                        onChange={e => updateField('dueDate', e.target.value)} />
                    </div>
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Account Code</label>
                    <input className="form-input" value={form.accountCode}
                      onChange={e => updateField('accountCode', e.target.value)} />
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>
                        {inv.currency} {Number(inv.totalAmount || 0).toLocaleString('en', { minimumFractionDigits: 2 })}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total amount</div>
                    </div>
                    <span className="badge badge-gray" style={{ fontSize: 11 }}>{typeLabel}</span>
                  </div>
                  {/* Compact 2-col grid instead of one full-width row per field */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px' }}>
                    <MiniField label="Invoice #"    value={inv.invoiceNumber} mono />
                    <MiniField label="Account"      value={inv.accountCode} mono />
                    <MiniField label="Invoice Date" value={inv.invoiceDate} />
                    <MiniField label="Due Date"     value={inv.dueDate} />
                  </div>
                  <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                    Source: {inv.source === 'pdf' ? 'PDF Attachment' : 'Email Body'}
                  </div>
                </>
              )}
            </div>

            {/* Vendor card */}
            <div className="card">
              <div className="card-title" style={{ marginBottom: 12 }}>Vendor / Contact</div>
              {editing ? (
                <>
                  <div className="form-group">
                    <label className="form-label">Name</label>
                    <input className="form-input" value={form.vendorName}
                      onChange={e => updateField('vendorName', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Email</label>
                    <input className="form-input" value={form.contactEmail}
                      onChange={e => updateField('contactEmail', e.target.value)} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Address</label>
                    <textarea className="form-input" rows={2} value={form.contactAddress}
                      onChange={e => updateField('contactAddress', e.target.value)}
                      style={{ resize: 'vertical', fontFamily: 'inherit' }} />
                  </div>
                </>
              ) : (
                <>
                  <InfoRow label="Name"       value={inv.vendorName} />
                  <InfoRow label="Email"      value={inv.contactEmail} />
                  <InfoRow label="Address"    value={inv.contactAddress} />
                  <InfoRow label="Phone"      value={inv.vendorPhone} />
                  <InfoRow label="From email" value={inv.sourceEmail} />
                </>
              )}
            </div>

            {/* Line items + payment reference — merged into one card since both relate
                to "what am I actually paying for" and payment ref is short */}
            {((editing ? form.lineItems : inv.lineItems)?.length > 0 || inv.paymentReference || editing) && (
              <div className="card">
                {(editing ? form.lineItems : inv.lineItems)?.length > 0 && (
                  <>
                    <div className="card-title" style={{ marginBottom: 12 }}>
                      Line Items ({(editing ? form.lineItems : inv.lineItems).length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {(editing ? form.lineItems : inv.lineItems).map((li, i) => (
                        editing ? (
                          <div key={i} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <input className="form-input" value={li.description || ''} placeholder="Description"
                              onChange={e => updateLineItem(i, 'description', e.target.value)} />
                            <input className="form-input" type="number" step="0.01" value={li.unitAmount ?? ''} placeholder="Amount"
                              onChange={e => updateLineItem(i, 'unitAmount', e.target.value)} />
                          </div>
                        ) : (
                          <div key={i} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                            <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 4, lineHeight: 1.4 }}>{li.description}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                              <span>{inv.currency} {Number(li.unitAmount || 0).toLocaleString('en', { minimumFractionDigits: 2 })}</span>
                              {li.discountRate > 0 && <span>· {li.discountRate}% disc.</span>}
                              {li.taxType && li.taxType !== 'NONE' && <span className="badge badge-yellow">{li.taxType}</span>}
                            </div>
                          </div>
                        )
                      ))}
                    </div>

                    {editing ? (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                          <label className="form-label">Subtotal</label>
                          <input className="form-input" type="number" step="0.01" value={form.subTotal}
                            onChange={e => updateField('subTotal', e.target.value)} />
                        </div>
                        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                          <label className="form-label">Tax</label>
                          <input className="form-input" type="number" step="0.01" value={form.taxAmount}
                            onChange={e => updateField('taxAmount', e.target.value)} />
                        </div>
                      </div>
                    ) : inv.subTotal > 0 && inv.taxAmount > 0 && (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
                          <span>Subtotal</span><span>{inv.currency} {Number(inv.subTotal).toFixed(2)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
                          <span>Tax</span><span>{inv.currency} {Number(inv.taxAmount).toFixed(2)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 2 }}>
                          <span>Total</span><span>{inv.currency} {Number(inv.totalAmount).toFixed(2)}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {(inv.paymentReference || editing) && (
                  <div style={{ marginTop: (editing ? form.lineItems : inv.lineItems)?.length > 0 ? 14 : 0, paddingTop: (editing ? form.lineItems : inv.lineItems)?.length > 0 ? 14 : 0, borderTop: (editing ? form.lineItems : inv.lineItems)?.length > 0 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 6 }}>
                      Payment Reference
                    </div>
                    {editing ? (
                      <input className="form-input" value={form.paymentReference}
                        onChange={e => updateField('paymentReference', e.target.value)} />
                    ) : (
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{inv.paymentReference}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Reports */}
            {inv.reports?.length > 0 && (
              <div className="card" style={{ border: '1px solid rgba(239,68,68,0.25)', background: 'var(--danger-subtle)' }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--danger)', marginBottom: 10 }}>⚠ Reported Issues ({inv.reports.length})</div>
                {inv.reports.map((r, i) => (
                  <div key={i} style={{ padding: '8px 0', borderTop: i > 0 ? '1px solid rgba(239,68,68,0.15)' : 'none' }}>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>{r.note}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      by {r.userEmail} · {r.reportedAt ? new Date(r.reportedAt).toLocaleString() : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Meta — collapsed by default; rarely needed, not something you cross-check
                against the PDF, so it shouldn't take up permanent scroll space */}
            <div className="card">
              <button
                onClick={() => setShowMeta(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}
              >
                <span style={{ display: 'inline-block', transition: 'transform 0.15s ease', transform: showMeta ? 'rotate(90deg)' : 'none' }}>▸</span>
                Processing Info
              </button>
              {showMeta && (
                <div style={{ marginTop: 10 }}>
                  <InfoRow label="Processed"  value={inv.processedAt  ? new Date(inv.processedAt).toLocaleString()  : '—'} />
                  {inv.submittedAt && (
                    <InfoRow label="Submitted" value={new Date(inv.submittedAt).toLocaleString()} />
                  )}
                  {inv.xeroInvoiceId && (
                    <InfoRow label="Xero ID"   value={inv.xeroInvoiceId} mono />
                  )}
                  <InfoRow label="Project"   value={inv.projectName} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
