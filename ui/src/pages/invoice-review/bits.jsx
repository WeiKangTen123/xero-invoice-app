import { StatusBadge } from '../../components/Badges';
import { useAccountName } from '../../components/AccountCodeSelect';
import { prefillText } from './helpers';

const LABEL_STYLE = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 3 };
const NOTE_STYLE  = { fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 };

// ── Prefilled-from note ───────────────────────────────────────────────────────
// "from last bill (INV-123, 3 Sep)" under a field supplier memory filled in,
// linking to that record. A real link, so it opens in a new tab like any
// other; a plain click moves within the app through onOpen, which keeps the
// way back to the list. `lead` names the field where the note sits apart
// from it ("Currency USD").
export function PrefillNote({ from, invoiceType, onOpen, lead }) {
  if (!from?.fromId) return null;
  const href = `/invoices/${encodeURIComponent(from.fromId)}`;
  function onClick(e) {
    if (!onOpen || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(from.fromId);
  }
  return (
    <div style={NOTE_STYLE}>
      {lead ? `${lead} ` : ''}
      <a href={href} onClick={onClick} style={{ color: 'inherit', textDecoration: 'underline' }}
        title="Open the record this value was taken from">
        {prefillText(from, invoiceType)}
      </a>
    </div>
  );
}

// What a record with no account of its own is posted to: the Xero contact's
// default account, and Setup's default when the contact has none. That is
// decided when it is sent (main/xero/invoices.js), so the page can only say
// which way it will go and what Setup's default is.
export function accountFallbackText(setupCode, sent) {
  const setup = setupCode ? `your Setup default (${setupCode})` : 'your Setup default';
  return sent
    ? `The Xero contact's default account was used, or ${setup} if it had none.`
    : `The Xero contact's default account, or ${setup} if it has none.`;
}

// ── Info row ──────────────────────────────────────────────────────────────────
export function InfoRow({ label, value, mono }) {
  if (!value && value !== 0) return null;
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ width: 140, flexShrink: 0, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', paddingTop: 1 }}>
        {label}
      </div>
      <div style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-word' }}>
        {value}
      </div>
    </div>
  );
}

// ── Mini field (compact 2-per-row variant of InfoRow, for the summary grid) ─────
// The read-only twin of the account picker: leads with the account NAME and keeps
// the code as a quiet monospace suffix, so the summary reads the same way the
// editor does. Falls back to the bare code when the name can't be resolved —
// no Xero connection, or a code this org doesn't have.
//
// A record with no account of its own used to show nothing here. Intake no
// longer writes Setup's default onto a record, so that is now the usual case
// for a new supplier, and the field says what it will be sent with instead.
// `note` sits under the value (where supplier memory filled it in).
export function AccountMiniField({ code, setupCode, sent, note }) {
  const name = useAccountName(code);
  if (!code) {
    return (
      <div>
        <div style={LABEL_STYLE}>Account</div>
        <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{sent ? 'Chosen when it was sent' : 'Chosen when sent'}</div>
        <div style={NOTE_STYLE}>{accountFallbackText(setupCode, sent)}</div>
      </div>
    );
  }
  return (
    <div>
      <div style={LABEL_STYLE}>Account</div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
        {name || <span style={{ fontFamily: 'monospace' }}>{code}</span>}
        {name && <span style={{ fontFamily: 'monospace', fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 6 }}>{code}</span>}
      </div>
      {note}
    </div>
  );
}

export function MiniField({ label, value, mono, note }) {
  if (!value && value !== 0) return null;
  return (
    <div>
      <div style={LABEL_STYLE}>{label}</div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-word' }}>
        {value}
      </div>
      {note}
    </div>
  );
}

// ── Status pill ───────────────────────────────────────────────────────────────
export function StatusPill({ status }) {
  return <StatusBadge status={status} long style={{ fontSize: 12, padding: '4px 12px' }} />;
}

// ── Spinner ───────────────────────────────────────────────────────────────────
export function Spinner() {
  return <span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />;
}
