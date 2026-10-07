import { Fragment, useMemo, useState } from 'react';
import RetryAlert from '../../components/RetryAlert';
import { fmtMoney, fmtMoneyShort, fmtPct } from '../../utils/format';
import { dayLabel } from './bits';

// Receivables or payables by how late they are, and by contact, each contact
// opening onto the invoices behind its figures. Opened from the Total
// Receivables and Total Payables cards above it, so it is fetched only when
// someone asks: /api/xero-reports/ageing reads the summary's cached invoices
// and one cached read of credit notes, never a fresh ledger.
//
// The server works out every figure; this only sorts and draws them.

// Ordinal, not categorical: Current is the one good state, and the late
// buckets darken with age along one warm ramp, light to dark, so the order
// reads without a key. Each bucket also has its own labelled tile below the
// strip, so colour is never the only cue.
export const AGEING_COLORS = {
  current: 'var(--success)', d1_30: '#fbbf24', d31_60: '#f97316', d61_90: '#dc2626', d90plus: '#991b1b',
};

const SIDE_TEXT = {
  receivables: { label: 'Receivables', owed: 'owed to you', doc: 'invoice', who: 'customer', nothing: 'No approved sales invoice is waiting to be paid.', report: 'Aged Receivables' },
  payables:    { label: 'Payables',    owed: 'you owe',     doc: 'bill',    who: 'supplier', nothing: 'No approved bill is waiting to be paid.',          report: 'Aged Payables' },
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Contacts in the order the table shows them: by total, or by what is over 90
// days, either way round. Ties go by name so a re-sort never shuffles equal
// rows. Self-contained on purpose — no imports, no React — so a test can read
// it straight out of this file and run it.
export function sortAgeingContacts(contacts, by, dir) {
  const val = c => Number((by === 'd90plus' ? c?.buckets?.d90plus : c?.total) || 0);
  const sign = dir === 'asc' ? 1 : -1;
  return [...(contacts || [])].sort((a, b) => (sign * (val(a) - val(b))) || String(a?.name || '').localeCompare(String(b?.name || '')));
}

// The strip's segments: each bucket's share of what is owed. A bucket a credit
// note has taken below nothing has no length to draw, so only positive ones
// are drawn; its tile still shows the figure. Self-contained, as above.
export function ageingSegments(buckets) {
  const pos = (buckets || []).filter(b => Number(b.amount) > 0);
  const sum = pos.reduce((s, b) => s + Number(b.amount), 0);
  return pos.map(b => ({ key: b.key, label: b.label, amount: Number(b.amount), share: sum > 0 ? Number(b.amount) / sum : 0 }));
}

// How late one row is, in words. A credit note is never late; it is credit.
// Self-contained, as above.
export function ageingDaysText(row) {
  if (row?.kind === 'credit-note') return 'Credit';
  const d = row?.daysOverdue;
  if (d === null || d === undefined) return '—';
  if (d < 0) return `Due in ${-d} day${d === -1 ? '' : 's'}`;
  if (d === 0) return 'Due today';
  return `${d} day${d === 1 ? '' : 's'} late`;
}

function SideSwitch({ side, onSide }) {
  return (
    <div role="group" aria-label="Receivables or payables"
         style={{ display: 'inline-flex', gap: 3, padding: 3, borderRadius: 9, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      {['receivables', 'payables'].map(s => (
        <button key={s} type="button" aria-pressed={side === s} className="tab-pill" onClick={() => onSide(s)} style={{
          padding: '5px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          background: side === s ? 'var(--accent-gradient)' : 'transparent',
          color: side === s ? '#fff' : 'var(--text-muted)', whiteSpace: 'nowrap',
        }}>{SIDE_TEXT[s].label}</button>
      ))}
    </div>
  );
}

function BucketStrip({ buckets, currency }) {
  const segs = ageingSegments(buckets);
  if (!segs.length) return null;
  return (
    <div role="img"
         aria-label={`By age: ${segs.map(s => `${s.label} ${fmtMoney(s.amount, currency)}`).join(', ')}`}
         style={{ display: 'flex', gap: 2, height: 12, margin: '12px 0 10px' }}>
      {segs.map((s, i) => (
        <div key={s.key} title={`${s.label}: ${fmtMoney(s.amount, currency)} (${fmtPct(s.share, 0)})`} style={{
          flex: `${s.share} 1 0`, minWidth: 4, background: AGEING_COLORS[s.key],
          borderRadius: `${i === 0 ? 4 : 0}px ${i === segs.length - 1 ? 4 : 0}px ${i === segs.length - 1 ? 4 : 0}px ${i === 0 ? 4 : 0}px`,
        }} />
      ))}
    </div>
  );
}

function BucketTiles({ buckets, total, currency, doc, isMobile }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 100 : 128}px, 1fr))`, gap: 8 }}>
      {buckets.map(b => (
        <div key={b.key} style={{ background: 'var(--bg-secondary)', borderRadius: 9, padding: '8px 11px',
                                  borderTop: `3px solid ${AGEING_COLORS[b.key]}` }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{b.label}</div>
          <div style={{ fontSize: isMobile ? 14 : 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                        color: b.amount < 0 ? 'var(--text-secondary)' : undefined }}>
            {b.amount === 0 ? <span style={{ color: 'var(--text-muted)' }}>—</span>
              : isMobile ? fmtMoneyShort(b.amount, currency) : fmtMoney(b.amount, currency)}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
            {plural(b.count, doc)}
            {total > 0 && b.amount > 0 && ` · ${fmtPct(b.amount / total, 0)}`}
          </div>
        </div>
      ))}
    </div>
  );
}

function SortHead({ label, by, sort, onSort, style }) {
  const active = sort.by === by;
  return (
    <th aria-sort={active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'} style={style}>
      <button type="button" onClick={() => onSort(by)} title={`Sort by ${label}`} style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
        color: active ? 'var(--text-primary)' : 'inherit', fontWeight: active ? 700 : 'inherit',
      }}>
        {label} <span aria-hidden="true" style={{ fontSize: 9 }}>{active ? (sort.dir === 'desc' ? '▼' : '▲') : '↕'}</span>
      </button>
    </th>
  );
}

// One contact's documents, oldest first: a table on a desktop, stacked lines on
// a phone, where six columns cannot fit.
function ContactDocs({ contact, currency, isMobile, limit, shortOf }) {
  const docs = contact.invoices || [];
  const amount = r => (
    <>
      <span style={{ color: r.amountDue < 0 ? 'var(--text-secondary)' : undefined }}>{fmtMoney(r.amountDue, r.currency || currency)}</span>
      {r.foreign && (
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>≈ {fmtMoney(r.amountDueBase, currency)}</div>
      )}
    </>
  );
  // Text keeps the page's own warning and danger inks, not the strip's fills,
  // which are too pale to read as type on a light card.
  const lateTone = r => (r.kind !== 'invoice' || !(r.daysOverdue > 0) ? 'var(--text-muted)'
    : r.daysOverdue > 60 ? 'var(--danger)' : 'var(--warning)');
  const what = r => (r.kind === 'credit-note' ? `Credit note ${r.number || ''}`.trim() : (r.number || 'No number'));

  return (
    <div style={{ padding: isMobile ? '4px 0 10px' : '4px 0 12px 22px' }}>
      {isMobile && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 6 }}>
          {Object.entries(contact.buckets).filter(([, v]) => v !== 0).map(([k, v]) => (
            <span key={k}><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: AGEING_COLORS[k], marginRight: 4 }} />
              {shortOf(k)} {fmtMoneyShort(v, currency)}</span>
          ))}
        </div>
      )}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {docs.map((r, i) => (
            <div key={`${r.kind}-${r.id || i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0',
                                                        borderTop: '1px solid var(--border)', fontSize: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{what(r)}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.kind === 'invoice' ? `Due ${dayLabel(r.dueDate) || '—'}` : dayLabel(r.date)}
                  {' · '}<span style={{ color: lateTone(r) }}>{ageingDaysText(r)}</span>
                  {r.reference ? ` · ${r.reference}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{amount(r)}</div>
            </div>
          ))}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              {['Number', 'Reference', 'Date', 'Due', 'Days late', 'Amount due'].map((h, i) => (
                <th key={h} style={{ padding: '5px 8px', textAlign: i >= 4 ? 'right' : 'left', fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {docs.map((r, i) => (
              <tr key={`${r.kind}-${r.id || i}`} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{what(r)}</td>
                <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.reference || '—'}</td>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{dayLabel(r.date) || '—'}</td>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{dayLabel(r.dueDate) || '—'}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap', color: lateTone(r) }}>{ageingDaysText(r)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{amount(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {contact.invoicesOmitted > 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>
          The {limit} oldest are listed; {contact.invoicesOmitted} more are in this contact&apos;s totals and in Xero.
        </div>
      )}
    </div>
  );
}

export default function AgeingSection({ side, onSide, state, onRetry, onClose, isMobile }) {
  const [sort, setSort] = useState({ by: 'total', dir: 'desc' });
  const [openKey, setOpenKey] = useState(null);
  const text = SIDE_TEXT[side] || SIDE_TEXT.receivables;
  // A failed reload keeps the last good figures in state, but they are not
  // shown under an error; nor is a reply that carries no ageing at all (a
  // connection removed since the page loaded answers connected:false).
  const d = !state?.error && Array.isArray(state?.data?.buckets) ? state.data : null;
  const cur = d?.currency || '';
  const contacts = useMemo(() => sortAgeingContacts(d?.contacts, sort.by, sort.dir), [d, sort]);
  // Keyed by side too: a contact can be both a customer and a supplier, and its
  // row on one side must not open itself on the other.
  const keyOf = c => `${side}:${c.contactId || `name:${c.name}`}`;
  const empty = d && !d.contacts?.length && !d.others;
  const overdue = d ? d.buckets.filter(b => b.key !== 'current').reduce((s, b) => s + b.amount, 0) : 0;

  function pickSide(s) {
    if (s !== side) onSide(s);
  }
  function onSort(by) {
    setSort(s => ({ by, dir: s.by === by && s.dir === 'desc' ? 'asc' : 'desc' }));
  }

  const bucketCols = isMobile ? ['d90plus'] : ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];
  const shortOf = k => d?.buckets.find(b => b.key === k)?.short || k;
  const cell = { padding: '8px 8px', textAlign: 'right', whiteSpace: 'nowrap' };
  const money = v => (v === 0 ? <span style={{ color: 'var(--text-muted)' }}>—</span>
    : <span style={{ color: v < 0 ? 'var(--text-secondary)' : undefined }}>{isMobile ? fmtMoneyShort(v, cur) : fmtMoney(v, cur)}</span>);

  return (
    <section id="dashboard-ageing" className="card" aria-label={`${text.label} ageing`} style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="card-title" style={{ marginBottom: 0 }}>Ageing</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            By days past the due date{d?.asOf ? ` · as of ${dayLabel(d.asOf)}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SideSwitch side={side} onSide={pickSide} />
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose} aria-label="Close ageing" title="Close">✕</button>
        </div>
      </div>

      {state?.status === 'loading' && !d && !state?.error && (
        <div style={{ padding: '22px 0', fontSize: 12.5, color: 'var(--text-muted)' }}>Loading {text.label.toLowerCase()} ageing…</div>
      )}

      {state?.error && (
        <RetryAlert message={`Could not load the ageing: ${state.error}`} onRetry={onRetry}
                    busy={state.status === 'loading'} style={{ marginTop: 14, marginBottom: 0 }} />
      )}

      {empty && (
        <div style={{ padding: '26px 0 10px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Nothing outstanding</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{text.nothing}</div>
        </div>
      )}

      {d && !empty && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: isMobile ? 19 : 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(d.total, cur)}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {text.owed} · {plural(d.count, text.doc)} · {plural(d.contactCount, text.who)}
                {d.credits?.amount > 0 && ` · after ${fmtMoney(d.credits.amount, cur)} of credit notes`}
              </span>
            </div>
            {overdue > 0 && (
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)' }}>
                ▲ {fmtMoney(overdue, cur)} past due{d.total > 0 ? ` (${fmtPct(overdue / d.total, 0)})` : ''}
              </span>
            )}
          </div>

          <BucketStrip buckets={d.buckets} currency={cur} />
          <BucketTiles buckets={d.buckets} total={d.total} currency={cur} doc={text.doc} isMobile={isMobile} />

          <div style={{ overflowX: 'auto', marginTop: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
                  <th style={{ padding: '8px 8px', textAlign: 'left', fontWeight: 600 }}>{text.who[0].toUpperCase() + text.who.slice(1)}</th>
                  {bucketCols.map(k => (k === 'd90plus'
                    ? <SortHead key={k} label={shortOf(k)} by="d90plus" sort={sort} onSort={onSort} style={{ ...cell, fontWeight: 600 }} />
                    : <th key={k} style={{ ...cell, fontWeight: 600 }}>{shortOf(k)}</th>))}
                  <SortHead label="Total" by="total" sort={sort} onSort={onSort} style={{ ...cell, fontWeight: 600 }} />
                </tr>
              </thead>
              <tbody>
                {contacts.map(c => {
                  const k = keyOf(c);
                  const open = openKey === k;
                  const toggle = () => setOpenKey(open ? null : k);
                  return (
                    <Fragment key={k}>
                      <tr onClick={toggle} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer',
                                                    background: open ? 'var(--bg-secondary)' : undefined }}>
                        <td style={{ padding: '8px 8px', maxWidth: isMobile ? 150 : 300 }}>
                          <button type="button" aria-expanded={open} onClick={e => { e.stopPropagation(); toggle(); }}
                                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit',
                                           textAlign: 'left', display: 'flex', gap: 6, alignItems: 'baseline', width: '100%', minWidth: 0 }}>
                            <span aria-hidden="true" style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>{open ? '▼' : '▶'}</span>
                            <span style={{ minWidth: 0 }}>
                              <span style={{ fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                              <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                                {plural(c.count, text.doc)}
                                {c.credits > 0 && ` · ${plural(c.credits, 'credit note')}`}
                                {c.oldestDue && !isMobile && ` · oldest due ${dayLabel(c.oldestDue)}`}
                                {c.foreign && ' · foreign currency'}
                              </span>
                            </span>
                          </button>
                        </td>
                        {bucketCols.map(b => <td key={b} style={cell}>{money(c.buckets[b])}</td>)}
                        <td style={{ ...cell, fontWeight: 700 }}>{money(c.total)}</td>
                      </tr>
                      {open && (
                        <tr style={{ background: 'var(--bg-secondary)' }}>
                          <td colSpan={bucketCols.length + 2} style={{ padding: '0 8px' }}>
                            <ContactDocs contact={c} currency={cur} isMobile={isMobile} limit={d.limits?.invoicesPerContact} shortOf={shortOf} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {d.others && (
                  <tr style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                    <td style={{ padding: '8px 8px 8px 23px', fontStyle: 'italic' }}>
                      {plural(d.others.contactCount, `other ${text.who}`)}
                      <div style={{ fontSize: 10.5, fontStyle: 'normal' }}>{plural(d.others.count, text.doc)}</div>
                    </td>
                    {bucketCols.map(b => <td key={b} style={cell}>{money(d.others.buckets[b])}</td>)}
                    <td style={{ ...cell, fontWeight: 700 }}>{money(d.others.total)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {d && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
          {(d.notes || []).map((n, i) => (
            <div key={i} style={{ color: /could not be read|may be missing/.test(n) ? 'var(--warning)' : undefined }}>{n}</div>
          ))}
          <div>
            To compare in Xero: {text.report} Summary report, aged by due date, as at {dayLabel(d.asOf) || 'today'}.
          </div>
        </div>
      )}
    </section>
  );
}
