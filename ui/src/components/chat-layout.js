// Where the Invoice Assistant sits and how wide it is, and how a cell of a
// table in one of its replies wraps. No imports, so main/scripts/chat-ui.test.js
// can load the file whole and run it (there is no React test setup here).

// At this window width and up the open chat is a column beside the page, and
// the page makes room for it; below, it floats over the page as it always
// did; on a phone it is the whole screen.
export const DOCK_MIN_VIEWPORT   = 1280;
export const CHAT_WIDTH          = 440;
// The ⤢ toggle in the chat's header, for a wide table; docked only.
export const CHAT_WIDTH_EXPANDED = 720;
// Where the ⤢ choice is remembered, on this browser.
export const EXPANDED_KEY        = 'xero_chat_expanded';

// { mode: 'closed' | 'docked' | 'overlay' | 'fullscreen', width }: width in px
// ('100vw' on a phone), and 0 when closed, which is also the room the page
// keeps for it then.
export function chatMode({ open, isMobile, viewportWidth, expanded } = {}) {
  if (!open) return { mode: 'closed', width: 0 };
  if (isMobile) return { mode: 'fullscreen', width: '100vw' };
  if (Number(viewportWidth) >= DOCK_MIN_VIEWPORT) {
    return { mode: 'docked', width: expanded ? CHAT_WIDTH_EXPANDED : CHAT_WIDTH };
  }
  return { mode: 'overlay', width: CHAT_WIDTH };
}

// A table cell's kind, from its text: 'num' (an amount, a count, a
// percentage: right-aligned, one line), 'short' (a date, a reference, a name:
// one line) or 'long' (a sentence: wraps, but never thinner than a few words).
// An invoice reference such as "INV-001" is not a number.
const NUMBER_RE = /^[(−+-]?\s*(?:[A-Z]{3}\s|[A-Z]{0,2}[$€£¥₹]\s?)?[(−+-]?\d[\d,.\s]*%?\)?(?:\s[A-Z]{3})?$/;
export const SHORT_CELL = 24;

export function cellKind(text) {
  const t = String(text ?? '').trim();
  if (NUMBER_RE.test(t)) return 'num';
  return t.length <= SHORT_CELL ? 'short' : 'long';
}
