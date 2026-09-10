import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import BottomNav from './BottomNav';
import ChatAssistant from '../ChatAssistant';
import { useViewMode } from '../../context/ViewModeContext';

export default function Layout() {
  const { isMobile, mobileDrawerOpen, setMobileDrawerOpen } = useViewMode();

  return (
    <div className={`app-layout ${isMobile ? 'mobile-mode' : ''}`}>
      {/* Backdrop overlay for mobile drawer */}
      {isMobile && mobileDrawerOpen && (
        <div
          onClick={() => setMobileDrawerOpen(false)}
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.55)',
            backdropFilter: 'blur(3px)',
            WebkitBackdropFilter: 'blur(3px)',
            zIndex: 99,
            animation: 'fadeIn 0.2s ease',
          }}
        />
      )}

      <Sidebar />

      <div className="main-content">
        <Header />
        <div className="page-body">
          {/* Page chunks load on demand (see App.jsx), so the boundary sits
              here rather than around the whole app — the sidebar, header and
              bottom nav stay put and only the content area swaps. */}
          <Suspense fallback={<div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading...</div>}>
            <Outlet />
          </Suspense>
        </div>
      </div>

      {isMobile && <BottomNav />}
      <ChatAssistant />
    </div>
  );
}

