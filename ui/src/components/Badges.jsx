import { statusMeta, typeMeta } from '../utils/badges';

export function StatusBadge({ status, long = false, style }) {
  const m = statusMeta(status);
  return <span className={`badge ${m.cls}`} style={style}>{long ? m.long : m.label}</span>;
}

export function TypeBadge({ type, long = false, style }) {
  const m = typeMeta(type);
  return <span className={`badge ${m.cls}`} style={style}>{long ? m.long : m.label}</span>;
}

// How sure the AI reader was of what it took off the document. 'high', and a
// record with no rating at all (typed in by hand, or read before ratings
// existed), show nothing: a badge on every row would be read as noise and then
// ignored on the rows where it matters. The tooltip says what to look at,
// because "check this" alone does not say what might be wrong.
const CONFIDENCE_TIP = {
  low:    'The AI reader was unsure about this document. Check the supplier, date, amounts and tax against the original before sending it to Xero.',
  medium: 'The AI reader was not fully sure about some details. Worth a quick look at the supplier, date and amounts against the original before sending it to Xero.',
};

export function ConfidenceBadge({ confidence, style }) {
  const tip = CONFIDENCE_TIP[confidence];
  if (!tip) return null;
  return (
    <span className="badge badge-yellow" title={tip} aria-label={`Check this. ${tip}`} role="note"
          style={{ cursor: 'help', ...style }}>
      Check this
    </span>
  );
}
