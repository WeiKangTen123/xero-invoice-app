import { totalsLabel } from './helpers';

export default function ClaimBatchCards({ claimBatches, handleBatchApprove, handleUndoBatch }) {
  return (
        <div style={{ marginBottom: 16 }}>
          {claimBatches.map(b => {
            const verifiedItems = b.items.filter(i => i.status === 'review-needed' && !i.errorMsg);
            const discrepancyItems = b.items.filter(i => i.errorMsg);
            const reviewedItems = b.items.filter(i => ['reviewed', 'posted'].includes(i.status));
            return (
              <div key={b.groupId} style={{
                padding: '12px 16px', background: 'var(--bg-card)',
                border: '1px solid var(--border)', borderRadius: 12,
                marginBottom: 8, display: 'flex', flexWrap: 'wrap',
                alignItems: 'center', justifyContent: 'space-between', gap: 12,
                boxShadow: 'var(--shadow-sm)'
              }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>📁</span>
                    <strong>Batch: {b.groupId}</strong>
                    <span className="badge badge-gray">{b.items.length} claims</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      Total: {totalsLabel(b.totals)}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--success)' }}>✓ {verifiedItems.length} verified</span>
                    {discrepancyItems.length > 0 && (
                      <span style={{ color: 'var(--warning)', fontWeight: 600 }}>⚠️ {discrepancyItems.length} need attention</span>
                    )}
                    {reviewedItems.length > 0 && (
                      <span style={{ color: 'var(--accent)' }}>● {reviewedItems.length} ready to post</span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {verifiedItems.length > 0 && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => handleBatchApprove(verifiedItems.map(i => i.id))}
                      title="Mark all verified claims in this batch as Ready to Post"
                    >
                      ✓ Approve Verified ({verifiedItems.length})
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-outline"
                    onClick={() => handleUndoBatch(b.groupId)}
                    style={{ color: 'var(--danger)', borderColor: 'rgba(239, 68, 68, 0.3)' }}
                    title="Undo and remove all claims and receipts in this batch"
                  >
                    Undo Batch
                  </button>
                </div>
              </div>
            );
          })}
        </div>
  );
}
