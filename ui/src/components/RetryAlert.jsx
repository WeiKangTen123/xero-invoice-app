// A load that failed, said as a failure, with the one thing worth trying next.
//
// Errors on several pages were swallowed, and what showed instead was whatever
// the page looks like with nothing in it: "No bills yet" over a list that never
// arrived, or a spinner that never stopped. Those read as "there is nothing
// here" or "wait", when the truth was "we could not look" — so this says that,
// and offers to look again.
export default function RetryAlert({ message, onRetry, busy = false, style }) {
  return (
    <div className="alert alert-error" role="alert" style={{ alignItems: 'center', ...style }}>
      <span className="alert-icon">✕</span>
      <span style={{ flex: 1, minWidth: 0 }}>{message || 'Something went wrong.'}</span>
      {onRetry && (
        <button type="button" className="btn btn-outline btn-sm" onClick={onRetry} disabled={busy}
                style={{ flexShrink: 0 }}>
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}
