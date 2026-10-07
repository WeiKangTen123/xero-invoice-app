// The phone's actions on a selection, floating above the bottom navigation.
// The three actions sit on their own line under the count, so all of them
// fit a narrow screen without a scroll; each says what it does in a word.
const ACTIONS = [
  { key: 'review', label: '✓ Reviewed', title: 'Mark the selected rows reviewed' },
  { key: 'send',   label: '→ Send',     title: 'Send the selected rows to Xero' },
  { key: 'delete', label: '🗑 Delete',   title: 'Delete the selected rows', danger: true },
];

export default function MobileSelectionBar({ selected, setSelected, busy, onAction }) {
  return (
        <div
          role="region"
          aria-label="Actions on the selected rows"
          style={{
            position: 'fixed',
            bottom: 'calc(var(--bottom-nav-total) + 8px)',
            left: 12,
            right: 12,
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            zIndex: 95,
            backdropFilter: 'blur(10px)',
            animation: 'fadeUp 0.2s ease',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
              {selected.size} selected
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSelected(new Set())}
              disabled={!!busy}
              style={{ fontSize: 11.5, padding: '2px 8px', color: 'var(--text-muted)' }}
            >
              Clear
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {ACTIONS.map(a => (
              <button
                key={a.key}
                type="button"
                className="btn btn-sm"
                onClick={() => onAction(a.key)}
                disabled={!!busy}
                title={a.title}
                aria-label={`${a.title} (${selected.size})`}
                style={{
                  fontSize: 12, padding: '8px 6px', fontWeight: 600, minHeight: 36,
                  ...(a.danger
                    ? { background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.25)' }
                    : { background: 'var(--accent-subtle)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.25)' }),
                }}
              >
                {busy === a.key ? '…' : a.label}
              </button>
            ))}
          </div>
        </div>
  );
}
