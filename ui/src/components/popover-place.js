// Where a list opened from a field is drawn. The list is drawn at the top of
// the page (a portal into <body>, position: fixed), not inside the field's
// card: every Setup card keeps the transform its fadeUp animation ends on,
// which makes each card a layer of its own, and a list inside one was drawn
// under every card after it. Pure, with no imports, so it can be run where
// the page cannot be rendered (main/scripts/popover-place-ui.test.js).

// The gap between the field and the list, the list's tallest, the least it is
// worth opening at, and the room kept from the window's edge.
export const GAP = 5;
export const MAX_HEIGHT = 320;
export const MIN_HEIGHT = 140;
export const EDGE = 8;

// `rect` is the field's getBoundingClientRect(); `viewportHeight` the
// window's inner height. Below the field when the whole list fits there, or
// when there is at least as much room below as above; above it otherwise.
// The list is never taller than the room on its side, and never shorter than
// MIN_HEIGHT, which scrolls the window rather than leave a list too short to
// use. `up` lists open with their bottom edge on the field's top, so their
// position is given as `bottom` (from the window's bottom edge).
export function placePopover(rect, viewportHeight) {
  const below = viewportHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const up = below < MAX_HEIGHT && above > below;
  const room = up ? above : below;
  const maxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.floor(room)));
  return {
    up,
    left: rect.left,
    width: rect.width,
    top: up ? null : rect.bottom + GAP,
    bottom: up ? viewportHeight - rect.top + GAP : null,
    maxHeight,
  };
}

// Whether the field has left the window: a list left hanging over another
// part of the page is closed instead.
export function fieldOffScreen(rect, viewportHeight) {
  return rect.bottom < 0 || rect.top > viewportHeight;
}
