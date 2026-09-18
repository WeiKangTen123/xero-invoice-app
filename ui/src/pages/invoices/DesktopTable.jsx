import { fmtMoney } from '../../utils/format';
import { formatDateTime } from '../../utils/formatDate';
import { TypeBadge } from '../../components/Badges';
import { statusMeta, ATTENTION_STATUSES } from '../../utils/badges';
import { receivedLabel, totalsLabel } from './helpers';

export default function DesktopTable({ user, navigate, invoices, selected, deleteTarget, deleteLoading, promptDeleteOne, toggleSelect, allFilteredSelected, toggleSelectAll, groups, isOpen, toggleGroup }) {
  return (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 36, paddingRight: 0 }}>
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      style={{ cursor: 'pointer', accentColor: 'var(--accent)', width: 15, height: 15 }}
                      title={allFilteredSelected ? 'Deselect all' : 'Select all visible'}
                    />
                  </th>
                  <th>Vendor</th>
                  <th>Invoice #</th>
                  <th>Amount</th>
                  <th>Type</th>
                  <th>Invoice date</th>
                  <th>Received</th>
                  <th>PDF</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {groups.flatMap(g => [
                  // A full-width row inside the same table — separate tables per
                  // group would let the columns drift out of alignment.
                  <tr key={`h-${g.key}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td colSpan={10} style={{ padding: '14px 10px 8px', cursor: 'pointer' }}
                        onClick={() => toggleGroup(g.key)}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 10 }}>{isOpen(g) ? '▼' : '▶'}</span>
                        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' }}>{g.label}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {g.rows.length}</span>
                        {/* How much came in — the main reason to group at all. */}
                        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                          {totalsLabel(g.totals)}
                        </span>
                      </div>
                      {g.note && (
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 20, marginTop: 3 }}>↳ {g.note}</div>
                      )}
                    </td>
                  </tr>,
                  ...(isOpen(g) ? g.rows : []).map((inv, i) => {
                  const { cls, label } = statusMeta(inv.status);
                  const isSelected    = selected.has(inv.id);
                  const needsAttention = ATTENTION_STATUSES.includes(inv.status);
                  const isDup         = inv.status === 'duplicate' || !!inv.duplicateOf || (!!inv.errorMsg && /duplicate/i.test(inv.errorMsg));
                  return (
                    <tr
                      key={inv.id}
                      style={{
                        cursor: 'pointer',
                        animation: `fadeUp 0.2s ease ${i * 25}ms both`,
                        background: isSelected
                          ? 'var(--accent-subtle)'
                          : isDup ? 'rgba(239,68,68,0.04)' : needsAttention ? 'rgba(245,158,11,0.04)' : undefined,
                        transition: 'background 0.15s, opacity 0.2s',
                      }}
                      onClick={() => navigate(`/invoices/${inv.id}`)}
                    >
                      <td style={{ paddingRight: 0 }} onClick={e => toggleSelect(inv.id, e)}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          style={{ cursor: 'pointer', accentColor: 'var(--accent)', width: 15, height: 15 }}
                        />
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <div style={{
                            width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                            background: isDup ? 'rgba(239,68,68,0.12)' : needsAttention ? 'rgba(245,158,11,0.12)' : 'var(--accent-subtle)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 11, fontWeight: 700,
                            color: isDup ? 'var(--danger)' : needsAttention ? 'var(--warning)' : 'var(--accent)',
                          }}>
                            {isDup ? '⚠' : (inv.vendorName || '?').slice(0, 2).toUpperCase()}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <span style={{ fontWeight: 500 }}>{inv.vendorName || '—'}</span>
                            {isDup && (
                              <span style={{ fontSize: 10.5, color: 'var(--danger)', fontWeight: 600, marginTop: 1 }}>
                                ↳ ⚠ Duplicate {inv.duplicateOf ? `of #${inv.duplicateOf.slice(-6)}` : 'detected'}
                              </span>
                            )}
                            {inv.description && inv.description !== inv.vendorName && (
                              <span style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={inv.description}>
                                {inv.description}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        <code style={{ fontSize: 12, background: 'var(--bg-secondary)', padding: '2px 7px', borderRadius: 4, color: 'var(--text-secondary)' }}>
                          {inv.invoiceNumber || '—'}
                        </code>
                      </td>
                      <td style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {inv.totalAmount != null
                          ? fmtMoney(inv.totalAmount, inv.currency)
                          : '—'}
                      </td>
                      <td>
                        <TypeBadge type={inv.invoiceType} />
                        {/* Two rows from one upload look identical otherwise. */}
                        {inv.receiptGroup && (
                          <span className="badge badge-gray" style={{ marginLeft: 4, fontSize: 11 }}
                                title="One of several receipts found in a single upload">
                            {inv.receiptPage ? `p${inv.receiptPage}` : 'split'}
                          </span>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {inv.invoiceDate || '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
                          title={[
                            inv.receivedAt  ? `Arrived: ${formatDateTime(inv.receivedAt, user?.timezone)}` : null,
                            inv.processedAt ? `Scanned: ${formatDateTime(inv.processedAt, user?.timezone)}` : null,
                          ].filter(Boolean).join('\n')}>
                        {receivedLabel(inv.receivedAt || inv.processedAt)}
                      </td>
                      <td>
                        {inv.receiptFile
                          ? <span className="badge badge-yellow" title={inv.source === 'phone' ? 'Captured with phone' : 'Receipt photo'}>
                              {inv.source === 'phone' ? '📱 Phone' : '🧾 Receipt'}
                            </span>
                          : inv.hasPdf
                            ? <span className="badge badge-green">📄 PDF</span>
                            : <span className="badge badge-gray">✉ Email</span>}
                      </td>
                      <td>
                        {isDup && inv.status !== 'duplicate' ? (
                          <span className="badge badge-purple" title={inv.errorMsg || 'Possible duplicate'}>
                            ⚠ Suspected Dup
                          </span>
                        ) : (
                          <span className={`badge ${cls}`}>{label}</span>
                        )}
                      </td>
                      <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => navigate(`/invoices/${inv.id}`)}
                            style={isDup
                              ? { background: 'rgba(239,68,68,0.08)', color: 'var(--danger)', borderColor: 'rgba(239,68,68,0.3)' }
                              : inv.status === 'reviewed'
                                ? { background: 'var(--info-subtle)', color: 'var(--info)', borderColor: 'rgba(59,130,246,0.3)' }
                                : undefined}
                          >
                            {inv.status === 'duplicate' || isDup
                              ? 'Review Duplicate →'
                              : inv.status === 'review-needed' || inv.status === 'error'
                                ? 'Fix & Post →'
                                : inv.status === 'reviewed'
                                  ? 'Post to Xero →'
                                  : inv.status === 'posted'
                                    ? 'View →'
                                    : 'Review →'}
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={deleteLoading && deleteTarget?.invoice?.id === inv.id}
                            onClick={e => promptDeleteOne(inv, e)}
                            style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)', minWidth: 28 }}
                            title={inv.invoiceType === 'EXPENSE' || inv.receiptFile ? 'Delete this receipt' : 'Delete this invoice'}
                          >
                            {deleteLoading && deleteTarget?.invoice?.id === inv.id ? '...' : '✕'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                  }),
                ])}
              </tbody>
            </table>
          </div>
  );
}
