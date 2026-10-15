// The outcome of a test or a save, beside the button that ran it: a tick or a
// cross and one line. `msg` is { ok, text }, or null for nothing yet.
export default function ResultNote({ msg }) {
  if (!msg) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 12, fontWeight: 500,
      color: msg.ok ? 'var(--success)' : 'var(--danger)',
      background: msg.ok ? 'var(--success-subtle)' : 'var(--danger-subtle)',
      padding: '4px 10px', borderRadius: 6,
      animation: 'fadeIn 0.2s ease',
    }}>
      {msg.ok ? '✓' : '✕'} {msg.text}
    </span>
  );
}
