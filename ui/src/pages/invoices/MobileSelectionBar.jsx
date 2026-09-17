export default function MobileSelectionBar({ selected, setSelected, deleteLoading, promptDeleteSelected }) {
  return (
        <div style={{
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
          alignItems: 'center',
          justifyContent: 'space-between',
          zIndex: 95,
          backdropFilter: 'blur(10px)',
          animation: 'fadeUp 0.2s ease',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
              {selected.size} selected
            </span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setSelected(new Set())}
              style={{ fontSize: 11.5, padding: '2px 8px', color: 'var(--text-muted)' }}
            >
              Clear
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-sm"
              onClick={promptDeleteSelected}
              disabled={deleteLoading}
              style={{
                background: 'var(--danger-subtle)',
                color: 'var(--danger)',
                border: '1px solid rgba(239,68,68,0.25)',
                fontSize: 12,
                padding: '6px 12px',
                fontWeight: 600,
              }}
            >
              {deleteLoading ? '...' : `🗑 Delete (${selected.size})`}
            </button>
          </div>
        </div>
  );
}
