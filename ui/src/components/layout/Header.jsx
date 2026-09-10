import { useTheme } from '../../context/ThemeContext';
import { useViewMode } from '../../context/ViewModeContext';
import { useLocation, Link } from 'react-router-dom';

function getBreadcrumbs(pathname) {
  if (pathname === '/dashboard')  return [{ label: 'Dashboard' }];
  if (pathname === '/automation') return [{ label: 'Automation' }];
  if (pathname === '/setup')      return [{ label: 'Setup' }];
  if (pathname === '/admin')      return [{ label: 'Admin' }];
  if (pathname === '/invoices')   return [{ label: 'AR & AP' }];
  if (pathname.startsWith('/invoices/')) return [
    { label: 'AR & AP', to: '/invoices' },
    { label: 'Review' },
  ];
  return [];
}

export default function Header() {
  const { theme, toggle } = useTheme();
  const { isMobile, toggleViewMode } = useViewMode();
  const { setMobileDrawerOpen } = useViewMode();
  const { pathname } = useLocation();
  const crumbs = getBreadcrumbs(pathname);

  return (
    <header style={{
      height: 'var(--header-height)',
      background: 'var(--bg-primary)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: isMobile ? '0 14px' : '0 28px',
      flexShrink: 0,
      backdropFilter: 'blur(8px)',
      position: 'sticky',
      top: 0,
      zIndex: 50,
    }}>
      {/* Left: Mobile hamburger menu & Breadcrumbs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 6 }}>
        {isMobile && (
          <button
            onClick={() => setMobileDrawerOpen(prev => !prev)}
            aria-label="Open navigation menu"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 20,
              lineHeight: 1,
              padding: '6px 8px',
              color: 'var(--text-primary)',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ☰
          </button>
        )}

        {!isMobile && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>App</span>}
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {!isMobile && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>›</span>}
            {c.to
              ? <Link to={c.to} style={{ fontSize: isMobile ? 14 : 13, fontWeight: 500, color: 'var(--text-muted)', textDecoration: 'none' }}>{c.label}</Link>
              : <span style={{ fontSize: isMobile ? 15 : 13, fontWeight: 600, color: 'var(--text-primary)' }}>{c.label}</span>
            }
          </span>
        ))}
      </div>

      {/* Right actions: View Mode Switcher + Theme toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Web / Mobile Mode Toggle Button */}
        <button
          onClick={toggleViewMode}
          title={`Switch between Mobile and Web layout (Currently: ${isMobile ? 'Mobile' : 'Web'})`}
          style={{
            height: 32,
            padding: '0 10px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: isMobile ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)',
            color: isMobile ? 'var(--accent)' : 'var(--text-secondary)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            transition: 'all 0.18s ease',
          }}
        >
          <span>{isMobile ? '📱' : '💻'}</span>
          <span style={{ fontSize: 11 }}>{isMobile ? 'Mobile' : 'Web'}</span>
        </button>

        {/* Theme toggle */}
        <button
          onClick={toggle}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          style={{
            width: 32, height: 32,
            borderRadius: '50%',
            border: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, color: 'var(--text-secondary)',
            transition: 'all 0.18s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
        >
          {theme === 'dark' ? '☀' : '◑'}
        </button>
      </div>
    </header>
  );
}
