import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client';

const PipelineContext = createContext(null);

export function PipelineProvider({ children }) {
  const [status, setStatus] = useState(null);
  const statusRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/process/status');
      setStatus(s);
      statusRef.current = s;
    } catch (_) {}
  }, []);

  useEffect(() => {
    refresh();

    let id = null;
    function getInterval() {
      const q = statusRef.current?.queue;
      return (q?.processing > 0 || q?.pending > 0) ? 3000 : 15000;
    }
    function schedule() {
      if (id) clearInterval(id);
      if (document.hidden) { id = null; return; }
      id = setInterval(() => { refresh(); schedule(); }, getInterval());
    }
    schedule();
    const onVis = () => document.hidden ? (clearInterval(id), id = null) : schedule();
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  return (
    <PipelineContext.Provider value={{ status, refresh }}>
      {children}
    </PipelineContext.Provider>
  );
}

export function usePipeline() {
  return useContext(PipelineContext);
}
