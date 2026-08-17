import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { usePipeline } from '../../context/PipelineContext';

const NAV = [
  { to: '/dashboard',  label: 'Dashboard',  icon: '▦',  desc: 'Financial reports' },
  { to: '/invoices',   label: 'AR & AP',    icon: '◧',  desc: 'Invoices & bills' },
  { to: '/automation', label: 'Automation', icon: '◆',  desc: 'Pipeline & controls' },
];

// Setup sits in its own group rather than inline with the day-to-day pages —
// it's configured once, not visited daily.
const SETTINGS_NAV = [
  { to: '/setup', label: 'Setup', icon: '◈', desc: 'Config' },
];

const ADMIN_NAV = [
  { to: '/admin', label: 'Users', icon: '◉', desc: 'Admin' },
];

function NavItem({ to, label, icon, desc, isDark }) {
  return (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        display:        'flex',
        alignItems:     'center',
        gap:            11,
        padding:        '9px 12px',
        borderRadius:   10,
        marginBottom:   2,
        fontSize:       13,
        fontWeight:     isActive ? 600 : 400,
        color: isDark
          ? (isActive ? '#ffffff' : 'rgba(255,255,255,0.5)')
          : (isActive ? '#6366f1' : '#4b5068'),
        background: isActive
          ? (isDark
              ? 'linear-gradient(135deg, rgba(99,102,241,0.35) 0%, rgba(139,92,246,0.25) 100%)'
              : 'rgba(99,102,241,0.09)')
          : 'transparent',
        textDecoration: 'none',
        transition:     'all 0.18s ease',
        border: isActive
          ? (isDark ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(99,102,241,0.18)')
          : '1px solid transparent',
        position: 'relative',
      })}
    >
      {({ isActive }) => (
        <>
          <span style={{
            width:          30,
            height:         30,
            borderRadius:   8,
            flexShrink:     0,
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            fontSize:       15,
            background: isActive
              ? (isDark ? 'rgba(99,102,241,0.4)' : 'rgba(99,102,241,0.15)')
              : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
            transition: 'background 0.18s',
          }}>
            {icon}
          </span>
          <div>
            <div style={{ lineHeight: 1.2 }}>{label}</div>
            <div style={{ fontSize: 10, opacity: 0.45, lineHeight: 1 }}>{desc}</div>
          </div>
          {isActive && (
            <span style={{
              position:    'absolute',
              right:       12,
              top:         '50%',
              transform:   'translateY(-50%)',
              width:       5,
              height:      5,
              borderRadius: '50%',
              background:  isDark ? 'rgba(99,102,241,0.8)' : '#6366f1',
            }} />
          )}
        </>
      )}
    </NavLink>
  );
}

// `first` is the group heading that sits directly above the <nav> element, so it
// carries no top padding of its own; every later group needs the gap.
function SectionLabel({ children, isDark, first }) {
  return (
    <div style={{
      fontSize:      10,
      fontWeight:    700,
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      color:         isDark ? 'rgba(255,255,255,0.2)' : '#aaaacc',
      padding:       first ? '0 16px 6px' : '14px 12px 6px',
    }}>
      {children}
    </div>
  );
}

function PipelineWidget({ isDark }) {
  const { status } = usePipeline();
  const queue = status?.queue;
  const xero  = status?.xero;

  const emailActive = queue && (queue.processing > 0 || queue.pending > 0 || queue.dead > 0);
  const total       = xero ? (xero.pending + xero.submitting + xero.posted + xero.error) : 0;
  const pctPosted   = total > 0 ? (xero.posted     / total) * 100 : 0;
  const pctActive   = total > 0 ? (xero.submitting / total) * 100 : 0;
  const pctFailed   = total > 0 ? (xero.error      / total) * 100 : 0;
  const allPosted   = total > 0 && xero.posted === total;

  const borderColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
  const muted       = isDark ? 'rgba(255,255,255,0.3)' : '#9399b0';
  const subtle      = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)';

  return (
    <div style={{
      margin: '0 8px 8px',
      padding: '11px 12px',
      borderRadius: 10,
      background: subtle,
      border: `1px solid ${borderColor}`,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: muted, marginBottom: 8 }}>
        Pipeline
      </div>

      {/* Email row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: muted }}>Email</span>
        {emailActive ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {queue.processing > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--accent)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'pulse 1.4s ease-in-out infinite', display: 'inline-block' }} />
                {queue.processing} active
              </span>
            )}
            {queue.pending > 0 && <span style={{ fontSize: 11, color: muted }}>{queue.pending} queued</span>}
            {queue.dead > 0 && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{queue.dead} failed</span>}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: muted }}>Idle</span>
        )}
      </div>

      {/* Xero row + mini bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: total > 0 ? 5 : 0 }}>
        <span style={{ fontSize: 11, color: muted }}>Xero</span>
        <span style={{ fontSize: 11, color: allPosted ? 'var(--success)' : xero?.error > 0 ? 'var(--danger)' : muted }}>
          {total === 0 ? 'No invoices' : allPosted ? 'All posted' : `${xero.posted}/${total} posted`}
        </span>
      </div>
      {total > 0 && (
        <div style={{ height: 4, borderRadius: 2, background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', overflow: 'hidden', position: 'relative' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pctPosted}%`, background: 'var(--success)', transition: 'width 0.6s ease', borderRadius: 2 }} />
          <div style={{ position: 'absolute', left: `${pctPosted}%`, top: 0, height: '100%', width: `${pctActive}%`, background: 'var(--accent)', overflow: 'hidden' }}>
            {pctActive > 0 && <div style={{ height: '100%', width: '60%', background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent)', animation: 'scanline 1.4s ease-in-out infinite' }} />}
          </div>
          <div style={{ position: 'absolute', right: 0, top: 0, height: '100%', width: `${pctFailed}%`, background: 'var(--danger)', borderRadius: '0 2px 2px 0' }} />
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { user, logout } = useAuth();
  const { theme }        = useTheme();
  const navigate         = useNavigate();
  const isDark           = theme === 'dark';

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const initials = user?.email?.slice(0, 2).toUpperCase() || '?';

  return (
    <aside style={{
      position:   'fixed',
      top:        0,
      left:       0,
      bottom:     0,
      width:      'var(--sidebar-width)',
      background: isDark ? '#0c0c12' : '#ffffff',
      display:    'flex',
      flexDirection: 'column',
      zIndex:     100,
      borderRight: isDark
        ? '1px solid rgba(255,255,255,0.04)'
        : '1px solid #e2e2f0',
      transition: 'background 0.2s ease, border-color 0.2s ease',
    }}>

      {/* Brand */}
      <div style={{
        padding:      '20px 16px 16px',
        borderBottom: isDark ? '1px solid rgba(255,255,255,0.05)' : '1px solid #e2e2f0',
        marginBottom: 10,
        display:      'flex',
        alignItems:   'center',
        gap:          11,
      }}>
        <div style={{
          width:          34,
          height:         34,
          borderRadius:   9,
          background:     'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          fontSize:       16,
          flexShrink:     0,
          boxShadow:      '0 4px 12px rgba(99,102,241,0.4)',
        }}>
          ⚡
        </div>
        <div>
          <div style={{
            fontWeight:    700,
            fontSize:      13,
            color:         isDark ? '#ffffff' : '#0d0e14',
            letterSpacing: '-0.2px',
            lineHeight:    1.2,
          }}>
            Xero Automation
          </div>
          <div style={{ fontSize: 10, color: isDark ? 'rgba(255,255,255,0.3)' : '#9399b0', marginTop: 1 }}>
            Invoice Pipeline
          </div>
        </div>
      </div>

      <SectionLabel isDark={isDark} first>Navigation</SectionLabel>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '0 8px', overflow: 'auto' }}>
        {NAV.map(item => <NavItem key={item.to} {...item} isDark={isDark} />)}

        <SectionLabel isDark={isDark}>Settings</SectionLabel>
        {SETTINGS_NAV.map(item => <NavItem key={item.to} {...item} isDark={isDark} />)}

        {user?.role === 'admin' && (
          <>
            <SectionLabel isDark={isDark}>Admin</SectionLabel>
            {ADMIN_NAV.map(item => <NavItem key={item.to} {...item} isDark={isDark} />)}
          </>
        )}
      </nav>

      {/* Pipeline status widget — always visible regardless of current page */}
      <PipelineWidget isDark={isDark} />

      {/* User card */}
      <div style={{
        margin:     '8px 8px 12px',
        padding:    '12px 14px',
        borderRadius: 12,
        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
        border:     isDark ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(0,0,0,0.07)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          {/* Avatar */}
          <div style={{
            width:          32,
            height:         32,
            borderRadius:   9,
            background:     'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            fontSize:       12,
            fontWeight:     700,
            color:          '#fff',
            flexShrink:     0,
          }}>
            {initials}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize:     12,
              fontWeight:   600,
              color:        isDark ? '#ffffff' : '#0d0e14',
              overflow:     'hidden',
              textOverflow: 'ellipsis',
              whiteSpace:   'nowrap',
            }}>
              {user?.email}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
              <span style={{
                display:     'inline-flex',
                alignItems:  'center',
                gap:         3,
                padding:     '1px 7px',
                borderRadius: 100,
                fontSize:    10,
                fontWeight:  600,
                background:  user?.role === 'admin' ? 'rgba(245,158,11,0.15)' : 'rgba(99,102,241,0.12)',
                color:       user?.role === 'admin' ? '#f59e0b' : '#6366f1',
              }}>
                {user?.role === 'admin' ? '★' : '◦'} {user?.role}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          style={{
            width:       '100%',
            padding:     '7px 0',
            background:  isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
            border:      isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.08)',
            borderRadius: 8,
            cursor:      'pointer',
            fontSize:    12,
            fontWeight:  500,
            color:       isDark ? 'rgba(255,255,255,0.45)' : '#9399b0',
            transition:  'all 0.18s ease',
            display:     'flex',
            alignItems:  'center',
            justifyContent: 'center',
            gap:         6,
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background    = 'rgba(239,68,68,0.1)';
            e.currentTarget.style.color         = '#ef4444';
            e.currentTarget.style.borderColor   = 'rgba(239,68,68,0.25)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background  = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
            e.currentTarget.style.color       = isDark ? 'rgba(255,255,255,0.45)' : '#9399b0';
            e.currentTarget.style.borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
          }}
        >
          ⎋ Sign out
        </button>
      </div>
    </aside>
  );
}
