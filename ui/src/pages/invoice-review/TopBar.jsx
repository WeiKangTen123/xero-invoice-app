import { ConfidenceBadge, XeroStatusBadge } from '../../components/Badges';
import { claimKindLabel } from '../../components/receipts/allowance';
import { Spinner, StatusPill } from './bits';

// `onBack` is the page's own Back (see goBack in InvoiceReview.jsx), which
// returns to the list as it was left rather than to a fresh one.
// `repostLocked` is why a correction can no longer be sent (the record has
// left DRAFT in Xero), or null; the button stays in view, disabled, so its
// absence is not mistaken for a missing feature.
export default function TopBar({ isMobile, onBack, inv, setReporting, marking, submitting, editing, saving, setShowDeleteModal, deleting, markReviewed, submitToXero, startEdit, cancelEdit, saveEdit, isExpense, canSubmit, canReview, canEdit, repostLocked }) {
  return (
        <div style={{
          display: 'flex',
          alignItems: isMobile ? 'stretch' : 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          flexDirection: isMobile ? 'column' : 'row',
          gap: 12
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ gap: 6 }}>← Back</button>
            <div>
              <h1 style={{ fontSize: isMobile ? 18 : 20, fontWeight: 700, letterSpacing: '-0.4px' }}>
                {/* A mileage or per diem claim has no merchant: its kind stands in. */}
                {inv.vendorName || claimKindLabel(inv) || 'Unknown Vendor'}
              </h1>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                {inv.pdfFilename || inv.invoiceNumber}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', width: isMobile ? '100%' : 'auto' }}>
            <StatusPill status={inv.status} />
            <XeroStatusBadge invoice={inv} />
            <ConfidenceBadge confidence={inv.confidence} />

            {/* Post to Xero — creates a new draft, or (for an already-posted invoice)
                updates the existing Xero bill in place rather than duplicating it */}
            {canSubmit && (
              <button
                className="btn btn-primary btn-sm"
                onClick={submitToXero}
                disabled={submitting || !!repostLocked}
                style={{ gap: 6 }}
                title={repostLocked || (inv.status === 'posted' ? 'Updates the existing Xero bill — does not create a duplicate' : undefined)}
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

            {!editing && (
              <button
                className="btn btn-sm"
                style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)' }}
                onClick={() => setShowDeleteModal(true)}
                disabled={deleting}
                title={`Delete this ${isExpense ? 'receipt' : 'invoice'}`}
              >
                🗑 Delete
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
  );
}
