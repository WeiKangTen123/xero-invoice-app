import { NavLink } from 'react-router-dom';
import { useTheme } from '../../context/ThemeContext';
import { usePipeline } from '../../context/PipelineContext';

const NAV_ITEMS = [
  { to: '/dashboard',  label: 'Dashboard', icon: '▦' },
  { to: '/invoices',   label: 'AR & AP',   icon: '◧' },
  { to: '/automation', label: 'Automation', icon: '◆' },
  { to: '/setup',      label: 'Setup',     icon: '◈' },
];

export default function BottomNav() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const pipeline = usePipeline();
  const q = pipeline?.status?.queue;
  const isProcessing = (q?.processing || 0) > 0;

  return (
    <nav style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: 60,
      background: isDark ? 'rgba(12, 12, 18, 0.95)' : 'rgba(255, 255, 255, 0.95)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderTop: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid #e2e2f0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-around',
      zIndex: 90,
      padding: '0 8px',
      boxShadow: '0 -2px 10px rgba(0,0,0,0.06)',
    }}>
      {NAV_ITEMS.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          style={({ isActive }) => ({
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textDecoration: 'none',
            flex: 1,
            height: '100%',
            color: isActive ? 'var(--accent)' : 'var(--text-muted)',
            transition: 'color 0.15s ease',
            position: 'relative',
          })}
        >
          {({ isActive }) => (
            <>
              <span style={{
                fontSize: 19,
                lineHeight: 1,
                marginBottom: 3,
                transform: isActive ? 'scale(1.1)' : 'scale(1)',
                transition: 'transform 0.15s ease',
                position: 'relative',
              }}>
                {item.icon}
                {item.to === '/automation' && isProcessing && (
                  <span style={{
                    position: 'absolute',
                    top: -2,
                    right: -4,
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--accent)',
                    animation: 'pulse 1.4s ease-in-out infinite',
                  }} />
                )}
              </span>
              <span style={{
                fontSize: 10,
                fontWeight: isActive ? 700 : 500,
                letterSpacing: '-0.01em',
              }}>
                {item.label}
              </span>
              {isActive && (
                <span style={{
                  position: 'absolute',
                  top: 0,
                  width: 24,
                  height: 3,
                  borderRadius: '0 0 3px 3px',
                  background: 'var(--accent)',
                }} />
              )}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
