import { useTheme } from '../../context/ThemeContext';
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
      padding: '0 28px',
      flexShrink: 0,
      backdropFilter: 'blur(8px)',
      position: 'sticky',
      top: 0,
      zIndex: 50,
    }}>
      {/* Breadcrumbs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>App</span>
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>›</span>
            {c.to
              ? <Link to={c.to} style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', textDecoration: 'none' }}>{c.label}</Link>
              : <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{c.label}</span>
            }
          </span>
        ))}
      </div>

      {/* Right actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Theme toggle */}
        <button
          onClick={toggle}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          style={{
            width: 36, height: 36,
            borderRadius: '50%',
            border: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 15, color: 'var(--text-secondary)',
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
