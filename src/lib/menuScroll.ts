// A menu's own scroll to a row. `focus()` would scroll the ancestors too, and a scrolled ancestor
// closes the menu (Popover), so the row is focused without scrolling and the list is scrolled by hand.

/** The list's scrollTop that shows the row: as it is when the row is in view, else the row in the middle. */
export function scrollToRow(r: { top: number; height: number; scrollTop: number; viewHeight: number }): number {
  if (r.top >= r.scrollTop && r.top + r.height <= r.scrollTop + r.viewHeight) return r.scrollTop;
  return Math.max(0, r.top - r.viewHeight / 2 + r.height / 2);
}
