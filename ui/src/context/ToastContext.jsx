import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { useViewMode } from './ViewModeContext';

// A message that does not stop the page. Replaces alert(), which blocks the
// tab until dismissed and shows the raw string in a system box.
const ToastContext = createContext(null);
const TTL_MS = 5000;

export function ToastProvider({ children }) {
  const { isMobile } = useViewMode();
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const push = useCallback((kind, text) => {
    const id = ++nextId.current;
    setToasts(t => [...t, { id, kind, text: String(text || '') }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), TTL_MS);
  }, []);
  const toast = useRef({ error: m => push('error', m), success: m => push('success', m), info: m => push('info', m) }).current;

  const tone = { error: 'var(--danger, #ef4444)', success: 'var(--success, #16a34a)', info: 'var(--accent)' };
  return (
    <ToastContext.Provider value={toast}>
      {children}
      {toasts.length > 0 && (
        <div aria-live="polite" style={{ position: 'fixed', right: 16, zIndex: 1200, display: 'flex', flexDirection: 'column', gap: 8,
                                         maxWidth: 'min(420px, calc(100vw - 32px))',
                                         bottom: isMobile ? 'calc(var(--bottom-nav-total) + 12px)' : 16 }}>
          {toasts.map(t => (
            <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'}
                 onClick={() => setToasts(list => list.filter(x => x.id !== t.id))}
                 style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeft: `4px solid ${tone[t.kind]}`,
                          borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--text-primary)',
                          boxShadow: 'var(--shadow-lg)', cursor: 'pointer', animation: 'fadeUp 0.2s ease' }}>
              {t.text}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
