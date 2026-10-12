import { useEffect, useRef, useState } from 'react';
import { fmtCell } from '../../utils/format';
import {
  axisTicks, balanceColour, basisHint, basisLabel, calendarMonths, chartBars, compactAmount, contactOf,
  currencySymbol, daySummary, itemTitle, signColour, tableRows, weekdayLabels,
} from './cash-manager';

// The Cash Flow Manager's three ways of showing the window — a chart, a
// table and a calendar — and the panel that lists a day's items when one is
// clicked. What each draws is decided in cash-manager.js; this lays it out.
//
// The chart is inline SVG like the rest of the dashboard, drawn at the width
// it is given rather than scaled from a fixed one: scaled, its labels shrank
// to a few pixels on a phone, and ninety days of bars cannot be read by
// scrolling sideways the way a table can.

// The width of the element a ref is put on, kept current as it resizes.
function useWidth(fallback) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => { const w = Math.round(el.clientWidth); if (w > 0) setWidth(w); };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// A bar standing on the baseline with only its far end rounded, so every bar
// reads from the same line whichever way it points.
function barPath(x, w, base, end) {
  const h = Math.abs(end - base);
  if (h < 0.5) return '';
  const r = Math.min(3, w / 2, h);
  const k = end < base ? 1 : -1;
  return `M${x},${base}V${end + k * r}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end + k * r}V${base}Z`;
}

// Where a value's bar ends. A small amount against a large scale still gets a
// sliver, so a day with something on it never looks empty.
function barEnd(y, v) {
  const base = y(0), end = y(v);
  if (Math.round(v * 100) !== 0 && Math.abs(end - base) < 1.5) return base + (v > 0 ? -1.5 : 1.5);
  return end;
}

const LEGEND = {
  inout:   [['var(--success)', 'Cash in'], ['var(--danger)', 'Cash out']],
  net:     [['var(--success)', 'More in than out'], ['var(--danger)', 'More out than in']],
  balance: [['var(--success)', 'Above zero'], ['var(--warning)', 'Within the overdraft limit'], ['var(--danger)', 'Overdrawn past the limit']],
};

export function ChartLegend({ mode, overdraft }) {
  const keys = LEGEND[mode] || LEGEND.inout;
  // Without a limit there is no "within the limit": below zero is overdrawn.
  const shown = mode === 'balance' && !(overdraft > 0)
    ? [keys[0], ['var(--danger)', 'Below zero']]
    : keys;
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-secondary)' }}>
      {shown.map(([colour, label]) => (
        <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: colour, display: 'inline-block' }} />
          {label}
        </span>
      ))}
    </div>
  );
}

// The hover card: the day, its figures and its first few items.
function Tooltip({ summary, x, width }) {
  const W = 230;
  const left = Math.max(0, Math.min(x - W / 2, width - W));
  const row = (label, value, colour) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: colour }}>{value}</span>
    </div>
  );
  return (
    <div aria-hidden="true" style={{
      position: 'absolute', top: 4, left, width: W, zIndex: 3, pointerEvents: 'none',
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
      boxShadow: 'var(--shadow-md)', padding: '9px 11px', fontSize: 11.5, fontVariantNumeric: 'tabular-nums',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 5, color: 'var(--text-primary)' }}>{summary.title}</div>
      {row('Cash in', fmtCell(summary.in))}
      {row('Cash out', fmtCell(summary.out))}
      {row('Net movement', fmtCell(summary.net))}
      {summary.balance !== null && row('Bank balance', fmtCell(summary.balance))}
      {summary.items.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {summary.items.map(item => (
            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                {contactOf(item)}{item.number ? ` · ${item.number}` : ''}
              </span>
              <span style={{ flexShrink: 0 }}>{item.direction === 'out' ? '−' : '+'}{fmtCell(item.amount)}</span>
            </div>
          ))}
          {summary.more > 0 && <div style={{ color: 'var(--text-muted)' }}>and {summary.more} more · click to see all</div>}
        </div>
      )}
      {summary.count === 0 && <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>Nothing expected.</div>}
    </div>
  );
}

// The chart. Bars from today, one slot a day: cash in above zero and cash out
// below it, or a single net bar, with the Overdue pair standing apart left of
// a dashed line at today. Under "Bank balance" it is the projected balance as
// a line, coloured by how far below zero it runs. Hovering a day shows its
// figures; clicking one opens its items under the chart.
export function CashChart({ payload, days, mode, currency, selected, onSelect }) {
  const [boxRef, measured] = useWidth(760);
  const [hover, setHover] = useState(null);
  const W = Math.max(280, measured);
  const H = 260, padL = 50, padR = 10, padT = 20, padB = 26;
  const maxLabels = Math.max(2, Math.floor((W - padL - padR) / 64));
  const c = chartBars(payload, days, mode, { maxLabels });
  const axis = axisTicks(c.min, c.max, { count: 4, symbol: currencySymbol(currency) });
  const plotH = H - padT - padB;
  const y = v => padT + plotH * (1 - (v - axis.min) / ((axis.max - axis.min) || 1));
  const base = y(0);

  const bars = c.mode !== 'balance';
  // The Overdue pair gets a slot wide enough for its label, apart from the
  // days, whatever the window: at ninety days a day's slot is a few pixels.
  const OD_W = bars ? 46 : 0, GAP = bars ? 12 : 0;
  const plotL = padL + OD_W + GAP;
  const n = Math.max(1, c.points.length);
  const slot = (W - padR - plotL) / n;
  const bw = Math.max(1.5, Math.min(18, slot * 0.66));
  const cx = i => plotL + slot * i + slot / 2;
  const odX = padL + OD_W / 2;
  const todayX = bars ? padL + OD_W + GAP / 2 : cx(0);

  const index = new Map(c.points.map((p, i) => [p.date, i]));
  const xOf = date => (date === 'overdue' ? odX : cx(index.get(date) ?? 0));
  const shown = hover !== null && (hover === 'overdue' ? bars : index.has(hover));
  const slotRect = date => (date === 'overdue'
    ? { x: padL, width: OD_W }
    : { x: plotL + slot * (index.get(date) ?? 0), width: slot });

  const bar = (key, xc, v, colour, opacity = 1) => {
    const d = barPath(xc - bw / 2, bw, base, barEnd(y, v));
    return d ? <path key={key} d={d} fill={colour} opacity={opacity} /> : null;
  };

  const drawBars = (p, xc, key, opacity) => (c.mode === 'net'
    ? bar(`${key}n`, xc, p.net, p.net < 0 ? 'var(--danger)' : 'var(--success)', opacity)
    : [bar(`${key}i`, xc, p.in, 'var(--success)', opacity), bar(`${key}o`, xc, -p.out, 'var(--danger)', opacity)]);

  return (
    <div>
      <ChartLegend mode={c.mode} overdraft={c.overdraft} />
      <div ref={boxRef} style={{ position: 'relative', marginTop: 8 }} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', width: '100%', height: H }}
             role="img" aria-label={`${c.mode === 'balance' ? 'Projected bank balance' : c.mode === 'net' ? 'Net movement' : 'Cash in and cash out'} by day`}>
          {/* The hovered and the opened day, behind everything. */}
          {selected && (selected === 'overdue' ? bars : index.has(selected)) && (
            <rect {...slotRect(selected)} y={padT} height={plotH} fill="var(--accent-subtle)" stroke="var(--accent)" strokeWidth="1" rx="3" />
          )}
          {shown && hover !== selected && <rect {...slotRect(hover)} y={padT} height={plotH} fill="var(--bg-hover)" rx="3" />}

          {axis.ticks.map((t, i) => (
            <g key={t}>
              {t !== 0 && <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />}
              <text x={padL - 8} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--text-muted)">{axis.labels[i]}</text>
            </g>
          ))}
          {/* Zero: the bars' baseline, and under the balance line the point
              below which the account is overdrawn — dashed there, since it is
              a threshold rather than something drawn on. */}
          <line x1={padL} x2={W - padR} y1={base} y2={base} stroke="var(--text-muted)" strokeOpacity="0.6" strokeWidth="1"
                strokeDasharray={bars ? undefined : '4 4'} />
          {!bars && c.overdraft > 0 && axis.min <= -c.overdraft && (
            <g>
              <line x1={padL} x2={W - padR} y1={y(-c.overdraft)} y2={y(-c.overdraft)} stroke="var(--danger)" strokeOpacity="0.55" strokeDasharray="3 4" />
              <text x={W - padR} y={y(-c.overdraft) - 4} textAnchor="end" fontSize="9.5" fill="var(--text-muted)">Overdraft limit</text>
            </g>
          )}

          <line x1={todayX} x2={todayX} y1={padT - 4} y2={H - padB} stroke="var(--text-muted)" strokeDasharray="3 3" />
          <text x={todayX + 4} y={padT - 8} fontSize="10" fill="var(--text-muted)">Today</text>

          {bars && c.overdue && (
            <g>
              {drawBars(c.overdue, odX, 'od', 0.85)}
              <text x={odX} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--text-secondary)" fontWeight="600">Overdue</text>
            </g>
          )}

          {bars && c.points.map((p, i) => <g key={p.date}>{drawBars(p, cx(i), p.date, 1)}</g>)}

          {!bars && c.points.length > 1 && c.points.slice(1).map((p, k) => {
            const a = c.points[k];
            return (
              <line key={p.date} x1={cx(k)} y1={y(a.balance)} x2={cx(k + 1)} y2={y(p.balance)}
                    stroke={balanceColour(Math.min(a.balance, p.balance), c.overdraft)} strokeWidth="2" strokeLinecap="round" />
            );
          })}
          {!bars && c.points.length === 1 && (
            <circle cx={cx(0)} cy={y(c.points[0].balance)} r="4" fill={balanceColour(c.points[0].balance, c.overdraft)} />
          )}
          {!bars && shown && (
            <circle cx={cx(index.get(hover))} cy={y(c.points[index.get(hover)].balance)} r="4.5"
                    fill={balanceColour(c.points[index.get(hover)].balance, c.overdraft)} stroke="var(--bg-card)" strokeWidth="2" />
          )}

          {c.points.map((p, i) => {
            if (!p.tick) return null;
            const x = cx(i);
            // The first label starts at its day rather than centring on it,
            // clear of "Overdue"; the last ends at the edge.
            const anchor = i === 0 ? 'start' : x + 18 > W - padR ? 'end' : 'middle';
            const at = i === 0 ? x - Math.min(slot / 2, 6) : anchor === 'end' ? W - padR : x;
            return <text key={p.date} x={at} y={H - 8} textAnchor={anchor} fontSize="10" fill="var(--text-muted)">{p.label}</text>;
          })}

          {/* What the pointer and a tap land on: the whole height of each
              slot, wider than any bar, on top of everything. */}
          {bars && c.overdue && (
            <rect x={padL} y={padT} width={OD_W} height={plotH} fill="transparent" style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHover('overdue')} onClick={() => onSelect?.('overdue')} />
          )}
          {c.points.map((p, i) => (
            <rect key={p.date} x={plotL + slot * i} y={padT} width={slot} height={plotH} fill="transparent" style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHover(p.date)} onClick={() => onSelect?.(p.date)} />
          ))}
        </svg>
        {shown && <Tooltip summary={daySummary(payload, hover, 5)} x={xOf(hover)} width={W} />}
        {bars && c.empty && (
          <div style={{ position: 'absolute', inset: `${padT}px ${padR}px ${padB}px ${plotL}px`, display: 'flex',
                        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', fontSize: 12.5, color: 'var(--text-muted)' }}>
            Nothing expected in or out in these days.
          </div>
        )}
      </div>
    </div>
  );
}

// The table: a row a day with what comes in, goes out, the net and the
// balance at the end of it, the Overdue row first. Scrolls inside its own box
// both ways, the date column and the headings pinned, as the budget grid.
export function CashTable({ payload, days, selected, onSelect }) {
  const { rows, total } = tableRows(payload, days);
  const overdraft = payload?.bank?.overdraft || 0;
  const head = { padding: '7px 10px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap',
                 position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1, borderBottom: '1px solid var(--border)' };
  const dateCell = extra => ({ position: 'sticky', left: 0, background: 'var(--bg-card)', textAlign: 'left', padding: '6px 12px 6px 0', whiteSpace: 'nowrap', ...extra });
  const num = extra => ({ padding: '6px 10px', textAlign: 'right', whiteSpace: 'nowrap', ...extra });
  return (
    <div style={{ overflow: 'auto', maxHeight: 520, marginTop: 4 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...head, textAlign: 'left', left: 0, zIndex: 2, padding: '7px 12px 7px 0' }}>Date</th>
            <th style={head}>Cash in</th>
            <th style={head}>Cash out</th>
            <th style={head}>Net movement</th>
            <th style={head}>Bank balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const on = selected === r.date;
            const bg = on ? 'var(--accent-subtle)' : r.key === 'overdue' ? 'var(--warning-subtle)' : 'var(--bg-card)';
            return (
              <tr key={r.key} onClick={() => onSelect?.(r.date)} style={{ cursor: 'pointer', borderBottom: '1px solid var(--border)', background: bg }}>
                <td style={dateCell({ background: bg, fontWeight: r.today || r.key === 'overdue' ? 700 : 400 })}>
                  {/* A real button inside the row, so the keyboard reaches
                      each day as the pointer does. */}
                  <button type="button" onClick={e => { e.stopPropagation(); onSelect?.(r.date); }}
                          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}>
                    {r.label}{r.today ? ' · Today' : ''}
                  </button>
                </td>
                <td style={num()}>{fmtCell(r.in)}</td>
                <td style={num()}>{fmtCell(r.out)}</td>
                <td style={num({ color: signColour(r.net), fontWeight: 600 })}>{fmtCell(r.net)}</td>
                <td style={num({ color: r.balance !== null && r.balance < 0 ? balanceColour(r.balance, overdraft) : undefined })}>
                  {r.balance === null ? '' : fmtCell(r.balance)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
            <td style={dateCell({ fontWeight: 700 })}>Total, {rows.length - 1} days</td>
            <td style={num()}>{fmtCell(total.in)}</td>
            <td style={num()}>{fmtCell(total.out)}</td>
            <td style={num({ color: signColour(total.net) })}>{fmtCell(total.net)}</td>
            <td style={num()}>{total.balance === null ? '' : fmtCell(total.balance)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// The calendar: a month grid for each month the window touches, each day of
// the window showing its net movement, coloured. Clicking one opens its
// items; Overdue, which is no day, has its own button above.
export function CashCalendar({ payload, days, currency, selected, onSelect }) {
  const months = calendarMonths(payload, days);
  const overdue = daySummary(payload, 'overdue', 0);
  const symbol = currencySymbol(currency);
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" className="btn btn-outline btn-sm" onClick={() => onSelect?.('overdue')}
              aria-pressed={selected === 'overdue'}
              style={{ marginBottom: 12, ...(selected === 'overdue' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}>
        Overdue: {fmtCell(overdue.net)} net · {overdue.count} item{overdue.count === 1 ? '' : 's'}
      </button>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
        {months.map(m => (
          <div key={m.key} style={{ flex: '1 1 280px', minWidth: 0, maxWidth: 420 }}>
            <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>{m.label}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 3 }}>
              {weekdayLabels().map(w => (
                <div key={w} style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textAlign: 'center', paddingBottom: 2 }}>{w}</div>
              ))}
              {m.weeks.flat().map((cell, i) => {
                if (!cell) return <div key={`b${i}`} />;
                if (!cell.inWindow) {
                  return (
                    <div key={cell.date} style={{ minHeight: 44, padding: '4px 5px', fontSize: 10.5, color: 'var(--text-muted)', opacity: 0.5 }}>{cell.day}</div>
                  );
                }
                const on = selected === cell.date;
                const nil = Math.round(cell.net * 100) === 0 && Math.round(cell.in * 100) === 0 && Math.round(cell.out * 100) === 0;
                return (
                  <button key={cell.date} type="button" onClick={() => onSelect?.(cell.date)} aria-pressed={on}
                          title={`In ${fmtCell(cell.in)} · Out ${fmtCell(cell.out)} · Balance ${fmtCell(cell.balance)}`}
                          style={{
                            minHeight: 44, padding: '4px 5px', textAlign: 'left', cursor: 'pointer', borderRadius: 6,
                            display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minWidth: 0,
                            border: `1px solid ${cell.today ? 'var(--accent)' : 'var(--border)'}`,
                            background: on ? 'var(--accent-subtle)' : 'var(--bg-card)', color: 'var(--text-primary)',
                          }}>
                    <span style={{ fontSize: 10.5, fontWeight: cell.today ? 700 : 500 }}>{cell.day}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: nil ? 'var(--text-muted)' : signColour(cell.net),
                                   overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                      {nil ? '–' : `${cell.net > 0 ? '+' : ''}${compactAmount(cell.net, symbol)}`}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// A day's items, opened by clicking a bar, a row or a calendar day: who, what,
// where the date came from and how much, with the way to change each one.
export function DayPanel({ payload, date, onClose, onEdit }) {
  const s = daySummary(payload, date, Infinity);
  const cell = { padding: '6px 10px 6px 0', verticalAlign: 'top' };
  return (
    <div style={{ marginTop: 14, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{s.title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
            In {fmtCell(s.in)} · Out {fmtCell(s.out)} · Net <span style={{ color: signColour(s.net), fontWeight: 600 }}>{fmtCell(s.net)}</span>
            {s.balance !== null && <> · Balance at the end of the day {fmtCell(s.balance)}</>}
          </div>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>Close</button>
      </div>
      {s.count === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 10 }}>
          {date === 'overdue' ? 'Nothing is overdue.' : 'Nothing is expected in or out on this day.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: '100%' }}>
            <tbody>
              {s.items.map(item => {
                const t = itemTitle(item);
                return (
                  <tr key={item.key} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ ...cell, whiteSpace: 'nowrap', fontWeight: 600 }}>{item.direction === 'out' ? 'Out' : 'In'}</td>
                    <td style={cell}>{contactOf(item)}</td>
                    <td style={cell}>
                      {t.primary}
                      {t.secondary && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.secondary}</div>}
                    </td>
                    <td style={{ ...cell, whiteSpace: 'nowrap', fontSize: 11, color: 'var(--text-muted)' }} title={basisHint(item.dateBasis)}>
                      {basisLabel(item.dateBasis)}
                    </td>
                    <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {item.direction === 'out' ? '−' : '+'}{fmtCell(item.amount)}
                    </td>
                    {onEdit && (
                      <td style={{ ...cell, paddingRight: 0, textAlign: 'right' }}>
                        <button type="button" className="btn btn-outline btn-sm" style={{ padding: '2px 8px' }}
                                aria-label={item.source === 'manual' ? 'Edit entry' : 'Change date or amount'}
                                title={item.source === 'manual' ? 'Edit entry' : 'Change date or amount'}
                                onClick={() => onEdit(item)}>✎</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
