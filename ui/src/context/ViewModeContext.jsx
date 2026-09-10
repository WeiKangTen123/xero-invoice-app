import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const ViewModeContext = createContext(null);

const STORAGE_KEY  = 'xero_view_mode';
// The one place the mobile breakpoint is written down. globals.css deliberately
// carries no media query of its own — Layout puts .mobile-mode on .app-layout
// from the isMobile below — so this constant decides the layout for both the
// CSS and the components that branch on isMobile.
const MOBILE_QUERY = '(max-width: 768px)';

function _matchesNarrow() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function ViewModeProvider({ children }) {
  // mode: 'auto' | 'desktop' | 'mobile'
  const [mode, setMode] = useState(() => localStorage.getItem(STORAGE_KEY) || 'auto');

  // Tracked as a boolean, not a pixel width. Storing innerWidth here meant every
  // resize event re-rendered the entire app from the root provider — and on a
  // phone that fires on scroll-driven browser-chrome changes and every time the
  // keyboard opens, none of which can change which layout we want. matchMedia
  // only notifies when the breakpoint is actually crossed.
  const [narrow, setNarrow] = useState(_matchesNarrow);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(MOBILE_QUERY);
    // Resync once on mount: the viewport can change between the initial render
    // and this effect running, and that change would carry no event.
    setNarrow(mql.matches);
    const onChange = e => setNarrow(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // True when the user forced mobile, or left it on auto and the screen is narrow.
  const isMobile = mode === 'mobile' || (mode === 'auto' && narrow);

  const setViewMode = useCallback((newMode) => {
    setMode(newMode);
    localStorage.setItem(STORAGE_KEY, newMode);
  }, []);

  // Toggles away from what is currently on screen, not from the stored mode.
  // Keying off the stored value meant that from the default 'auto' on a phone —
  // already rendering mobile — the first press set mode to 'mobile' and changed
  // nothing visible, so the button looked dead until pressed twice. That dead
  // press only ever hit phone users, who are the point of the mobile view.
  const toggleViewMode = useCallback(() => {
    setViewMode(isMobile ? 'desktop' : 'mobile');
  }, [isMobile, setViewMode]);

  return (
    <ViewModeContext.Provider value={{
      mode,
      setViewMode,
      toggleViewMode,
      isMobile,
      mobileDrawerOpen,
      setMobileDrawerOpen,
    }}>
      {children}
    </ViewModeContext.Provider>
  );
}

export function useViewMode() {
  const ctx = useContext(ViewModeContext);
  if (!ctx) {
    return {
      mode: 'auto',
      isMobile: false,
      setViewMode: () => {},
      toggleViewMode: () => {},
      mobileDrawerOpen: false,
      setMobileDrawerOpen: () => {},
    };
  }
  return ctx;
}
