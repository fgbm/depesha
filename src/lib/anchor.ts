// Where a menu hangs. A menu opened by a key has no pointer to follow: it opens at the
// selected row of the list (#96) — under it, or over it when there is no room below. A menu
// opened with the mouse hangs on the button clicked, a context menu on the pointer; every
// one of them is an `Anchor` and `placeMenu` finds the room for it. Pure but for `keyAnchor`.

/** A point of the window; `h` is the height of the thing the menu hangs on (a row, a button), 0 for a bare point. */
export interface Anchor {
  x: number;
  y: number;
  h?: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Placed {
  left: number;
  top: number;
  /** The room left on the side the menu opened to; a taller menu scrolls. */
  maxHeight: number;
  /** Under the anchor, not over it. */
  below: boolean;
}

export const GAP = 4;
export const MARGIN = 8;

/** The anchor of a rectangle: its left edge, a little in, and its height. */
export function anchorOf(r: { left: number; top: number; height: number }, inset = 16): Anchor {
  return { x: Math.round(r.left + inset), y: Math.round(r.top), h: Math.round(r.height) };
}

/**
 * Under the anchor when the menu fits there, otherwise on the side with more room; to the
 * right of `x`, to its left near the window's edge. A bare point (no `h`) touches the menu.
 */
export function placeMenu(anchor: Anchor, size: Size, win: Size): Placed {
  const h = anchor.h ?? 0;
  const gap = h ? GAP : 0;
  const bottom = anchor.y + h;
  const roomBelow = win.h - bottom - gap - MARGIN;
  const roomAbove = anchor.y - gap - MARGIN;
  const below = size.h <= roomBelow || roomBelow >= roomAbove;
  const maxHeight = Math.max(80, below ? roomBelow : roomAbove);
  const top = below ? bottom + gap : anchor.y - gap - Math.min(size.h, maxHeight);
  const want = anchor.x + size.w + MARGIN > win.w ? anchor.x - size.w : anchor.x;
  const left = Math.min(Math.max(MARGIN, want), win.w - size.w - MARGIN);
  return { left, top, maxHeight, below };
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A menu beside its parent, level with it: to the right, to the left when the window ends
 * there, and kept inside the window. The parent stays in sight.
 */
export function placeSide(parent: Box, size: Size, win: Size): { left: number; top: number; maxHeight: number } {
  const maxHeight = win.h - 2 * MARGIN;
  const right = parent.right + GAP;
  const left = right + size.w + MARGIN <= win.w ? right : Math.max(MARGIN, parent.left - GAP - size.w);
  const top = Math.max(MARGIN, Math.min(parent.top - GAP, win.h - MARGIN - Math.min(size.h, maxHeight)));
  return { left, top, maxHeight };
}

/** The row a key acts on: the one with the cursor (a single selected letter has no other
 *  mark, #108), else a chosen one. */
export function currentRow(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(".row.cursor") ?? root.querySelector<HTMLElement>(".row.selected");
}

/**
 * Where a menu opened by a key hangs: the selected row of the list, or the middle of the
 * window when no row is on screen (the list scrolls, only the rows in view are drawn).
 */
export function keyAnchor(doc: ParentNode = document, win: Size = { w: window.innerWidth, h: window.innerHeight }): Anchor {
  const row = currentRow(doc);
  return row ? anchorOf(row.getBoundingClientRect()) : { x: Math.round(win.w / 2 - 120), y: 120 };
}
