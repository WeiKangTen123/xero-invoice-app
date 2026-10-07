import { fmtMoney } from '../../utils/format';
import { formatDateTime } from '../../utils/formatDate';
import { TypeBadge, ConfidenceBadge, XeroStatusBadge } from '../../components/Badges';
import { statusMeta, ATTENTION_STATUSES } from '../../utils/badges';
import { staggerIn } from '../../utils/stagger';
import { receivedLabel, totalsLabel } from './helpers';
import { SORT_FIELDS, dueInfo } from './list-view';
import { claimKindLabel, claimSourceBadge } from '../../components/receipts/allowance';

// Reset so the group heading's button looks like the row it always was; the
// button is there for the keyboard and screen readers, not for its looks.
// Reset property by property rather than with `all: unset`, which would take
// the browser's focus ring with it — the one thing a keyboard user needs here.
const GROUP_BUTTON = {
  display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'left',
  background: 'none', border: 'none', margin: 0, font: 'inherit', color: 'inherit',
  padding: '14px 10px 8px', cursor: 'pointer', borderRadius: 6,
};

// A column heading that sorts the list. A real button inside the <th>, so it
// is reached with Tab and pressed with Enter or Space like any other, and
// aria-sort tells a screen reader which column the list is in order of.
const SORT_BUTTON = {
  background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit', color: 'inherit',
  textTransform: 'inherit', letterSpacing: 'inherit', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
};
function SortHeader({ field, label, sort, onSort }) {
  const active = sort?.key === field;
  const f = SORT_FIELDS[field];
  return (
    <th aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(field)} style={SORT_BUTTON}
              title={active ? `Sorted ${f[sort.dir]}. Click to change.` : `Sort by ${f.label.toLowerCase()}, ${f[f.start]}`}>
        {label}
        <span aria-hidden="true" style={{ fontSize: 9, opacity: active ? 1 : 0.35 }}>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

export default function DesktopTable({ user, openRecord, invoices, selected, deleteTarget, deleteLoading, promptDeleteOne, toggleSelect, allFilteredSelected, toggleSelectAll, groups, isOpen, toggleGroup, sort, onSort, today, showDue }) {
  // Expense claims have no due date, so their tab has no Due column.
  const columns = showDue ? 11 : 10;
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
                  <SortHeader field="contact" label="Vendor" sort={sort} onSort={onSort} />
                  <th>Invoice #</th>
                  <SortHeader field="amount" label="Amount" sort={sort} onSort={onSort} />
                  <th>Type</th>
                  <SortHeader field="date" label="Invoice date" sort={sort} onSort={onSort} />
                  {showDue && <SortHeader field="due" label="Due" sort={sort} onSort={onSort} />}
                  <th>Received</th>
                  <th>PDF</th>
                  <SortHeader field="status" label="Status" sort={sort} onSort={onSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {groups.flatMap(g => [
                  // A full-width row inside the same table — separate tables per
                  // group would let the columns drift out of alignment.
                  // The heading is a real button, so a keyboard can open and
                  // close a group the way a mouse always could.
                  <tr key={`h-${g.key}`} style={{ borderTop: '1px solid var(--border)' }}>
                    <td colSpan={columns} style={{ padding: 0 }}>
                      <button type="button" onClick={() => toggleGroup(g.key)} aria-expanded={isOpen(g)}
                              style={GROUP_BUTTON}>
                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                          <span aria-hidden="true" style={{ fontSize: 10, color: 'var(--text-muted)', width: 10 }}>{isOpen(g) ? '▼' : '▶'}</span>
                          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' }}>{g.label}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {g.rows.length}</span>
                          {/* How much came in — the main reason to group at all. */}
                          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                            {totalsLabel(g.totals)}
                          </span>
                        </span>
                        {g.note && (
                          <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 20, marginTop: 3 }}>↳ {g.note}</span>
                        )}
                      </button>
                    </td>
                  </tr>,
                  ...(isOpen(g) ? g.rows : []).map((inv, i) => {
                  const { cls, label } = statusMeta(inv.status);
                  const isSelected    = selected.has(inv.id);
                  const needsAttention = ATTENTION_STATUSES.includes(inv.status);
                  const isDup         = inv.status === 'duplicate' || !!inv.duplicateOf || (!!inv.errorMsg && /duplicate/i.test(inv.errorMsg));
                  const due           = showDue ? dueInfo(inv, today) : null;
                  return (
                    <tr
                      key={inv.id}
                      style={{
                        cursor: 'pointer',
                        animation: staggerIn(i),
                        background: isSelected
                          ? 'var(--accent-subtle)'
                          : isDup ? 'rgba(239,68,68,0.04)' : needsAttention ? 'rgba(245,158,11,0.04)' : undefined,
                        transition: 'background 0.15s, opacity 0.2s',
                      }}
                      onClick={() => openRecord(inv.id)}
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
                            {isDup ? '⚠' : (inv.vendorName || claimKindLabel(inv) || '?').slice(0, 2).toUpperCase()}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <span style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              {inv.vendorName || claimKindLabel(inv) || '—'}
                              <ConfidenceBadge confidence={inv.confidence} style={{ fontSize: 10.5, padding: '1px 6px' }} />
                            </span>
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
                      {showDue && (
                        <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                          {/* An expense claim on this tab (there should be none)
                              shows nothing, as it has no due date. */}
                          {due && (due.overdue ? (
                            <span style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{due.label}</span>
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{due.date}</span>
                            </span>
                          ) : (
                            <span style={{ color: due.label === 'Due today' ? 'var(--warning)' : 'var(--text-muted)', fontWeight: due.label === 'Due today' ? 600 : 400 }}
                                  title={due.label === 'Due today' ? due.date : undefined}>
                              {due.label}
                            </span>
                          ))}
                        </td>
                      )}
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
                          title={[
                            inv.receivedAt  ? `Arrived: ${formatDateTime(inv.receivedAt, user?.timezone)}` : null,
                            inv.processedAt ? `Scanned: ${formatDateTime(inv.processedAt, user?.timezone)}` : null,
                          ].filter(Boolean).join('\n')}>
                        {receivedLabel(inv.receivedAt || inv.processedAt)}
                      </td>
                      <td>
                        {claimSourceBadge(inv)
                          ? <span className={claimSourceBadge(inv).className} title={claimSourceBadge(inv).title}>{claimSourceBadge(inv).text}</span>
                          : inv.receiptFile
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
                        {/* What became of it in Xero, under the app's own status. */}
                        <XeroStatusBadge invoice={inv} style={{ display: 'flex', marginTop: 4 }} />
                      </td>
                      <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => openRecord(inv.id)}
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
                            aria-label={`Delete ${inv.vendorName || inv.invoiceNumber || 'this record'}`}
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
