import { StatusBadge } from '../../components/Badges';
import { useAccountName } from '../../components/AccountCodeSelect';

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
export function AccountMiniField({ code }) {
  const name = useAccountName(code);
  if (!code) return null;
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 3 }}>
        Account
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
        {name || <span style={{ fontFamily: 'monospace' }}>{code}</span>}
        {name && <span style={{ fontFamily: 'monospace', fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 6 }}>{code}</span>}
      </div>
    </div>
  );
}

export function MiniField({ label, value, mono }) {
  if (!value && value !== 0) return null;
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-word' }}>
        {value}
      </div>
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
