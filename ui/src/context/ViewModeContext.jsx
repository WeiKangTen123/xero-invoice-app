import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const ViewModeContext = createContext(null);

export function ViewModeProvider({ children }) {
  // mode: 'auto' | 'desktop' | 'mobile'
  const [mode, setMode] = useState(() => {
    return localStorage.getItem('xero_view_mode') || 'auto';
  });

  const [windowWidth, setWindowWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200));
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  useEffect(() => {
    function onResize() {
      setWindowWidth(window.innerWidth);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setViewMode = useCallback((newMode) => {
    setMode(newMode);
    localStorage.setItem('xero_view_mode', newMode);
  }, []);

  const toggleViewMode = useCallback(() => {
    setMode(prev => {
      const next = prev === 'mobile' ? 'desktop' : 'mobile';
      localStorage.setItem('xero_view_mode', next);
      return next;
    });
  }, []);

  // Derived: true if user forced mobile, or auto and screen width <= 768px
  const isMobile = mode === 'mobile' || (mode === 'auto' && windowWidth <= 768);

  return (
    <ViewModeContext.Provider value={{
      mode,
      setViewMode,
      toggleViewMode,
      isMobile,
      windowWidth,
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
