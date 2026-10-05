// The table of contents over a page of sections: which one the reader is in.

/** Below the top edge by this much a section already counts as reached. */
export const REACHED = 24;

/**
 * The section being read: the last one whose top has reached the top of the view.
 * At the very bottom it is the last section, short as it may be: it cannot be scrolled higher.
 * `tops` are the sections' offsets in the scrolled content, in order.
 */
export function currentSection(tops: number[], scrollTop: number, atBottom: boolean): number {
  if (!tops.length) return -1;
  if (atBottom) return tops.length - 1;
  let current = 0;
  tops.forEach((top, i) => {
    if (top <= scrollTop + REACHED) current = i;
  });
  return current;
}
