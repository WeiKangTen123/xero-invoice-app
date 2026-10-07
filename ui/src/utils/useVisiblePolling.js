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
//
// `enabled` switches the whole thing off — no timer, no refresh on return — for
// a poll that only means something while some job is running. Turning it back
// on starts the clock again; it does not call `fn` at once, the same as on
// mount, so a caller that wants an immediate answer asks for it itself.
export function useVisiblePolling(fn, interval, enabled = true) {
  const fnRef       = useRef(fn);
  const intervalRef = useRef(interval);

  // Kept in refs so a caller passing an inline arrow does not tear down and
  // rebuild the timer on every render.
  useEffect(() => {
    fnRef.current       = fn;
    intervalRef.current = interval;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    let id = null;
    // A call still in flight. `fn` is awaited, so a slow request holds the next
    // one back rather than overlapping it: the period is measured from when the
    // last call finished, and a tab coming back into view while one is still
    // out does not send a second alongside it.
    let running = false;
    let stopped = false;
    const period = () => {
      const v = intervalRef.current;
      return typeof v === 'function' ? v() : v;
    };

    function stop() {
      if (id) { clearTimeout(id); id = null; }
    }
    async function run() {
      if (running) return;
      running = true;
      try { await fnRef.current(); }
      catch (_) { /* the caller owns its errors; a throw must not end the poll */ }
      finally { running = false; }
      schedule();
    }
    function schedule() {
      stop();
      if (stopped || document.hidden) return;
      id = setTimeout(run, period());
    }

    schedule();
    function onVisibility() {
      if (document.hidden) { stop(); return; }
      stop();
      run();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);
}
