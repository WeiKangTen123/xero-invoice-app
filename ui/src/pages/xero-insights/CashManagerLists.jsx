import { Fragment, useMemo, useState } from 'react';
import { fmtCell } from '../../utils/format';
import {
  amountChanged, basisHint, basisLabel, contactOf, filterOptions, groupOptions, itemTitle, listRows, longDay,
} from './cash-manager';

// "Manage cash in" and "Manage cash out": every invoice, bill, repeating
// item, payment and entry the forecast is built from, one side at a time,
// with the controls to move one to another date, change what it is expected
// to bring, leave it out, or (for an entry made here) edit or delete it. None
// of it touches Xero; the tab says so above, and each change's toast again.
//
// The table scrolls sideways in its own box with the contact pinned, as the
// budget grid does, so a phone can reach the actions without losing the row.

// Where an expected date came from, as a small tag beside it. A date changed
// here is marked in the accent colour: it is the one thing on the row Xero
// does not know.
export function BasisMarker({ basis }) {
  const label = basisLabel(basis);
  if (!label) return null;
  const mine = basis === 'override' || basis === 'manual';
  return (
    <span title={basisHint(basis)} style={{
      marginLeft: 6, padding: '0 5px', fontSize: 10, fontWeight: 600, borderRadius: 4, whiteSpace: 'nowrap',
      border: `1px solid ${mine ? 'var(--accent)' : 'var(--border)'}`, color: mine ? 'var(--accent)' : 'var(--text-muted)',
    }}>
      {label}
    </span>
  );
}

const EMPTY = {
  current:  { in: 'Nothing is expected to come in.', out: 'Nothing is expected to go out.' },
  overdue:  { in: 'No customer is overdue.',         out: 'No bill is overdue.' },
  excluded: { in: 'Nothing is excluded. Exclude an item to leave it out of the forecast; Xero is unchanged.',
              out: 'Nothing is excluded. Exclude an item to leave it out of the forecast; Xero is unchanged.' },
  all:      { in: 'Nothing to come in yet.',         out: 'Nothing to go out yet.' },
};

export function CashList({ payload, direction, busyKey, onEdit, onToggleExclude, onDelete, onAdd }) {
  const [filter, setFilter] = useState('current');
  const [groupBy, setGroupBy] = useState('none');
  const list = useMemo(() => listRows(payload?.items, direction, { filter, groupBy }), [payload, direction, filter, groupBy]);
  const side = direction === 'out' ? 'cash out' : 'cash in';
  const cols = 6;

  const th = { padding: '7px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap', textAlign: 'left', borderBottom: '1px solid var(--border)' };
  const td = { padding: '7px 10px', verticalAlign: 'top' };
  const pinned = extra => ({ position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-card)', ...extra });
  const small = { padding: '2px 8px', fontSize: 11.5 };

  return (
    <div>
      {/* Wraps on a phone: the filters on one line, grouping and Add on the next. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', margin: '14px 0 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div role="group" aria-label="Show" style={{ display: 'flex', gap: 2, background: 'var(--bg-secondary)', borderRadius: 7, padding: 2, flexWrap: 'wrap' }}>
            {filterOptions().map(o => (
              <button key={o.key} type="button" aria-pressed={filter === o.key} onClick={() => setFilter(o.key)} style={{
                padding: '4px 10px', fontSize: 11.5, fontWeight: 600, borderRadius: 5, cursor: 'pointer', border: 'none',
                background: filter === o.key ? 'var(--accent-gradient)' : 'transparent',
                color: filter === o.key ? '#fff' : 'var(--text-muted)',
              }}>
                {o.label} ({list.counts[o.key]})
              </button>
            ))}
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            Group by
            <select className="form-input" style={{ width: 'auto', fontSize: 12, padding: '5px 8px' }} value={groupBy}
                    onChange={e => setGroupBy(e.target.value)}>
              {groupOptions().map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => onAdd?.(direction)}>+ Add {side}</button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={pinned({ ...th, zIndex: 2 })}>Contact</th>
              <th style={th}>Number / Description</th>
              <th style={th}>Due date</th>
              <th style={th}>Expected date</th>
              <th style={{ ...th, textAlign: 'right' }}>Amount</th>
              <th style={th} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {list.count === 0 && (
              <tr><td colSpan={cols} style={{ padding: '18px 0', color: 'var(--text-muted)' }}>{EMPTY[list.filter][direction === 'out' ? 'out' : 'in']}</td></tr>
            )}
            {list.groups.map(g => (
              <Fragment key={g.key}>
                {list.groupBy !== 'none' && (
                  <tr style={{ background: 'var(--bg-secondary)' }}>
                    <td colSpan={4} style={pinned({ ...td, background: 'var(--bg-secondary)', fontWeight: 700 })}>
                      {g.label} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {g.rows.length}</span>
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtCell(g.total)}</td>
                    <td />
                  </tr>
                )}
                {g.rows.map(item => {
                  const t = itemTitle(item);
                  const busy = busyKey === item.key;
                  const manual = item.source === 'manual';
                  const muted = item.excluded ? { color: 'var(--text-muted)' } : {};
                  return (
                    <tr key={item.key} style={{ borderBottom: '1px solid var(--border)', ...muted }}>
                      <td style={pinned({ ...td, maxWidth: 220 })}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contactOf(item)}</div>
                        {item.excluded && <span className="badge badge-gray" style={{ fontSize: 10, marginTop: 2 }}>Excluded</span>}
                      </td>
                      <td style={{ ...td, minWidth: 140 }}>
                        {t.primary}
                        {t.secondary && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.secondary}</div>}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: item.overdue && !item.excluded ? 'var(--danger)' : undefined }}>
                        {item.dueDate ? longDay(item.dueDate) : '—'}
                        {item.overdue && <div style={{ fontSize: 10.5, fontWeight: 600 }}>Overdue</div>}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {longDay(item.date) || '—'}
                        <BasisMarker basis={item.dateBasis} />
                      </td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                                   textDecoration: item.excluded ? 'line-through' : undefined }}>
                        {fmtCell(item.amount)}
                        {/* The amount is in the base currency, converted by
                            the server; an invoice raised in another currency
                            shows what it was raised for under it. */}
                        {item.foreign && item.faceAmount !== null && item.faceAmount !== undefined && (
                          <div style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--text-muted)' }}>{item.currency} {fmtCell(item.faceAmount)}</div>
                        )}
                        {amountChanged(item) && (
                          <div style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--accent)' }} title="Changed in this app. Xero is unchanged.">
                            Xero: {fmtCell(item.originalAmount)}
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <span style={{ display: 'inline-flex', gap: 4 }}>
                          <button type="button" className="btn btn-outline btn-sm" style={small} disabled={busy}
                                  aria-label={manual ? 'Edit entry' : 'Change date or amount'} title={manual ? 'Edit entry' : 'Change date or amount'}
                                  onClick={() => onEdit?.(item)}>✎</button>
                          <button type="button" className="btn btn-outline btn-sm" style={small} disabled={busy}
                                  title={item.excluded ? 'Count it in the forecast again' : 'Leave it out of the forecast; Xero is unchanged'}
                                  onClick={() => onToggleExclude?.(item)}>
                            {busy ? <span className="btn-spinner" /> : item.excluded ? 'Include' : 'Exclude'}
                          </button>
                          {manual && (
                            <button type="button" className="btn btn-outline btn-sm" style={{ ...small, color: 'var(--danger)' }} disabled={busy}
                                    aria-label="Delete entry" title="Delete entry" onClick={() => onDelete?.(item)}>Delete</button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
          {list.count > 0 && (
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)' }}>
                <td colSpan={4} style={pinned({ ...td, fontWeight: 700 })}>Total · {list.count} item{list.count === 1 ? '' : 's'}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtCell(list.total)}</td>
                <td />
              </tr>
              {/* Under "All", what the forecast counts and what it leaves out
                  are told apart: a total with excluded items in it is not
                  the figure the chart is drawn from. */}
              {list.excludedCount > 0 && list.filter !== 'excluded' && (
                <>
                  <tr>
                    <td colSpan={4} style={pinned({ ...td, color: 'var(--text-muted)' })}>Counted in the forecast</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCell(list.counted)}</td>
                    <td />
                  </tr>
                  <tr>
                    <td colSpan={4} style={pinned({ ...td, color: 'var(--text-muted)' })}>Excluded ({list.excludedCount}), not counted</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{fmtCell(list.excluded)}</td>
                    <td />
                  </tr>
                </>
              )}
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
