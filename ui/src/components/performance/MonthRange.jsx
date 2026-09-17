import { } from './primitives';

// ── Month range ──────────────────────────────────────────────────────────────
// Two selects rather than a date picker: the underlying reports are monthly, so
// offering arbitrary days would imply a precision the data doesn't have.
// The 12-month windows a single pair of Xero calls can cover. Anything wider
// would need several calls stitched together, so it isn't offered here.
// Quick picks. Each resolves server-side from the ORG's own fiscal year end, so
// "financial year to date" means Apr-to-now for a March year end and Jan-to-now
// for a December one — no per-company configuration.
export const PRESETS = [
  { key: 'this-month',   label: 'This month' },
  { key: 'last-month',   label: 'Last month' },
  { key: 'this-quarter', label: 'This quarter' },
  { key: 'last-quarter', label: 'Last quarter' },
  { key: 'fy-ytd',       label: 'Financial year to date' },
  { key: 'cy-ytd',       label: 'Calendar year to date' },
  { key: 'fy',           label: 'This financial year' },
  { key: 'prev-fy',      label: 'Previous financial year' },
  { key: 'next-fy',      label: 'Next financial year' },
  { key: 'cy',           label: 'Calendar year' },
  { key: 'last-3',       label: 'Last 3 months' },
  { key: 'last-6',       label: 'Last 6 months' },
  { key: 'last-12',      label: 'Last 12 months' },
];

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Two independent controls. The preset is a shortcut that SETS the range; the
// range itself spans years and is never limited to whatever the preset chose —
// constraining one by the other was what made the old control unusable.
export function MonthRange({ months, from, to, onChange, label, preset, onPreset, onRange, chunks }) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 11 }, (_, i) => thisYear - 7 + i);
  const sel = { width: 'auto', fontSize: 12, padding: '5px 8px' };

  // The range pickers work in absolute year+month, independent of the months the
  // current period happens to contain.
  const parse = k => ({ y: Number(String(k).slice(0, 4)), m: Number(String(k).slice(5, 7)) });
  const fromKey = months?.[from]?.key || months?.[0]?.key;
  const toKey   = months?.[to]?.key   || months?.[months.length - 1]?.key;
  if (!fromKey || !toKey) return null;
  const F = parse(fromKey), T = parse(toKey);
  const emit = (f, t) => onRange(`${f.y}-${String(f.m).padStart(2, '0')}`, `${t.y}-${String(t.m).padStart(2, '0')}`);

  const picker = (v, onY, onM) => (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <select className="form-input" style={sel} value={v.m} onChange={e => onM(Number(e.target.value))}>
        {MONTH_ABBR.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
      </select>
      <select className="form-input" style={sel} value={v.y} onChange={e => onY(Number(e.target.value))}>
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </span>
  );

  const span = months.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        Period
      </span>
      <select className="form-input" style={sel} value={preset} onChange={e => onPreset(e.target.value)}>
        {PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        <option value="custom">Custom range…</option>
      </select>

      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>·</span>
      {picker(F, y => emit({ ...F, y }, T), m => emit({ ...F, m }, T))}
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>→</span>
      {picker(T, y => emit(F, { ...T, y }), m => emit(F, { ...T, m }))}

      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {span} month{span === 1 ? '' : 's'}
        {chunks > 1 && ` · ${chunks} Xero fetches`}
        {label ? ` · ${label}` : ''}
      </span>
    </div>
  );
}
