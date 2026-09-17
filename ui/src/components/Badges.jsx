import { statusMeta, typeMeta } from '../utils/badges';

export function StatusBadge({ status, long = false, style }) {
  const m = statusMeta(status);
  return <span className={`badge ${m.cls}`} style={style}>{long ? m.long : m.label}</span>;
}

export function TypeBadge({ type, long = false, style }) {
  const m = typeMeta(type);
  return <span className={`badge ${m.cls}`} style={style}>{long ? m.long : m.label}</span>;
}
