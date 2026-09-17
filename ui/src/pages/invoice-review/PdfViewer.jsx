export default function PdfViewer({ isMobile, inv, pdfUrl, pdfErr, setPdfRetry }) {
  return (
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
                  style={{ width: '100%', height: isMobile ? 360 : 'calc(100vh - 240px)', minHeight: isMobile ? 300 : 500, border: 'none', display: 'block', background: '#525659' }}
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
  );
}
