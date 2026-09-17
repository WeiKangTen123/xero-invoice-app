export default function EmailBodyCard({ inv }) {
  return (
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
  );
}
