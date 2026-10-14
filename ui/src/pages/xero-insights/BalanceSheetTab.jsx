import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { BudgetExport } from './BudgetExport';
import { XeroCheckPanel } from './XeroCheckPanel';
import { SourceNote, lastLoaded } from './bits';
import { balanceHowTo } from './xero-check';
import {
  EARLIEST_DATE, basisOptions, canShowChange, captionFor, cellValue, clampPeriods, compareOptions, datePresets, displayColumns,
  drillTarget, errorNotice, exactDatesState, figureText, fromTrialBalance, hiddenRowCount, isExactPreset, maxPeriods,
  monthLabel, monthOptions, pctText, sheetRows, sourceLabel, sourceNote, todayISO, viewQuery,
} from './balance';

// The Balance Sheet: assets, liabilities and equity as at a date, with up to
// eleven earlier dates beside it, as Xero's own report lays them out — or, for
// today or a day of the reader's choosing, as built from Xero's Trial Balance
// once that has been shown to agree with the report (balance.js
// #exactDatesState). The page owns the report and the controls that shape the
// request (the date, the comparison, the basis — see
// XeroInsights.jsx#fetchBalance); this lays them out and keeps only what
// changes nothing Xero is asked for: whether account codes, zero-balance
// rows, decimals and the Change and % columns are shown, and whether the
// check against Xero is open. The export is told those too, so the file is
// laid out as the screen is.
//
// The table scrolls sideways inside its own container with the account
// column pinned, as the budget grid does: twelve columns of balances do not
// fit a phone, and scrolling to the oldest must not lose the row's name.
//
// A bank account's line opens its statement on the Banking tab, and the
// receivables and payables lines their ageing (onOpenBankAccount,
// onOpenAgeing), which is where the reader goes next to see what makes up
// the figure.

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

const LINK = {
  background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 'inherit', color: 'var(--accent)',
  cursor: 'pointer', textAlign: 'left', textDecoration: 'underline', textDecorationColor: 'var(--border)', textUnderlineOffset: 3,
};

export default function BalanceSheetTab({
  balance, controls, onControls, fetchBalance, currency, orgName, exportQuery, onOpenBankAccount, onOpenAgeing,
}) {
  // The check against Xero opens on request only — it reads Xero again — and
  // is keyed on the query, so a change of date checks the new sheet.
  const [checking, setChecking] = useState(false);
  const [codes,    setCodes]    = useState(false);
  const [zeroRows, setZeroRows] = useState(false);
  // Two places by default, as Xero prints the report.
  const [decimals, setDecimals] = useState(true);
  const [changeCols, setChangeCols] = useState(false);
  const [more,     setMore]     = useState(false);
  // Asked only after a 403, to tell a scope the connection has yet to be
  // given (a reconnect adds it) from one left unticked in Setup (ticking it
  // there does) and from one Xero refused the app outright (nothing does) —
  // see balance.js#balanceOffMessage. Nothing is asked otherwise: the banner
  // already polls it.
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
  const today  = todayISO(new Date());
  const cur    = d?.organisation?.currency || currency;
  // Whether exact dates can be offered, from the last sheet loaded: every
  // payload carries the gate's outcome.
  const exact   = exactDatesState(d?.exactDates, cur);
  const isExact = isExactPreset(controls.preset);
  // Change and % need two columns to set side by side.
  const changeAvailable = canShowChange(d);
  const showChange      = changeCols && changeAvailable;
  const fileQuery = { ...exportQuery, ...viewQuery({ codes, zeroRows, decimals, change: showChange }) };

  // A control changed. "Month end…" needs a month before anything can be
  // asked, so the latest one is chosen for it, and "Exact date…" a day, so
  // the sheet's own date is (or today, before there is one); the count is
  // kept in range for the kind of date. A date picked by the reader is
  // theirs: the page no longer moves it to today or back.
  function change(patch) {
    const next = { ...controls, ...patch };
    if ('preset' in patch || 'month' in patch || 'date' in patch) next.chosen = true;
    if (next.preset === 'month' && !next.month) next.month = months[0];
    if (next.preset === 'date' && !next.date) next.date = d?.asAt?.iso && d.asAt.iso <= today ? d.asAt.iso : today;
    next.periods = clampPeriods(next.periods, { max: maxPeriods(next.preset) });
    onControls(next);
  }

  const sel = { width: 'auto', fontSize: 12, padding: '5px 8px' };
  const lbl = { fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' };
  const field = (label, control) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={lbl}>{label}</span>{control}
    </label>
  );
  const tick = (label, checked, onChange, { disabled = false, title } = {}) => (
    <label title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /> {label}
    </label>
  );

  const subtitle = [d?.organisation?.name || orgName, lastLoaded(captionFor(d), !!balance.error && !!d)].filter(Boolean).join(' · ');

  // Where a line leads, followed.
  function follow(target) {
    if (target.kind === 'bank') onOpenBankAccount?.(target.accountId, target.name);
    else onOpenAgeing?.(target.side);
  }

  return (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>Balance Sheet</div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>
                {subtitle || 'Assets, liabilities and equity as at a date'}
              </div>
              <SourceNote>{sourceLabel(d)}</SourceNote>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-outline btn-sm" disabled={!ready} aria-expanded={checking} onClick={() => setChecking(c => !c)}>
                ✓ Check against Xero
              </button>
              <BudgetExport kind="balance" query={fileQuery} disabled={!ready} />
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
                {datePresets(exact, controls.preset).map(p => <option key={p.key} value={p.key} disabled={p.disabled}>{p.label}</option>)}
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
            {/* A day from 1990 to today; an emptied input asks for nothing. */}
            {controls.preset === 'date' && (
              <input type="date" className="form-input" style={sel} aria-label="Exact date" value={controls.date || ''}
                     min={EARLIEST_DATE} max={today}
                     onChange={e => { if (e.target.value && e.target.value >= EARLIEST_DATE && e.target.value <= today) change({ date: e.target.value }); }} />
            )}
            {field('Compare with', (
              <select className="form-input" style={sel} value={controls.compare} onChange={e => change({ compare: e.target.value })}>
                {compareOptions(isExact).map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            ))}
            {controls.compare !== 'none' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                <select className="form-input" style={sel} aria-label="How many periods" value={clampPeriods(controls.periods, { max: maxPeriods(controls.preset) })}
                        onChange={e => change({ periods: e.target.value })}>
                  {Array.from({ length: maxPeriods(controls.preset) }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
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
            {more && tick('Decimals', decimals, setDecimals, { title: 'Off: figures rounded to whole units' })}
            {more && tick('Change & %', changeCols, setChangeCols, {
              disabled: !changeAvailable,
              title: changeAvailable ? 'The first column less the second, and as a percentage of the second' : 'Needs a comparison column: pick one under Compare with',
            })}
          </div>

          {/* Why "Today" and "Exact date…" cannot be picked, when they cannot. */}
          {exact.known && !exact.available && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '2px 0 4px', lineHeight: 1.5 }}>
              {exact.note}
              {exact.reconnect && <> <Link to="/setup" style={{ fontWeight: 600, color: 'var(--accent)' }}>Open Setup</Link></>}
            </div>
          )}

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
            const cols   = displayColumns(d, { change: showChange });
            const rows   = sheetRows(d, { zeroRows });
            const hidden = zeroRows ? 0 : hiddenRowCount(d);
            // The first column of a sheet for the month in progress, or for
            // today, is set apart as the budget grid's "so far" column is:
            // amber, since it is not a closed day's figure.
            const soFar  = !!d.asAt?.inProgress;
            const live   = c => soFar && c.kind === 'value' && c.index === 0;
            const labelCell = (extra = {}) => ({
              position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-card)',
              textAlign: 'left', padding: '6px 12px 6px 0', whiteSpace: 'nowrap', ...extra,
            });
            const numCell = (c, extra = {}) => ({
              padding: '6px 10px', textAlign: 'right', whiteSpace: 'nowrap',
              ...(live(c) ? { background: 'var(--warning-subtle)' } : {}), ...extra,
            });
            const note = sourceNote(d);
            return (
              <>
                <div style={{ overflowX: 'auto', marginTop: 10 }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={labelCell({ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' })}>
                          {cur ? `Figures in ${cur}` : 'Account'}
                        </th>
                        {cols.map((c, i) => {
                          const first = c.kind === 'value' && c.index === 0;
                          return (
                            <th key={i} style={numCell(c, { fontSize: 11, fontWeight: first ? 700 : 600,
                                                            color: live(c) ? 'var(--warning)' : first ? 'var(--text-secondary)' : 'var(--text-muted)' })}>
                              {c.label}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 && (
                        <tr><td colSpan={cols.length + 1} style={{ padding: '18px 0', color: 'var(--text-muted)' }}>Xero returned no balances for this date.</td></tr>
                      )}
                      {rows.map((r, idx) => {
                        const line = LINE[r.kind] || LINE.account;
                        if (r.kind === 'section' || r.kind === 'heading') return (
                          <tr key={idx}><td colSpan={cols.length + 1} style={{ fontSize: 12, ...line.label }}>{r.label}</td></tr>
                        );
                        const rule   = line.rule ? { borderTop: line.rule } : {};
                        const target = drillTarget(r);
                        return (
                          <tr key={idx}>
                            <td style={labelCell({ fontWeight: line.weight, ...line.label, ...rule })}>
                              {codes && r.code && <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{r.code}</span>}
                              {target
                                ? <button type="button" style={LINK} title={target.title} onClick={() => follow(target)}>{r.label}</button>
                                : r.label}
                            </td>
                            {cols.map((c, i) => {
                              const v = cellValue(r, c);
                              return (
                                <td key={i} style={numCell(c, { fontWeight: line.weight, color: v < 0 ? 'var(--danger)' : undefined, ...rule })}>
                                  {c.kind === 'pct' ? pctText(v) : figureText(v, decimals)}
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
                  {fromTrialBalance(d) ? (
                    <>Figures in {cur || 'the organisation\'s currency'}. {note}</>
                  ) : (
                    <>
                      Figures in {cur || 'the organisation\'s currency'}, as Xero holds them. Balances are as at each month end.
                      &ldquo;This month so far&rdquo; includes everything dated in the month.
                    </>
                  )}
                  {!decimals && ' Rounded to whole units: each total is rounded from its exact figure, so it can be a unit off the sum of the rounded lines above it.'}
                  {showChange && ' Change is the first column less the second; % is that change over the second column, and “—” where that is nil.'}
                  {hidden > 0 && (
                    <>
                      {' '}{hidden} zero-balance row{hidden === 1 ? '' : 's'} hidden &mdash;{' '}
                      <button type="button" onClick={() => { setZeroRows(true); setMore(true); }}
                              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }}>
                        show them
                      </button>.
                    </>
                  )}
                  {(d.notes || []).map((n, i) => <div key={i}>{n}</div>)}
                </div>
              </>
            );
          })()}
        </div>
  );
}
