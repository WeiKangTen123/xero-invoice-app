export default function StickyActionBar({ inv, marking, submitting, editing, saving, markReviewed, submitToXero, startEdit, cancelEdit, saveEdit, canSubmit, canReview, canEdit }) {
  return (
          <div style={{
            position: 'sticky',
            bottom: 'var(--bottom-nav-total)',
            // Negative bottom margin cancels .page-body's bottom padding so the
            // bar can sit flush on the nav; it has to track that padding, which
            // is now derived from the same variable.
            margin: '16px calc(-1 * var(--page-pad-x)) calc(-1 * (var(--bottom-nav-total) + 16px))',
            padding: '10px var(--page-pad-x)',
            background: 'var(--bg-card)',
            borderTop: '1px solid var(--border)',
            boxShadow: '0 -4px 16px rgba(0,0,0,0.1)',
            display: 'flex',
            gap: 8,
            zIndex: 40,
            backdropFilter: 'blur(8px)',
            alignItems: 'center',
          }}>
            {canSubmit && (
              <button
                className="btn btn-primary btn-sm"
                style={{ flex: 1, padding: '8px 10px', fontSize: 12 }}
                onClick={submitToXero}
                disabled={submitting}
              >
                {submitting ? 'Posting...' : inv.status === 'posted' ? '↻ Re-post' : '→ Post to Xero'}
              </button>
            )}
            {canReview && (
              <button
                className="btn btn-success btn-sm"
                style={{ flex: 1, padding: '8px 10px', fontSize: 12 }}
                onClick={markReviewed}
                disabled={marking}
              >
                {marking ? '...' : '✓ Reviewed'}
              </button>
            )}
            {!editing && canEdit && (
              <button className="btn btn-outline btn-sm" style={{ padding: '8px 12px', fontSize: 12 }} onClick={startEdit}>
                ✎ Edit
              </button>
            )}
            {editing && (
              <>
                <button className="btn btn-outline btn-sm" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </button>
                <button className="btn btn-primary btn-sm" style={{ flex: 1, padding: '8px 10px', fontSize: 12 }} onClick={saveEdit} disabled={saving}>
                  {saving ? 'Saving...' : '✓ Save'}
                </button>
              </>
            )}
          </div>
  );
}
