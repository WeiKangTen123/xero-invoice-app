import { fmtMoney } from '../../utils/format';

export default function DiscrepancyBanner({ inv, saving, discrepancyMatch, resolveDiscrepancy }) {
  return (
          <div className="alert alert-warning" style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10, border: '1px solid #f59e0b', background: 'rgba(245, 158, 11, 0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span className="alert-icon" style={{ fontSize: 18, marginTop: 1 }}>⚠️</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>Amount Discrepancy Detected</div>
                <div style={{ fontSize: 13, marginTop: 3, color: 'var(--text-primary)' }}>
                  The employee claimed <strong>{fmtMoney(discrepancyMatch.claimed, inv.currency || 'SGD')}</strong>, but the scanned receipt total is <strong>{fmtMoney(discrepancyMatch.onReceipt, inv.currency || 'SGD')}</strong>
                  <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>
                    ({discrepancyMatch.diff > 0 ? '+' : ''}{fmtMoney(discrepancyMatch.diff)})
                  </span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginLeft: 28 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving}
                onClick={() => resolveDiscrepancy(discrepancyMatch.onReceipt)}
              >
                ✓ Use Receipt Total ({fmtMoney(discrepancyMatch.onReceipt, inv.currency || 'SGD')})
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline"
                disabled={saving}
                onClick={() => resolveDiscrepancy(discrepancyMatch.claimed)}
              >
                Keep Claimed Amount ({fmtMoney(discrepancyMatch.claimed, inv.currency || 'SGD')})
              </button>
            </div>
          </div>
  );
}
