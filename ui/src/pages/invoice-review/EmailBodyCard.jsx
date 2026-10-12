import { sourceCard } from '../invoices/source';

// Where a record with no PDF, photo or allowance to show came from, and its
// text. Named for the email body it was first written for; an invoice typed
// into the form or imported from a spreadsheet says so instead (source.js).
export default function EmailBodyCard({ inv }) {
  const card = sourceCard(inv);
  return (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 18 }} aria-hidden="true">{card.icon}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{card.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{card.sub}</div>
                </div>
              </div>
              <pre style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: 8, padding: '14px 16px', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 400, overflowY: 'auto', border: '1px solid var(--border)', lineHeight: 1.6 }}>
                {inv.description || 'No content available'}
              </pre>
            </div>
  );
}
