import CroppedImage from '../../components/receipts/CroppedImage';
import { MARKABLE } from './helpers';

export default function ReceiptViewer({ isMobile, id, navigate, inv, receiptUrl, receiptRot, setReceiptRot, group, merging, approvingNext, rereading, rereadMsg, saving, receiptBox, rereadReceipt, mergeBack, approveAndNext }) {
  return (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>🧾</span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    Expense claim
                    {group?.split ? ` · ${group.index} of ${group.total}` : ''}
                    {inv.source === 'phone' ? ' · from phone' : ''}
                    {inv.receiptPage ? ` · page ${inv.receiptPage}` : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {/* A receipt is photographed one-handed and often lands sideways. */}
                  <button className="btn btn-outline btn-sm" onClick={() => setReceiptRot(r => (r + 90) % 360)} title="Rotate">↻</button>
                  {inv.receiptMime !== 'application/pdf' && (
                    <button className="btn btn-outline btn-sm" onClick={rereadReceipt} disabled={rereading}
                            title="Ask the reader to look at this photo again">
                      {rereading ? <><span className="btn-spinner" /> Reading…</> : '✦ Re-read'}
                    </button>
                  )}
                  {receiptUrl && (
                    <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm">↗ Full size</a>
                  )}
                </div>
              </div>
              {receiptUrl ? (
                <div style={{ background: '#1b1b1f', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isMobile ? 8 : 14, minHeight: isMobile ? 260 : 420, maxHeight: isMobile ? 360 : 'calc(100vh - 240px)', overflow: 'auto' }}>
                  {/* A split record owns one region of a shared photo, so only
                      that region is drawn. The file itself was never cut. */}
                  {inv.receiptMime === 'application/pdf' ? (
                    <iframe
                      src={`${receiptUrl}#page=${inv.receiptPage || 1}&zoom=page-width`}
                      title="Receipt PDF"
                      style={{ width: '100%', height: isMobile ? 340 : 'calc(100vh - 300px)', minHeight: isMobile ? 260 : 420, border: 'none', background: '#525659' }}
                    />
                  ) : (
                    <CroppedImage
                      src={receiptUrl}
                      box={receiptBox}
                      alt="Receipt"
                      style={{ maxWidth: '100%', maxHeight: isMobile ? 340 : 'calc(100vh - 280px)', objectFit: 'contain',
                               transform: `rotate(${receiptRot}deg)`, transition: 'transform .2s ease' }}
                    />
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, color: 'var(--text-muted)', gap: 10 }}>
                  <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
                  Loading receipt...
                </div>
              )}
              {group?.split && (() => {
                const isBatch = group.groupType === 'batch';
                const currentIdx = group.index - 1; // 0-based
                const prevSib = currentIdx > 0 ? group.siblings[currentIdx - 1] : null;
                const nextSib = currentIdx < group.total - 1 ? group.siblings[currentIdx + 1] : null;
                const canApprove = MARKABLE.has(inv?.status);

                if (isBatch) {
                  // ── Batch folder navigation bar ───────────────────────────
                  return (
                    <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                      {/* Top bar: label + Prev / index / Next */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.04em', textTransform: 'uppercase', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          📁 {group.batchLabel || 'Batch Import'}
                        </span>
                        <button
                          disabled={!prevSib}
                          onClick={() => prevSib && navigate(`/invoices/${prevSib.id}`)}
                          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', cursor: prevSib ? 'pointer' : 'not-allowed', opacity: prevSib ? 1 : 0.35, fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.2 }}
                          title="Previous (←)"
                        >← Prev</button>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)', minWidth: 52, textAlign: 'center' }}>
                          {group.index} / {group.total}
                        </span>
                        <button
                          disabled={!nextSib}
                          onClick={() => nextSib && navigate(`/invoices/${nextSib.id}`)}
                          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px', cursor: nextSib ? 'pointer' : 'not-allowed', opacity: nextSib ? 1 : 0.35, fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.2 }}
                          title="Next (→)"
                        >Next →</button>
                      </div>

                      {/* Pill filmstrip — click navigates instantly via SPA */}
                      <div className={isMobile ? "mobile-scroll-x" : ""} style={{ display: 'flex', gap: 5, flexWrap: isMobile ? 'nowrap' : 'wrap', padding: '8px 14px' }}>
                        {group.siblings.map((sib, i) => {
                          const isCurrent = sib.id === id;
                          const isDone    = sib.status === 'reviewed' || sib.status === 'posted';
                          return (
                            <button key={sib.id}
                              onClick={() => !isCurrent && navigate(`/invoices/${sib.id}`)}
                              style={{
                                fontSize: 11, padding: '4px 9px', borderRadius: 6, border: 'none', cursor: isCurrent ? 'default' : 'pointer',
                                background: isCurrent ? 'var(--accent)' : isDone ? 'var(--bg-success, #e6f4ea)' : 'var(--bg-primary)',
                                color: isCurrent ? '#fff' : isDone ? 'var(--success, #1a7f37)' : 'var(--text-secondary)',
                                outline: isCurrent ? 'none' : '1px solid var(--border)',
                                fontWeight: isCurrent ? 700 : 400,
                                flexShrink: 0,
                                whiteSpace: 'nowrap',
                              }}
                              title={sib.vendorName || `Claim ${i + 1}`}
                            >
                              {isDone && !isCurrent ? '✓ ' : ''}{i + 1}. {sib.vendorName || 'Unread'}{sib.totalAmount ? ` · ${sib.totalAmount}` : ''}
                            </button>
                          );
                        })}
                      </div>

                      {/* Approve & Next */}
                      {canApprove && (
                        <div style={{ padding: '0 14px 10px', display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={approveAndNext}
                            disabled={approvingNext}
                            style={{ fontSize: 12 }}
                          >
                            {approvingNext ? 'Marking…' : nextSib ? '✓ Approve & Next →' : '✓ Approve'}
                          </button>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                            Use ← → to navigate · Approved claims shown in green
                          </span>
                        </div>
                      )}
                    </div>
                  );
                }

                // ── Genuine photo/PDF split panel (unchanged behaviour) ───────
                return (
                  <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 8 }}>
                      {inv.receiptPage ? `Split from a ${group.total}-page PDF` : `Split from one photo of ${group.total} claims`}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {group.siblings.map((sib, i) => (
                        <button key={sib.id}
                          onClick={() => sib.id !== id && navigate(`/invoices/${sib.id}`)}
                          style={{ fontSize: 11, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--border)', cursor: sib.id === id ? 'default' : 'pointer',
                                   background: sib.id === id ? 'var(--accent)' : 'transparent',
                                   color: sib.id === id ? '#fff' : 'var(--text-secondary)' }}>
                          {i + 1}. {sib.vendorName || 'Unread'}{sib.totalAmount ? ` · ${sib.totalAmount}` : ''}
                        </button>
                      ))}
                    </div>
                    <button className="btn btn-outline btn-sm" onClick={mergeBack} disabled={merging}>
                      {merging ? 'Merging…' : '⇤ Merge back into one'}
                    </button>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                      The original upload is intact — merging deletes the other {group.total - 1} record
                      {group.total - 1 === 1 ? '' : 's'} and restores the whole {inv.receiptPage ? 'PDF' : 'photo'} here.
                    </div>
                  </div>
                );
              })()}

              {rereadMsg && (
                <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11.5, color: 'var(--warning)', lineHeight: 1.5 }}>
                  {rereadMsg}
                </div>
              )}
              <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Fields on the right were read from this {inv.receiptMime === 'application/pdf' ? 'PDF' : 'photo'} automatically. Check them against the
                image before saving — anything unreadable was left blank rather than guessed.
              </div>
            </div>
  );
}
