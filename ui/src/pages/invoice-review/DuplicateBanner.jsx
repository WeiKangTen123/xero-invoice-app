import { api } from '../../api/client';

export default function DuplicateBanner({ confirm, toast, id, navigate, inv, setShowDeleteModal, fetchInvoice }) {
  return (
          <div className="alert" style={{ marginBottom: 14, background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 12, padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 24, lineHeight: 1 }}>⚠</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger)' }}>
                    Duplicate Receipt Detected
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-primary)', marginTop: 4, lineHeight: 1.5 }}>
                    {inv.errorMsg || 'This claim matches an existing receipt already in your system.'}
                  </div>
                  {inv.duplicateOf && (
                    <div style={{ marginTop: 8 }}>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => navigate(`/invoices/${inv.duplicateOf}`)}
                        style={{ padding: '4px 10px', fontSize: 11.5, background: 'var(--bg-card)' }}
                      >
                        View Original Receipt (#{inv.duplicateOf.slice(-6)}) →
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
                {(inv.status === 'duplicate' || inv.duplicateOf) && (
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={async () => {
                      if (!(await confirm({ title: 'Keep as a separate expense?', message: 'This receipt stays its own claim and is marked for review.', confirmLabel: 'Keep separate' }))) return;
                      try {
                        await api.patch(`/invoices/${id}/status`, { status: 'review-needed', force: true, clearDuplicate: true });
                        fetchInvoice();
                      } catch (err) { toast.error(err.message); }
                    }}
                    style={{ fontSize: 12 }}
                  >
                    Keep Anyway (Not a duplicate)
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => setShowDeleteModal(true)}
                  style={{ fontSize: 12, background: 'var(--danger)', color: '#fff', border: 'none' }}
                >
                  🗑 Delete Duplicate
                </button>
              </div>
            </div>
          </div>
  );
}
