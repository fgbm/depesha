// Where the frame and the panel of the picked picture are drawn over the editor. They lie outside
// the scrolled letter, so they are cut to the part of it in sight here, not by the letter's box
// (RichEditor.svelte): a tall picture scrolled half away must not push its frame over the fields above.

import type { Box, Placed } from "./lockedBlock";

export interface PicturePlace {
  /** The part of the letter in sight, in the editor's box: the frame is cut by it. */
  clip: Placed;
  /** The picture's frame, in the clip's box: it may stick out of the clip. */
  frame: Placed;
  /** The panel's top left corner in the editor's box. */
  bar: { left: number; top: number };
}

/** The gap between the picture's lower edge and its panel. */
export const BAR_GAP = 6;

/**
 * Places the frame and the panel of the picture `pic`, seen through `view` (the letter's scrolled
 * area, without its scrollbar), in the editor's box `wrap`. Nothing when the picture is out of
 * sight. The panel sits under the picture; when that edge is scrolled out of sight it sticks to
 * the bottom of `view`, so it is always there to be clicked while the picture shows.
 */
export function placePicture(pic: Box, view: Box, wrap: Box, barHeight: number): PicturePlace | null {
  if (pic.bottom <= view.top || pic.top >= view.bottom || pic.right <= view.left || pic.left >= view.right) return null;
  const barTop = Math.max(view.top, Math.min(pic.bottom + BAR_GAP, view.bottom - barHeight));
  return {
    clip: { left: view.left - wrap.left, top: view.top - wrap.top, width: view.right - view.left, height: view.bottom - view.top },
    frame: { left: pic.left - view.left, top: pic.top - view.top, width: pic.right - pic.left, height: pic.bottom - pic.top },
    bar: { left: Math.max(pic.left, view.left) - wrap.left, top: barTop - wrap.top },
  };
}
