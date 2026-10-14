import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import RetryAlert from '../../components/RetryAlert';
import { fmtCell } from '../../utils/format';
import { BudgetExport } from './BudgetExport';
import {
  bandsOf, columnShade, columnsOf, currentFootnote, fillOptions, gridRows, monthlyQueryFor, monthlySearch,
  readMonthlyPrefs, spanKey, spanOptions, toneColour,
} from './cash-monthly';

// The Monthly sub-tab of the Cash Flow Manager: the months before this one as
// they happened, this one, and the months ahead as the forecast expects them,
// each opening where the one before closed (main/xero/cash-monthly.js).
//
// It asks for its own figures, for the organisation the Cash Flow Manager is
// on, and asks again whenever the Cash Flow Manager's own figures are read
// from Xero again (`refreshedAt`, that payload's fetchedAt): a Refresh there,
// or a change seen in Xero, reaches this view too. The span and the fill are
// remembered between visits.

const PREFS_KEY = 'cashMonthlyPrefs';

// Storage can be missing or refuse a write (a private window, a full quota);
// the view works without it, from the defaults.
function loadPrefs() {
  try { return readMonthlyPrefs(window.localStorage.getItem(PREFS_KEY)); } catch { return readMonthlyPrefs(null); }
}
function storePrefs(prefs) {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* kept for this visit only */ }
}

export default function CashMonthly({ tenantId, refreshedAt, currency }) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  // Counted, so a slow answer for the span before cannot land over the one
  // asked for after it.
  const seq = useRef(0);
  const seen = useRef(refreshedAt);
  const query = monthlyQueryFor({ tenantId, ...prefs });

  function load({ force = false } = {}) {
    if (!tenantId) return;
    const n = ++seq.current;
    setState(s => ({ ...s, status: 'loading', error: '' }));
    api.get(`/cash-manager/monthly?${monthlySearch(query, { force })}`)
      .then(d => { if (n === seq.current) setState({ status: 'done', data: d, error: '' }); })
      .catch(err => {
        if (n === seq.current) setState(s => ({ status: 'done', data: s.data, error: err.message || 'Could not load the monthly forecast' }));
      });
  }

  useEffect(() => { load(); }, [tenantId, prefs.past, prefs.future, prefs.fill]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Cash Flow Manager read Xero again: so does this, past the caches, as
  // its Refresh asked for. Its first figures landing after this view opened
  // are not that: the load above read the same ones.
  useEffect(() => {
    if (seen.current === refreshedAt) return;
    const before = seen.current;
    seen.current = refreshedAt;
    if (before !== null && before !== undefined) load({ force: true });
  }, [refreshedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  function setPref(patch) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    storePrefs(next);
  }

  const d = state.data;
  const cur = d?.organisation?.currency || currency;
  const cols = d ? columnsOf(d) : [];
  const bands = d ? bandsOf(d) : [];
  const rows = d ? gridRows(d) : [];
  const footnote = d ? currentFootnote(d) : '';
  const sel = { width: 'auto', fontSize: 12, padding: '5px 8px' };

  // The row labels stay put while the months scroll under them on a phone.
  const labelCell = extra => ({
    position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-card)',
    textAlign: 'left', padding: '6px 12px 6px 0', whiteSpace: 'nowrap', ...extra,
  });
  const figure = (kind, extra) => ({
    textAlign: 'right', padding: '6px 10px', whiteSpace: 'nowrap', background: columnShade(kind), ...extra,
  });

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <select className="form-input" style={sel} aria-label="Months shown" value={spanKey(prefs.past, prefs.future)}
                  onChange={e => { const o = spanOptions().find(x => x.key === e.target.value); if (o) setPref({ past: o.past, future: o.future }); }}>
            {spanOptions().map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            Fill future from
            <select className="form-input" style={sel} value={prefs.fill} onChange={e => setPref({ fill: e.target.value })}>
              {fillOptions().map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
          {state.status === 'loading' && d && <span className="btn-spinner" aria-label="Loading" />}
        </div>
        <BudgetExport kind="cashmonthly" query={query} disabled={!d || state.status === 'loading'} />
      </div>

      {state.status === 'loading' && !d && <div style={{ padding: 28, color: 'var(--text-muted)', fontSize: 13 }}>Loading the monthly forecast…</div>}

      {state.error && (
        <RetryAlert message={state.error} onRetry={() => load({ force: true })} busy={state.status === 'loading'} style={{ marginBottom: 12 }} />
      )}

      {d && (
        <>
          <div className="mobile-scroll-x" style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
              <thead>
                <tr>
                  <th style={labelCell({ padding: '2px 12px 2px 0', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)' })}>
                    {cur ? `Figures in ${cur}` : ''}
                  </th>
                  {bands.map((b, i) => (
                    <th key={`${b.kind}-${i}`} colSpan={b.span} style={{
                      padding: '2px 8px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                      color: b.kind === 'actual' ? 'var(--text-muted)' : b.kind === 'current' ? 'var(--warning)' : 'var(--accent)',
                      background: columnShade(b.kind),
                    }}>{b.kind === 'current' ? 'A+F' : b.label}</th>
                  ))}
                </tr>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={labelCell({ fontSize: 11, color: 'var(--text-muted)' })} />
                  {cols.map(c => (
                    <th key={c.key} title={c.current ? footnote : c.kindLabel} style={figure(c.kind, { fontSize: 11, fontWeight: 700, lineHeight: 1.2 })}>
                      <div>{c.month}</div>
                      <div style={{ fontSize: 9.5, fontWeight: 500, color: 'var(--text-muted)' }}>{c.year}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (r.type === 'heading' ? (
                  <tr key={r.key}>
                    <td style={labelCell({ paddingTop: 12, fontSize: 11, fontWeight: 700, color: 'var(--accent)' })}>{r.label}</td>
                    {cols.map(c => <td key={c.key} style={figure(c.kind)} />)}
                  </tr>
                ) : (
                  <tr key={r.key} style={{
                    borderTop: r.strong || r.info ? '1px solid var(--border)' : undefined,
                    color: r.info ? 'var(--text-muted)' : undefined,
                    fontStyle: r.info ? 'italic' : undefined,
                  }}>
                    <td style={labelCell({ fontWeight: r.strong ? 700 : 400, paddingLeft: r.indent ? 12 : 0 })}>{r.label}</td>
                    {r.cells.map(cell => (
                      <td key={cell.key} title={cell.title || undefined} style={figure(cell.kind, {
                        fontWeight: r.strong ? 700 : 400, color: toneColour(cell.tone), cursor: cell.title ? 'help' : undefined,
                      })}>
                        {cell.value === null ? '' : fmtCell(cell.value)}
                      </td>
                    ))}
                  </tr>
                )))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.6 }}>
            {footnote && <div>{footnote}</div>}
            {d.overdraft > 0 && <div>Closing balances below the overdraft limit of {fmtCell(d.overdraft)} are red; below zero within it, orange.</div>}
            <div>Hover over a figure to see what it was made of.</div>
            {(d.notes || []).map((note, i) => <div key={i}>{note}</div>)}
          </div>
        </>
      )}
    </div>
  );
}
