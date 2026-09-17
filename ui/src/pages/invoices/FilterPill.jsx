export function FilterPill({ active, onClick, label, count }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 12px', borderRadius: 100, cursor: 'pointer',
        fontSize: 12, fontWeight: 600,
        background: active ? 'var(--accent)' : 'var(--bg-card)',
        color: active ? '#fff' : 'var(--text-secondary)',
        border: active ? '1px solid transparent' : '1px solid var(--border)',
        boxShadow: active ? '0 2px 8px rgba(99,102,241,0.3)' : 'none',
        transition: 'all 0.15s ease',
      }}
    >
      {label}
      <span style={{
        padding: '0 5px', borderRadius: 100, fontSize: 11,
        background: active ? 'rgba(255,255,255,0.2)' : 'var(--bg-hover)',
        color: active ? '#fff' : 'var(--text-muted)',
      }}>
        {count}
      </span>
    </button>
  );
}
