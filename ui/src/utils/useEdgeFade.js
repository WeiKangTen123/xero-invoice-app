import { useState, useRef, useEffect, useCallback } from 'react';

// Reports which ends of a horizontal scroller have more content past them, so a
// caller can fade that edge.
//
// .mobile-scroll-x hides its scrollbar, which looks clean but removes the only
// signal that a strip scrolls at all — the dashboard's nine tabs showed about
// three on a phone with nothing to suggest the other six existed. The fade has
// to be per-edge and live, or it ends up pointing at content that isn't there
// once you reach the end.
//
// Returns [ref, { start, end }]: attach the ref to the scrolling element and
// render a gradient over whichever edge is true.
export function useEdgeFade() {
  const ref = useRef(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // 1px of slack: sub-pixel layout means scrollLeft rarely hits max exactly.
    setEdges({ start: el.scrollLeft > 1, end: max > 1 && el.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    update();
    el.addEventListener('scroll', update, { passive: true });
    // The strip's overflow changes with the viewport and with its own contents,
    // neither of which fires a scroll event.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [update]);

  return [ref, edges];
}
