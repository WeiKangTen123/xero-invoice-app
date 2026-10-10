import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { fmtCell } from '../../utils/format';
import { BudgetExport } from './BudgetExport';
import { XeroCheckPanel } from './XeroCheckPanel';
import { SourceNote, lastLoaded } from './bits';
import { balanceHowTo } from './xero-check';
import {
  basisOptions, captionFor, clampPeriods, columnLabels, compareOptions, datePresets, errorNotice, hiddenRowCount,
  monthLabel, monthOptions, sheetRows,
} from './balance';

// The Balance Sheet: assets, liabilities and equity as at a date, with up to
// eleven earlier dates beside it, as Xero's own report lays them out. The
// page owns the report and the controls that shape the request (the date,
// the comparison, the basis — see XeroInsights.jsx#fetchBalance); this lays
// them out and keeps only what changes nothing Xero is asked for: whether
// account codes and zero-balance rows are shown, and whether the check
// against Xero is open.
//
// The table scrolls sideways inside its own container with the account
// column pinned, as the budget grid does: twelve columns of balances do not
// fit a phone, and scrolling to the oldest must not lose the row's name.

// How each kind of line (balance.js#sheetRows) is set: the indent of its
// label, its weight, and the rule above it. Totals carry a rule as they do
// in Xero, net assets a heavier one, so the sheet reads in blocks.
const LINE = {
  section:  { label: { padding: '14px 12px 4px 0', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em' } },
  heading:  { label: { padding: '8px 12px 2px 12px', fontWeight: 600, color: 'var(--text-secondary)' } },
  account:  { label: { paddingLeft: 24 }, weight: 400 },
  subtotal: { label: { paddingLeft: 12 }, weight: 700, rule: '1px solid var(--border)' },
  total:    { label: { paddingLeft: 0 },  weight: 700, rule: '1px solid var(--border)' },
  net:      { label: { paddingLeft: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }, weight: 800, rule: '2px solid var(--border)' },
};

export default function BalanceSheetTab({ balance, controls, onControls, fetchBalance, currency, orgName, exportQuery }) {
  // The check against Xero opens on request only — it reads Xero again — and
  // is keyed on the query, so a change of date checks the new sheet.
  const [checking, setChecking] = useState(false);
  const [codes,    setCodes]    = useState(false);
  const [zeroRows, setZeroRows] = useState(false);
  const [more,     setMore]     = useState(false);
  // Asked only after a 403, to tell a scope the connection has yet to be
  // given (a reconnect adds it) from one Xero refused the app outright (it
  // does not). Nothing is asked otherwise: the banner already polls it.
  const [connection, setConnection] = useState(null);
  useEffect(() => {
    if (balance.errorStatus !== 403) return undefined;
    let alive = true;
    api.get('/xero/connection')
      .then(c => { if (alive) setConnection(c); })
      .catch(() => { /* the server's own message stands */ });
    return () => { alive = false; };
  }, [balance.errorStatus, balance.error]);

  const ready  = balance.status === 'done' && !balance.error;
  const d      = balance.data;
  const months = monthOptions(new Date());

  // A control changed. "Month end…" needs a month before anything can be
  // asked, so the latest one is chosen for it; the count is kept in range.
  function change(patch) {
    const next = { ...controls, ...patch };
    if (next.preset === 'month' && !next.month) next.month = months[0];
    next.periods = clampPeriods(next.periods);
    onControls(next);
  }

  const sel = { width: 'auto', fontSize: 12, padding: '5px 8px' };
  const lbl = { fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' };
  const field = (label, control) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={lbl}>{label}</span>{control}
    </label>
  );
  const tick = (label, checked, onChange) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /> {label}
    </label>
  );

  const subtitle = [d?.organisation?.name || orgName, lastLoaded(captionFor(d), !!balance.error && !!d)].filter(Boolean).join(' · ');

  return (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>Balance Sheet</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>
                {subtitle || 'Assets, liabilities and equity as at a date'}
              </div>
              <SourceNote>Xero Balance Sheet report</SourceNote>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-outline btn-sm" disabled={!ready} aria-expanded={checking} onClick={() => setChecking(c => !c)}>
                ✓ Check against Xero
              </button>
              <BudgetExport kind="balance" query={exportQuery} disabled={!ready} />
              <button className="btn btn-outline btn-sm" disabled={balance.status === 'loading'} onClick={() => fetchBalance({ force: true })}>
                {balance.status === 'loading' ? <span className="btn-spinner" /> : '↻'} Refresh
              </button>
            </div>
          </div>

          {checking && ready && (
            <XeroCheckPanel key={JSON.stringify(exportQuery)} query={exportQuery} endpoint="balance-check" howTo={balanceHowTo}
                            onClose={() => setChecking(false)} />
          )}

          {/* The controls stay up through a load and after a failure, so
              another date can always be picked. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '14px 0 4px' }}>
            {field('Date', (
              <select className="form-input" style={sel} value={controls.preset} onChange={e => change({ preset: e.target.value })}>
                {datePresets().map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            ))}
            {controls.preset === 'month' && (
              <select className="form-input" style={sel} aria-label="Month end" value={controls.month}
                      onChange={e => change({ month: e.target.value })}>
                {/* A month from another session's list is kept so the select
                    never shows a blank; it was a month end once. */}
                {controls.month && !months.includes(controls.month) && <option value={controls.month}>{monthLabel(controls.month)}</option>}
                {months.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
              </select>
            )}
            {field('Compare with', (
              <select className="form-input" style={sel} value={controls.compare} onChange={e => change({ compare: e.target.value })}>
                {compareOptions().map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            ))}
            {controls.compare !== 'none' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                <select className="form-input" style={sel} aria-label="How many periods" value={controls.periods}
                        onChange={e => change({ periods: e.target.value })}>
                  {Array.from({ length: 11 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                {controls.periods === 1 ? 'period' : 'periods'}
              </span>
            )}
            {field('Basis', (
              <select className="form-input" style={sel} value={controls.basis} onChange={e => change({ basis: e.target.value })}>
                {basisOptions().map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
            ))}
            <button type="button" className="btn btn-outline btn-sm" aria-expanded={more} onClick={() => setMore(m => !m)}>
              More {more ? '▴' : '▾'}
            </button>
            {more && tick('Show account codes', codes, setCodes)}
            {more && tick('Show zero-balance rows', zeroRows, setZeroRows)}
          </div>

          {balance.status === 'loading' && <div style={{ padding: 28, color: 'var(--text-muted)', fontSize: 13 }}>Loading balance sheet...</div>}

          {balance.error && (() => {
            const notice = errorNotice(balance, connection);
            return (
              <div className="alert alert-error" style={{ marginTop: 14 }}>
                <span className="alert-icon">✕</span>
                <span>
                  {notice.text}
                  {notice.reconnect && <> <Link to="/setup" style={{ fontWeight: 600, color: 'inherit' }}>Open Setup</Link></>}
                </span>
              </div>
            );
          })()}

          {ready && d && (() => {
            const cur    = d.organisation?.currency || currency;
            const labels = columnLabels(d);
            const rows   = sheetRows(d, { zeroRows });
            const hidden = zeroRows ? 0 : hiddenRowCount(d);
            // The first column of a sheet for the month in progress is set
            // apart as the budget grid's "so far" column is: amber, since it
            // is not a month end's figure.
            const soFar  = !!d.asAt?.inProgress;
            const labelCell = (extra = {}) => ({
              position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-card)',
              textAlign: 'left', padding: '6px 12px 6px 0', whiteSpace: 'nowrap', ...extra,
            });
            const numCell = (i, extra = {}) => ({
              padding: '6px 10px', textAlign: 'right', whiteSpace: 'nowrap',
              ...(soFar && i === 0 ? { background: 'var(--warning-subtle)' } : {}), ...extra,
            });
            return (
              <>
                <div style={{ overflowX: 'auto', marginTop: 10 }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={labelCell({ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' })}>
                          {cur ? `Figures in ${cur}` : 'Account'}
                        </th>
                        {labels.map((l, i) => (
                          <th key={i} style={numCell(i, { fontSize: 11, fontWeight: i === 0 ? 700 : 600,
                                                          color: soFar && i === 0 ? 'var(--warning)' : i === 0 ? 'var(--text-secondary)' : 'var(--text-muted)' })}>
                            {l}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 && (
                        <tr><td colSpan={labels.length + 1} style={{ padding: '18px 0', color: 'var(--text-muted)' }}>Xero returned no balances for this date.</td></tr>
                      )}
                      {rows.map((r, idx) => {
                        const line = LINE[r.kind] || LINE.account;
                        if (r.kind === 'section' || r.kind === 'heading') return (
                          <tr key={idx}><td colSpan={labels.length + 1} style={{ fontSize: 12, ...line.label }}>{r.label}</td></tr>
                        );
                        const rule = line.rule ? { borderTop: line.rule } : {};
                        return (
                          <tr key={idx}>
                            <td style={labelCell({ fontWeight: line.weight, ...line.label, ...rule })}>
                              {codes && r.code && <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{r.code}</span>}
                              {r.label}
                            </td>
                            {labels.map((_, i) => {
                              const v = r.values[i];
                              return (
                                <td key={i} style={numCell(i, { fontWeight: line.weight, color: v < 0 ? 'var(--danger)' : undefined, ...rule })}>
                                  {fmtCell(v)}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.6 }}>
                  Figures in {cur || 'the organisation\'s currency'}, as Xero holds them. Balances are as at each month end.
                  &ldquo;This month so far&rdquo; includes everything dated in the month.
                  {hidden > 0 && (
                    <>
                      {' '}{hidden} zero-balance row{hidden === 1 ? '' : 's'} hidden &mdash;{' '}
                      <button type="button" onClick={() => { setZeroRows(true); setMore(true); }}
                              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }}>
                        show them
                      </button>.
                    </>
                  )}
                  {(d.notes || []).map((note, i) => <div key={i}>{note}</div>)}
                </div>
              </>
            );
          })()}
        </div>
  );
}
