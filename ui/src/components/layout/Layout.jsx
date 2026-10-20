import { Suspense, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import BottomNav from './BottomNav';
import ChatAssistant from '../ChatAssistant';
import XeroConnectionBanner from './XeroConnectionBanner';
import { useViewMode } from '../../context/ViewModeContext';

// Room kept free on the right of everything under the header for the chat
// while it is docked there (--chat-dock-width, 0px otherwise), moving with
// the chat as it slides in and out. A margin rather than padding, so the
// page's own scrollbar stays beside the chat instead of under it.
const DOCK_ROOM = {
  marginRight: 'var(--chat-dock-width)',
  transition: 'margin-right 0.25s cubic-bezier(0.4,0,0.2,1)',
};

export default function Layout() {
  const { isMobile, mobileDrawerOpen, setMobileDrawerOpen } = useViewMode();
  // The width of the chat while it is docked beside the page (a wide window,
  // chat open), else 0. ChatAssistant reports it; nothing else sets it.
  const [chatDock, setChatDock] = useState(0);

  return (
    <div className={`app-layout ${isMobile ? 'mobile-mode' : ''}`} style={{ '--chat-dock-width': `${chatDock}px` }}>
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
        {/* Whole width, over the docked chat too: the chat starts under it. */}
        <Header />
        {/* Between the header and the page so it shows on every page without
            each page making room for it, and scrolls away with none of them. */}
        <div style={{ ...DOCK_ROOM, flexShrink: 0 }}>
          <XeroConnectionBanner isMobile={isMobile} />
        </div>
        <div className="page-body" style={DOCK_ROOM}>
          {/* Page chunks load on demand (see App.jsx), so the boundary sits
              here rather than around the whole app — the sidebar, header and
              bottom nav stay put and only the content area swaps. */}
          <Suspense fallback={<div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading...</div>}>
            <Outlet />
          </Suspense>
        </div>
      </div>

      {isMobile && <BottomNav />}
      <ChatAssistant onDockChange={setChatDock} />
    </div>
  );
}
