export default function ActiveClaimBanner({ activeClaimJob, setClaimModalJobId }) {
  return (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', background: 'rgba(99, 102, 241, 0.08)',
          border: '1px solid rgba(99, 102, 241, 0.3)', borderRadius: 14,
          marginBottom: 16, animation: 'fadeIn 0.2s ease', gap: 12, flexWrap: 'wrap'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{
              display: 'inline-block', width: 16, height: 16,
              border: '2px solid rgba(99, 102, 241, 0.3)',
              borderTopColor: 'var(--accent)', borderRadius: '50%',
              animation: 'spin 0.8s linear infinite'
            }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)' }}>
                Claim Import in Progress: {activeClaimJob.label || 'Expense claim'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                Stage: <strong style={{ color: 'var(--accent)', textTransform: 'capitalize' }}>{activeClaimJob.stage}</strong>
                {activeClaimJob.receiptsTotal > 0 && ` • Receipts read: ${activeClaimJob.receiptsRead || 0} / ${activeClaimJob.receiptsTotal}`}
                {activeClaimJob.rowsTotal > 0 && ` • Form rows: ${activeClaimJob.rowsTotal}`}
              </div>
            </div>
          </div>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => setClaimModalJobId(activeClaimJob.id)}
          >
            View Progress →
          </button>
        </div>
  );
}
