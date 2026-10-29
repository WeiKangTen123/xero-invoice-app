// The outcome of a test or a save, beside the button that ran it: a tick or a
// cross and the message. `msg` is { ok, text }, or null for nothing yet. A long
// message (a refusal and what to do about it) wraps rather than pushing the
// button out of its card.
export default function ResultNote({ msg }) {
  if (!msg) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      maxWidth: 560, lineHeight: 1.45, overflowWrap: 'anywhere',
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
