import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client';
import { useVisiblePolling } from '../utils/useVisiblePolling';

const PipelineContext = createContext(null);

export function PipelineProvider({ children }) {
  const [status, setStatus] = useState(null);
  const statusRef = useRef(null);

  const refresh = useCallback(async () => {
    // Only poll when authenticated; avoid triggering 401s on public routes like /capture/:token
    if (!localStorage.getItem('token') || window.location.pathname.startsWith('/capture')) {
      return null;
    }
    try {
      const s = await api.get('/process/status');
      setStatus(s);
      statusRef.current = s;
      return s;
    } catch (_) { return null; }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // Every 3 s while the queue is busy, 15 s when idle, nothing while the tab
  // is hidden; the hook refreshes at once when the tab is shown again. A send
  // to Xero in progress counts as busy too: the AR & AP list refreshes when
  // these counts move, and "Send all" otherwise took up to 15 s per step to
  // show each document arrive.
  useVisiblePolling(refresh, () => {
    const s = statusRef.current;
    const q = s?.queue;
    return (q?.processing > 0 || q?.pending > 0 || s?.xero?.submitting > 0) ? 3000 : 15000;
  });

  return (
    <PipelineContext.Provider value={{ status, refresh }}>
      {children}
    </PipelineContext.Provider>
  );
}

export function usePipeline() {
  return useContext(PipelineContext);
}
