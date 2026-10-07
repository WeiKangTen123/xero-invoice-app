import { statusMeta, typeMeta } from '../utils/badges';
import { fmtMoney } from '../utils/format';
import { XERO_STATUS_META, xeroStatusKey, checkedAgo } from '../pages/invoices/xero-status';

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

// What Xero says about a posted record now: "Approved", "Part-paid · SGD 120.00
// due", "Paid", and how long ago Xero said so. Beside the app's own status,
// not instead of it: "Posted" is still true (it reached Xero), this is what
// happened to it there. Nothing at all for a record not in Xero or not checked
// yet, so an old row does not claim to be a draft. The rules live in
// pages/invoices/xero-status.js, which the review page's re-post gate shares.
export function XeroStatusBadge({ invoice, showChecked = true, style }) {
  const key = xeroStatusKey(invoice);
  if (!key) return null;
  const m       = XERO_STATUS_META[key];
  const due     = key === 'PART_PAID' ? `${fmtMoney(invoice.xeroAmountDue, invoice.currency)} due` : null;
  const checked = checkedAgo(invoice.xeroSyncedAt);
  const tip = [
    m.tip,
    key === 'PART_PAID' ? `Paid so far: ${fmtMoney(invoice.xeroAmountPaid, invoice.currency)}.` : null,
    key === 'PAID' && invoice.xeroPaidOn ? `Paid on ${invoice.xeroPaidOn}.` : null,
    checked ? `Status ${checked}.` : null,
  ].filter(Boolean).join(' ');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...style }}>
      <span className={`badge ${m.cls}`} title={tip}>
        {m.label}{due ? ` · ${due}` : ''}
      </span>
      {showChecked && checked && (
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{checked}</span>
      )}
    </span>
  );
}
