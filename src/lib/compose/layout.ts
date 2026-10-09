// The geometry of the composition window (#103): how much the text is guaranteed, how many
// attachments fit in the one-line strip, and how the strip behaves at full screen.
// Covered by layout.test.ts.

/** The field of the text never gets less than this; a window too low for the strips scrolls instead. */
export const MIN_BODY_PX = 160;

/** A chip of the strip is at most this wide, and the gap beside it: one slot of the line. */
export const CHIP_SLOT_PX = 186;

/** What the strip keeps for "+N more", the total and its own paddings. */
const STRIP_RESERVE_PX = 190;

/** How many of `count` attachments the one-line strip shows at `width`; the rest are behind "+N more". */
export function visibleChips(width: number, count: number): number {
  if (count <= 0) return 0;
  const fit = Math.floor((width - STRIP_RESERVE_PX) / CHIP_SLOT_PX);
  return Math.min(count, Math.max(1, fit));
}

/** The strip's rows at full screen: two rows, then its own scroll (decision 2.1, 4.2). */
export const FULL_STRIP_ROWS = 2;

/** The names a mailbox goes by in the title: its label, or the part of the address before «@». */
export function mailboxName(a: { label?: string | null; email: string }): string {
  return a.label?.trim() || a.email.split("@")[0];
}
