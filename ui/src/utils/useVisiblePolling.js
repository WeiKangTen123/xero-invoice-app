import { useEffect, useRef } from 'react';

// Repeatedly calls `fn`, but only while the tab is actually being looked at.
//
// A bare setInterval keeps firing in a backgrounded tab forever, which on a
// phone left open on a page means a request or a re-render every few seconds
// all day for a screen nobody can see. This stops on `visibilitychange` and
// picks up again on return — and refreshes immediately when it does, since
// whatever is on screen after a spell in the background is stale by definition.
//
// `interval` may be a number or a function returning one, so a caller can back
// off when idle and tighten up when something is in flight.
export function useVisiblePolling(fn, interval) {
  const fnRef       = useRef(fn);
  const intervalRef = useRef(interval);

  // Kept in refs so a caller passing an inline arrow does not tear down and
  // rebuild the timer on every render.
  useEffect(() => {
    fnRef.current       = fn;
    intervalRef.current = interval;
  });

  useEffect(() => {
    let id = null;
    const period = () => {
      const v = intervalRef.current;
      return typeof v === 'function' ? v() : v;
    };

    function stop() {
      if (id) { clearTimeout(id); id = null; }
    }
    // setTimeout rather than setInterval so the delay is re-read each cycle and
    // a slow call cannot stack up behind itself.
    function schedule() {
      stop();
      if (document.hidden) return;
      id = setTimeout(() => { fnRef.current(); schedule(); }, period());
    }

    schedule();
    function onVisibility() {
      if (document.hidden) { stop(); return; }
      fnRef.current();
      schedule();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
