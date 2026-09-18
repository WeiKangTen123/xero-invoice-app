import { fmtMoney } from '../../utils/format';
import { TypeBadge } from '../../components/Badges';
import { statusMeta, ATTENTION_STATUSES } from '../../utils/badges';
import { totalsLabel } from './helpers';

export default function MobileList({ navigate, invoices, selected, deleteTarget, deleteLoading, promptDeleteOne, toggleSelect, filtered, allFilteredSelected, toggleSelectAll, groups, isOpen, toggleGroup }) {
  return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Mobile Select-all row if items exist */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 6px', borderBottom: '1px solid var(--border)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)' }}>
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAll}
                  style={{ cursor: 'pointer', accentColor: 'var(--accent)', width: 16, height: 16 }}
                />
                <span>Select all visible ({filtered.length})</span>
              </label>
            </div>

            {groups.map(g => (
              <div key={`g-m-${g.key}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Group heading */}
                <div
                  onClick={() => toggleGroup(g.key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 10px',
                    background: 'var(--bg-secondary)',
                    borderRadius: 8,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{isOpen(g) ? '▼' : '▶'}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>{g.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {g.rows.length}</span>
                  </div>
                  {g.totals.length ? (
                    <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                      {totalsLabel(g.totals)}
                    </span>
                  ) : null}
                </div>

                {isOpen(g) && g.rows.map((inv) => {
                  const { cls, label } = statusMeta(inv.status);
                  const isSelected = selected.has(inv.id);
                  const needsAttention = ATTENTION_STATUSES.includes(inv.status);
                  const isDup = inv.status === 'duplicate' || !!inv.duplicateOf || (!!inv.errorMsg && /duplicate/i.test(inv.errorMsg));

                  return (
                    <div
                      key={inv.id}
                      onClick={() => navigate(`/invoices/${inv.id}`)}
                      style={{
                        padding: '12px 14px',
                        borderRadius: 12,
                        background: isSelected ? 'var(--accent-subtle)' : 'var(--bg-secondary)',
                        border: `1px solid ${isSelected ? 'var(--accent)' : isDup ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        transition: 'all 0.18s ease',
                      }}
                    >
                      {/* Top Row: Checkbox, Vendor info & Amount */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            onClick={e => toggleSelect(inv.id, e)}
                            style={{ cursor: 'pointer', accentColor: 'var(--accent)', width: 17, height: 17, flexShrink: 0 }}
                          />
                          <div style={{
                            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                            background: isDup ? 'rgba(239,68,68,0.12)' : needsAttention ? 'rgba(245,158,11,0.12)' : 'var(--accent-subtle)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 12, fontWeight: 700,
                            color: isDup ? 'var(--danger)' : needsAttention ? 'var(--warning)' : 'var(--accent)',
                          }}>
                            {isDup ? '⚠' : (inv.vendorName || '?').slice(0, 2).toUpperCase()}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {inv.vendorName || '—'}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                              <code style={{ fontSize: 11, background: 'var(--bg-card)', padding: '1px 6px', borderRadius: 4, color: 'var(--text-secondary)' }}>
                                #{inv.invoiceNumber || '—'}
                              </code>
                            </div>
                          </div>
                        </div>

                        {/* Amount */}
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                            {inv.totalAmount != null
                              ? fmtMoney(inv.totalAmount, inv.currency)
                              : '—'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            {inv.invoiceDate || '—'}
                          </div>
                        </div>
                      </div>

                      {/* Duplicate warning callout if duplicate */}
                      {isDup && (
                        <div style={{
                          padding: '6px 10px',
                          background: 'rgba(239,68,68,0.08)',
                          border: '1px solid rgba(239,68,68,0.22)',
                          borderRadius: 6,
                          fontSize: 11,
                          color: 'var(--danger)',
                          fontWeight: 600,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}>
                          <span>⚠ Duplicate {inv.duplicateOf ? `of #${inv.duplicateOf.slice(-6)}` : 'detected'}</span>
                        </div>
                      )}

                      {/* Bottom row: badges + Review action */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <TypeBadge type={inv.invoiceType} />
                          {inv.receiptFile
                            ? <span className="badge badge-yellow">{inv.source === 'phone' ? '📱' : '🧾'}</span>
                            : inv.hasPdf
                              ? <span className="badge badge-green">📄</span>
                              : <span className="badge badge-gray">✉</span>}
                          {isDup && inv.status !== 'duplicate' ? (
                            <span className="badge badge-purple">⚠ Suspected Dup</span>
                          ) : (
                            <span className={`badge ${cls}`}>{label}</span>
                          )}
                        </div>

                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => navigate(`/invoices/${inv.id}`)}
                            style={{
                              fontSize: 11.5,
                              padding: '4px 10px',
                              ...(isDup
                                ? { background: 'rgba(239,68,68,0.08)', color: 'var(--danger)', borderColor: 'rgba(239,68,68,0.3)' }
                                : inv.status === 'reviewed'
                                  ? { background: 'var(--info-subtle)', color: 'var(--info)', borderColor: 'rgba(59,130,246,0.3)' }
                                  : {})
                            }}
                          >
                            {inv.status === 'duplicate' || isDup
                              ? 'Review Dup →'
                              : inv.status === 'review-needed' || inv.status === 'error'
                                ? 'Fix →'
                                : inv.status === 'reviewed'
                                  ? 'Post →'
                                  : 'Review →'}
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={deleteLoading && deleteTarget?.invoice?.id === inv.id}
                            onClick={e => promptDeleteOne(inv, e)}
                            style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)', padding: '4px 8px', fontSize: 12 }}
                            title="Delete"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
  );
}
