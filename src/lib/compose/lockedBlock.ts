// Where the locked block of a letter (its signature) is drawn over the editor: the tint that
// marks it pointed at and the bar with its menu. Both lie outside the scrolled letter, so they
// are fitted to the part of it in sight here, not cut by the letter's box (RichEditor.svelte).

/** A rectangle on the screen, as `getBoundingClientRect` gives it. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A rectangle laid inside another one: offsets from its top left corner. */
export interface Placed {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BlockPlace {
  /** The part of the letter in sight, in the editor's own box: the tint is cut by it. */
  clip: Placed;
  /** The block itself, in the clip's box: it may stick out of the clip. */
  hover: Placed;
  /** The bar's corner in the editor's box: its right edge and its top. */
  bar: { right: number; top: number };
}

/** The part of a scrolled box that shows its content: without its border and scrollbar. */
export function inSight(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  const left = r.left + el.clientLeft;
  const top = r.top + el.clientTop;
  return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight };
}

/** How far above the block's top edge the bar's top goes: it sits across that edge. */
export const BAR_LIFT = 11;

/**
 * Places the tint and the bar of a block `block`, seen through `view` (the letter's scrolled
 * area, without its scrollbar), in the editor's box `wrap`. Nothing when the block is out of
 * sight. The bar sits across the block's top edge; when that edge is scrolled away it goes to
 * the bottom of the block's part in sight, and it never leaves `view`: it is always there to be
 * clicked.
 */
export function placeLockedBlock(block: Box, view: Box, wrap: Box, barHeight: number): BlockPlace | null {
  const top = Math.max(block.top, view.top);
  const bottom = Math.min(block.bottom, view.bottom);
  if (bottom <= top || block.right <= view.left || block.left >= view.right) return null;
  let barTop = block.top - BAR_LIFT;
  if (barTop < view.top) barTop = bottom - barHeight + BAR_LIFT;
  barTop = Math.max(view.top, Math.min(barTop, view.bottom - barHeight));
  return {
    clip: { left: view.left - wrap.left, top: view.top - wrap.top, width: view.right - view.left, height: view.bottom - view.top },
    hover: { left: block.left - view.left, top: block.top - view.top, width: block.right - block.left, height: block.bottom - block.top },
    bar: { right: wrap.right - Math.min(block.right, view.right), top: barTop - wrap.top },
  };
}
