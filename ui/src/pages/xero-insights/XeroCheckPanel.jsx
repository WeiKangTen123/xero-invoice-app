import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { fmtCell } from '../../utils/format';
import { checkSummary, checkedTime, findings, lineTitle, xeroHowTo } from './xero-check';

// The "Check against Xero" panel under either budget tab.
//
// The grid is built from two reports whose columns are matched by position
// off opposite anchors, so nothing on the grid itself can show a reader that
// a month did not slide. The server asks Xero three other ways — calls with
// no comparison periods, where there is no order to get wrong — and this
// shows the verdict: one green line when every line agrees, or the lines that
// do not, each with the app's figure beside Xero's. Under it, how to see the
// same figures in Xero, since that is the proof a reader can repeat.
//
// `query` is the organisation and period on screen, as the exports take it,
// so what is checked is the report being looked at. The tab keys the panel on
// it, so a new period is a new panel and a new check.
export function XeroCheckPanel({ query, onClose }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  // Counted so a "Check again" clicked while the first is still out cannot
  // let the older answer land last.
  const seq = useRef(0);

  function ask(force) {
    const n = ++seq.current;
    setState(s => ({ ...s, status: 'loading', error: '' }));
    const params = new URLSearchParams(query || {});
    if (force) params.set('force', 'true');
    api.get(`/xero-reports/budget-check?${params.toString()}`)
      .then(d => { if (n === seq.current) setState({ status: 'done', data: d, error: '' }); })
      // The last verdict is not kept under an error: a stale "agrees" over a
      // failed check is the false reassurance this panel exists to avoid.
      .catch(err => { if (n === seq.current) setState({ status: 'done', data: null, error: err.message || 'Could not check against Xero' }); });
  }
  useEffect(() => { ask(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const d    = state.data;
  const time = d ? checkedTime(d.checkedAt) : '';
  const num  = { textAlign: 'right', padding: '5px 10px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
  const th   = { fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' };

  return (
    <div style={{ marginTop: 14, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Check against Xero</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
            The grid asked for again without comparison periods, line by line. Read-only; up to three Xero calls.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" disabled={state.status === 'loading'} onClick={() => ask(true)}>
            {state.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Check again
          </button>
          <button className="btn btn-outline btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>

      {state.status === 'loading' && <div style={{ padding: '12px 0 4px', color: 'var(--text-muted)', fontSize: 13 }}>Asking Xero…</div>}
      {state.error && <div className="alert alert-error" style={{ marginTop: 10 }}><span className="alert-icon">✕</span>{state.error}</div>}

      {state.status === 'done' && !state.error && d && (
        <>
          <div className={`alert ${d.ok ? 'alert-success' : 'alert-warning'}`} style={{ marginTop: 10 }}>
            <span className="alert-icon">{d.ok ? '✓' : '⚠'}</span>
            <span>{checkSummary(d, time)}{d.cached ? ' · from the last check' : ''}</span>
          </div>

          {findings(d).map(c => (
            <div key={c.key} style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>{c.label}</div>
              {c.differences.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: '100%' }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, textAlign: 'left', padding: '4px 10px 4px 0' }}>Line</th>
                        <th style={{ ...th, ...num }}>App</th>
                        <th style={{ ...th, ...num }}>Xero</th>
                        <th style={{ ...th, ...num }}>Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.differences.map((x, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '5px 10px 5px 0' }}>{lineTitle(x)}</td>
                          <td style={num}>{fmtCell(x.app)}</td>
                          <td style={num}>{fmtCell(x.xero)}</td>
                          <td style={{ ...num, color: 'var(--danger)', fontWeight: 700 }}>{fmtCell(x.diff)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {c.onlyInXero.length > 0 && (
                <div style={{ fontSize: 12, marginTop: 6 }}><span style={{ color: 'var(--text-muted)' }}>Only in Xero:</span> {c.onlyInXero.join(', ')}</div>
              )}
              {c.onlyInApp.length > 0 && (
                <div style={{ fontSize: 12, marginTop: 6 }}><span style={{ color: 'var(--text-muted)' }}>Only in the app:</span> {c.onlyInApp.join(', ')}</div>
              )}
            </div>
          ))}
          {d.currency && findings(d).some(c => c.differences.length) && (
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>Figures in {d.currency}. Difference is the app&apos;s figure less Xero&apos;s.</div>
          )}

          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>What this checked</div>
            {(d.notes || []).map((note, i) => <div key={i}>{note}</div>)}
          </div>

          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>How to see the same figures in Xero</div>
            {xeroHowTo(d).map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </>
      )}
    </div>
  );
}
