import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import DeleteConfirmModal from '../components/DeleteConfirmModal';
import { useConfirm } from '../context/ConfirmContext';
import { useToast } from '../context/ToastContext';
import { TYPE_META, typeMeta } from '../utils/badges';
import { useViewMode } from '../context/ViewModeContext';
import { useAuth } from '../context/AuthContext';
import { formatDateTime } from '../utils/formatDate';
import DiscrepancyBanner from './invoice-review/DiscrepancyBanner';
import DuplicateBanner from './invoice-review/DuplicateBanner';
import EmailBodyCard from './invoice-review/EmailBodyCard';
import LineItemsCard from './invoice-review/LineItemsCard';
import PdfViewer from './invoice-review/PdfViewer';
import ReceiptViewer from './invoice-review/ReceiptViewer';
import { ReportModal } from './invoice-review/ReportModal';
import StickyActionBar from './invoice-review/StickyActionBar';
import SummaryCard from './invoice-review/SummaryCard';
import TopBar from './invoice-review/TopBar';
import { InfoRow } from './invoice-review/bits';
import { MARKABLE, SUBMITTABLE, listPathFor } from './invoice-review/helpers';




function InvoiceReviewPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const toast   = useToast();
  const { isMobile } = useViewMode();
  const { id }   = useParams();
  const navigate = useNavigate();

  const [inv,        setInv]        = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [fetchErr,   setFetchErr]   = useState('');
  const [pdfUrl,     setPdfUrl]     = useState(null);
  const [pdfErr,     setPdfErr]     = useState('');
  const [pdfRetry,   setPdfRetry]   = useState(0);
  // Expense claims carry a photographed receipt rather than a PDF.
  const [receiptUrl, setReceiptUrl] = useState(null);
  const [receiptRot, setReceiptRot] = useState(0);
  const [group,      setGroup]      = useState(null);   // { index, total, siblings }
  // Parsed once per change rather than in the middle of the markup on every
  // render. A malformed box means "show the whole image", never a crash.
  const receiptBox = useMemo(() => {
    try { return inv?.receiptBox ? JSON.parse(inv.receiptBox) : null; } catch { return null; }
  }, [inv?.receiptBox]);
  const [merging,       setMerging]       = useState(false);
  const [approvingNext, setApprovingNext] = useState(false);
  const [rereading,     setRereading]     = useState(false);
  const [rereadMsg,     setRereadMsg]     = useState('');
  const [reporting,     setReporting]     = useState(false);
  const [marking,       setMarking]       = useState(false);
  const [submitting,    setSubmitting]    = useState(false);
  const [submitErr,     setSubmitErr]     = useState('');
  const [submitOk,      setSubmitOk]      = useState(false);
  const [wasRepost,     setWasRepost]     = useState(false);
  const [editing,       setEditing]       = useState(false);
  const [form,          setForm]          = useState(null);
  const [saving,        setSaving]        = useState(false);
  const [saveErr,       setSaveErr]       = useState('');
  const [showMeta,      setShowMeta]      = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting,        setDeleting]        = useState(false);
  const [deleteErr,       setDeleteErr]       = useState('');
  // Ref so keyboard handler always has the latest group without stale closures.
  const groupRef = useRef(null);

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

  // ── Signed receipt URL ────────────────────────────────────────────────────
  // Same constraint as the PDF above: an <img src> carries no Authorization
  // header, so the image is reached through a short-lived scoped token that is
  // refreshed before it expires.
  useEffect(() => {
    if (!inv?.receiptFile) return undefined;
    let active = true;

    async function refresh() {
      try {
        const d = await api.get(`/receipts/${id}/token`);
        if (active) setReceiptUrl(`/api/receipts/${id}/image?token=${encodeURIComponent(d.token)}`);
      } catch {
        if (active) setReceiptUrl(null);
      }
    }

    refresh();
    const timer = setInterval(refresh, 4 * 60 * 1000);   // token lives 5 min
    return () => { active = false; clearInterval(timer); };
  }, [inv?.receiptFile, id]);

  // Siblings from the same upload, so the header can say "1 of 2" and offer to
  // step between them.
  useEffect(() => {
    if (!inv?.receiptFile) return;
    let active = true;
    api.get(`/receipts/${id}/group`)
      .then(g => { if (active) { setGroup(g); groupRef.current = g; } })
      .catch(() => { if (active) { setGroup(null); groupRef.current = null; } });
    return () => { active = false; };
  }, [inv?.receiptFile, inv?.receiptGroup, id]);

  // Keyboard ← / → to step through siblings instantly (SPA navigation, no reload).
  // Only fires when no input/textarea/select is focused, so typing fields still work.
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      const g = groupRef.current;
      if (!g?.split || g.total < 2) return;
      const idx = g.index - 1;  // 0-based
      if (e.key === 'ArrowLeft' && idx > 0) {
        e.preventDefault();
        navigate(`/invoices/${g.siblings[idx - 1].id}`);
      } else if (e.key === 'ArrowRight' && idx < g.total - 1) {
        e.preventDefault();
        navigate(`/invoices/${g.siblings[idx + 1].id}`);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);


  // Ask the model to look at the photo again. Without this a failed read was
  // permanent — a quota blip meant typing every field by hand forever. Costs one
  // Gemini call and no Xero call.
  async function rereadReceipt() {
    setRereading(true);
    setRereadMsg('');
    try {
      const res = await api.post(`/receipts/${id}/reread`, {});
      if (res.ok) {
        window.location.reload();
      } else {
        setRereadMsg(res.reason === 'unavailable'
          ? 'The reader is unavailable right now — your figures are unchanged. Try again in a moment.'
          : 'Still could not read this photo. The fields are unchanged, so enter them by hand.');
      }
    } catch (err) {
      setRereadMsg(err.message || 'Could not re-read this receipt');
    } finally {
      setRereading(false);
    }
  }

  // Undo a split: removes the siblings and restores the whole original on this
  // record. Only possible because the file was never cut apart.
  async function mergeBack() {
    setMerging(true);
    try {
      await api.post(`/receipts/${id}/merge`, {});
      window.location.reload();
    } catch (err) {
      setMerging(false);
      toast.error(err.message || 'Could not merge');
    }
  }

  // Mark as reviewed and instantly jump to the next sibling in the batch via SPA
  // navigation. If no next, goes to the first unreviewed, otherwise stays.
  async function approveAndNext() {
    setApprovingNext(true);
    try {
      await api.patch(`/invoices/${id}/status`, { status: 'reviewed' });
      setInv(prev => ({ ...prev, status: 'reviewed' }));
      const g = groupRef.current;
      if (g?.split && g.total > 1) {
        const idx = g.index - 1;  // 0-based current index
        // Prefer next unreviewed sibling after the current one; fall back to next.
        const candidates = [
          ...g.siblings.slice(idx + 1),
          ...g.siblings.slice(0, idx),
        ];
        const nextUnreviewed = candidates.find(s => s.id !== id && s.status !== 'reviewed' && s.status !== 'posted');
        const next = nextUnreviewed || (idx < g.total - 1 ? g.siblings[idx + 1] : null);
        if (next) { navigate(`/invoices/${next.id}`); return; }
      }
    } catch (err) {
      toast.error(err.message || 'Could not mark as reviewed');
    } finally {
      setApprovingNext(false);
    }
  }


  // ── Actions ───────────────────────────────────────────────────────────────
  async function markReviewed() {
    setMarking(true);
    try {
      await api.patch(`/invoices/${id}/status`, { status: 'reviewed' });
      setInv(prev => ({ ...prev, status: 'reviewed' }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMarking(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteErr('');
    try {
      await api.delete(`/invoices/${id}`);
      navigate(listPathFor(inv), { replace: true });
    } catch (err) {
      setDeleteErr(err.message || 'Failed to delete');
      setDeleting(false);
      setShowDeleteModal(false);
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
      description:      inv.description      || '',
      invoiceType:      inv.invoiceType      || (inv.receiptFile ? 'EXPENSE' : 'ACCPAY'),
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

  // Discrepancy detector: Claimed <claimed> but the receipt says <onReceipt>
  const discrepancyMatch = useMemo(() => {
    if (!inv?.errorMsg) return null;
    const m = inv.errorMsg.match(/Claimed\s+([0-9.]+)\s+but the receipt says\s+([0-9.]+)/i);
    if (!m) return null;
    return {
      claimed: Number(m[1]),
      onReceipt: Number(m[2]),
      diff: Math.round((Number(m[2]) - Number(m[1])) * 100) / 100,
    };
  }, [inv?.errorMsg]);

  async function resolveDiscrepancy(chosenAmount) {
    setSaving(true);
    setSaveErr('');
    try {
      const d = await api.patch(`/invoices/${id}`, {
        totalAmount: chosenAmount,
        errorMsg: null,
      });
      setInv(d.invoice);
      if (editing && form) {
        setForm(f => ({ ...f, totalAmount: chosenAmount, errorMsg: null }));
      }
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
        <button className="btn btn-outline" onClick={() => navigate(listPathFor(inv))}>← Back to Invoices</button>
      </div>
    );
  }

  const isExpense  = inv.invoiceType === 'EXPENSE' || !!inv.receiptFile;
  const typeLabel  = isExpense ? TYPE_META.EXPENSE.long : typeMeta(inv.invoiceType).long;
  const canSubmit  = SUBMITTABLE.has(inv.status) && !submitOk && !editing;
  const canReview  = MARKABLE.has(inv.status) && !editing;
  const canEdit    = SUBMITTABLE.has(inv.status); // same set the backend allows PATCH /:id for

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
        <TopBar isMobile={isMobile} navigate={navigate} inv={inv} setReporting={setReporting} marking={marking} submitting={submitting} editing={editing} saving={saving} setShowDeleteModal={setShowDeleteModal} deleting={deleting} markReviewed={markReviewed} submitToXero={submitToXero} startEdit={startEdit} cancelEdit={cancelEdit} saveEdit={saveEdit} isExpense={isExpense} canSubmit={canSubmit} canReview={canReview} canEdit={canEdit} />

        {deleteErr && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            <span className="alert-icon">✕</span>{deleteErr}
          </div>
        )}

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

        {/* 1-Click Discrepancy Resolver Banner */}
        {discrepancyMatch && !submitErr && <DiscrepancyBanner inv={inv} saving={saving} discrepancyMatch={discrepancyMatch} resolveDiscrepancy={resolveDiscrepancy} />}

        {/* Dedicated Duplicate Receipt Detected Banner */}
        {(inv.status === 'duplicate' || inv.duplicateOf || (inv.errorMsg && /duplicate/i.test(inv.errorMsg))) && <DuplicateBanner confirm={confirm} toast={toast} id={id} navigate={navigate} inv={inv} setShowDeleteModal={setShowDeleteModal} fetchInvoice={fetchInvoice} />}

        {/* Why this record is waiting: a payment schedule the parser set aside,
            a figure the verifier read differently, a failed submission. The
            server prefixes its review reasons with "Please check:", which the
            heading already says. Duplicates and amount discrepancies have their
            own banners above. */}
        {!discrepancyMatch && inv.errorMsg && !submitErr && !(/duplicate/i.test(inv.errorMsg)) && (
          <div className="alert alert-warning" style={{ marginBottom: 12 }}>
            <span className="alert-icon">⚠</span>
            <div>
              <strong>{inv.status === 'review-needed' ? 'Attention Needed' : 'Previous submission failed'}</strong>
              {' — '}{inv.errorMsg.replace(/^Please check:\s*/i, '')}
              {inv.status === 'review-needed' && (
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
                  Review the document, correct any fields below, then click "Mark as Reviewed".
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
        <div style={{ display: 'grid', gridTemplateColumns: (inv.hasPdf || inv.receiptFile) ? (isMobile ? '1fr' : '1fr 500px') : '1fr', gap: 20, alignItems: 'start' }}>

          {/* PDF Viewer — fills its full grid column; the #zoom=page-width fragment on
              the iframe src (below) tells the native PDF viewer to fit-scale itself,
              so it never letterboxes no matter how wide the column is */}
          {inv.receiptFile ? <ReceiptViewer isMobile={isMobile} id={id} navigate={navigate} inv={inv} receiptUrl={receiptUrl} receiptRot={receiptRot} setReceiptRot={setReceiptRot} group={group} merging={merging} approvingNext={approvingNext} rereading={rereading} rereadMsg={rereadMsg} saving={saving} receiptBox={receiptBox} rereadReceipt={rereadReceipt} mergeBack={mergeBack} approveAndNext={approveAndNext} /> : inv.hasPdf ? <PdfViewer isMobile={isMobile} inv={inv} pdfUrl={pdfUrl} pdfErr={pdfErr} setPdfRetry={setPdfRetry} /> : <EmailBodyCard inv={inv} />}

          {/* Info panel — sticky + independently scrollable so it stays visible while
              you scroll a multi-page PDF, instead of scrolling away with the page */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 16,
            position: (inv.hasPdf && !isMobile) ? 'sticky' : 'static', top: 0,
            maxHeight: (inv.hasPdf && !isMobile) ? 'calc(100vh - 88px)' : 'none',
            overflowY: (inv.hasPdf && !isMobile) ? 'auto' : 'visible',
            paddingRight: (inv.hasPdf && !isMobile) ? 4 : 0,
          }}>

            {/* Summary card */}
            <SummaryCard id={id} inv={inv} editing={editing} form={form} updateField={updateField} isExpense={isExpense} typeLabel={typeLabel} />

            {/* Claim Purpose / Description card */}
            {(inv.description || editing || inv.invoiceType === 'EXPENSE') && (
              <div className="card">
                <div className="card-title" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>📝</span> {inv.invoiceType === 'EXPENSE' ? 'Claim Purpose / Description' : 'Description'}
                </div>
                {editing ? (
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <textarea
                      className="form-input"
                      rows={2}
                      value={form.description || ''}
                      placeholder="e.g. [Entertainment/Meals] Business working lunch with client @ Dong Seoul Supply"
                      onChange={e => updateField('description', e.target.value)}
                      style={{ resize: 'vertical', fontFamily: 'inherit' }}
                    />
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {[
                        { label: '💼 Client Lunch', prefix: '[Entertainment/Meals] Business working lunch with client' },
                        { label: '🍷 Client Dinner', prefix: '[Entertainment/Meals] Client business dinner discussion' },
                        { label: '👥 Team Welfare', prefix: '[Staff Welfare] Team project meeting refreshments & lunch' },
                        { label: '🚗 Business Transit', prefix: '[Local Travel] Business transit to client meeting' },
                        { label: '🌙 Overtime Commute', prefix: '[Local Travel] Late-night event commute home' },
                        { label: '✈️ Overseas Travel', prefix: '[Overseas Travel] Business travel accommodation / transit' },
                      ].map(preset => (
                        <button
                          key={preset.label}
                          type="button"
                          className="btn btn-sm btn-ghost"
                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
                          onClick={() => {
                            const merchant = form.vendorName || inv.vendorName || '';
                            updateField('description', `${preset.prefix}${merchant ? ` @ ${merchant}` : ''}`);
                          }}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{
                    fontSize: 13,
                    color: inv.description ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontStyle: inv.description ? 'normal' : 'italic',
                    lineHeight: 1.5,
                    background: 'var(--bg-secondary)',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border)'
                  }}>
                    {inv.description || 'No description provided'}
                  </div>
                )}
              </div>
            )}

            {/* Vendor card */}
            <div className="card">
              <div className="card-title" style={{ marginBottom: 12 }}>{isExpense ? 'Merchant' : inv.invoiceType === 'ACCREC' ? 'Client / Contact' : 'Vendor / Contact'}</div>
              {editing ? (
                <>
                  <div className="form-group">
                    <label htmlFor="rv-contact-name" className="form-label">Name</label>
                    <input id="rv-contact-name" className="form-input" value={form.vendorName}
                      onChange={e => updateField('vendorName', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="rv-contact-email" className="form-label">Email</label>
                    <input id="rv-contact-email" className="form-input" value={form.contactEmail}
                      onChange={e => updateField('contactEmail', e.target.value)} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label htmlFor="rv-contact-address" className="form-label">Address</label>
                    <textarea id="rv-contact-address" className="form-input" rows={2} value={form.contactAddress}
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
                  {/* A claim is a photo from a phone — nothing emailed it. */}
                  {!isExpense && <InfoRow label="From email" value={inv.sourceEmail} />}
                </>
              )}
            </div>

            {/* Line items + payment reference — merged into one card since both relate
                to "what am I actually paying for" and payment ref is short */}
            {((editing ? form.lineItems : inv.lineItems)?.length > 0 || inv.paymentReference || editing) && <LineItemsCard id={id} inv={inv} editing={editing} form={form} updateField={updateField} updateLineItem={updateLineItem} />}

            {/* Reports */}
            {inv.reports?.length > 0 && (
              <div className="card" style={{ border: '1px solid rgba(239,68,68,0.25)', background: 'var(--danger-subtle)' }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--danger)', marginBottom: 10 }}>⚠ Reported Issues ({inv.reports.length})</div>
                {inv.reports.map((r, i) => (
                  <div key={i} style={{ padding: '8px 0', borderTop: i > 0 ? '1px solid rgba(239,68,68,0.15)' : 'none' }}>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>{r.note}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      by {r.userEmail} · {r.reportedAt ? formatDateTime(r.reportedAt, user?.timezone) : ''}
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
                  <InfoRow label="Processed"  value={formatDateTime(inv.processedAt, user?.timezone)} />
                  {inv.submittedAt && (
                    <InfoRow label="Submitted" value={formatDateTime(inv.submittedAt, user?.timezone)} />
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
        {isMobile && <div style={{ height: 24 }} />}

        {/* Sticky action bar on mobile */}
        {isMobile && <StickyActionBar inv={inv} marking={marking} submitting={submitting} editing={editing} saving={saving} markReviewed={markReviewed} submitToXero={submitToXero} startEdit={startEdit} cancelEdit={cancelEdit} saveEdit={saveEdit} canSubmit={canSubmit} canReview={canReview} canEdit={canEdit} />}
      </div>

      <DeleteConfirmModal
        isOpen={showDeleteModal}
        title={isExpense ? 'Delete Receipt' : 'Delete Invoice'}
        itemName={inv.vendorName || inv.invoiceNumber || inv.id}
        isExpense={isExpense}
        confirmLabel={isExpense ? 'Delete Receipt' : 'Delete Invoice'}
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => { if (!deleting) setShowDeleteModal(false); }}
      />
    </>
  );
}

// Every piece of state on this page belongs to ONE record. Prev/Next and the
// filmstrip change :id without unmounting, so edit mode, the submit poll and
// the rotation survived into the next record — Save could patch the wrong
// one. Keying on the id remounts the page with fresh state for each record.
export default function InvoiceReview() {
  const { id } = useParams();
  return <InvoiceReviewPage key={id} />;
}
