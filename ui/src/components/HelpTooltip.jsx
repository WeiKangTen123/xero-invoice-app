import { useState, useRef } from 'react';

export default function HelpTooltip({ text }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        ref={ref}
        type="button"
        className="help-btn"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open && (
        <span style={{
          position: 'absolute',
          left: 22, top: '50%', transform: 'translateY(-50%)',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '10px 14px',
          fontSize: 12,
          color: 'var(--text-secondary)',
          width: 260,
          lineHeight: 1.6,
          boxShadow: 'var(--shadow-md)',
          zIndex: 1000,
          whiteSpace: 'pre-wrap',
          animation: 'fadeIn 0.15s ease',
          pointerEvents: 'none',
        }}>
          {/* Arrow */}
          <span style={{
            position: 'absolute', left: -5, top: '50%',
            width: 8, height: 8, background: 'var(--bg-card)',
            border: '1px solid var(--border)', borderRight: 'none', borderTop: 'none',
            transform: 'translateY(-50%) rotate(45deg)',
          }} />
          {text}
        </span>
      )}
    </span>
  );
}
