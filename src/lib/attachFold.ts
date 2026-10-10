// The attachments of an opened letter (the reading pane and the letter's own window): at most
// two rows of chips, the rest behind «+N more» (decision "many attachments", 2026-10-10; the
// same fold as the composition window's strip, #103 2.1). Covered by attachFold.test.ts.

/** The strip never grows past this many rows of chips. */
export const STRIP_ROWS = 2;

/** The gap between two chips, across and down. */
export const CHIP_GAP_PX = 6;

/** What «+N more ›» keeps free at the end of the last row. */
export const MORE_RESERVE_PX = 96;

/** What «Save all» keeps free at the end of the last row when nothing is folded. */
export const SAVE_ALL_RESERVE_PX = 124;

/** The rows and the place left on the last one after the widths are laid out like a wrapping line. */
function lay(widths: number[], avail: number): { rows: number; used: number } {
  let rows = 1;
  let used = 0;
  for (const raw of widths) {
    const w = Math.min(raw, avail);
    const next = used ? used + CHIP_GAP_PX + w : w;
    if (used && next > avail) {
      rows++;
      used = w;
    } else {
      used = next;
    }
  }
  return { rows, used };
}

/**
 * How many of the chips (of the given widths) the strip shows in `rows` rows of `avail` px;
 * the rest are behind «+N more». `widths.length` when everything fits together with the
 * «Save all» button, so nothing is folded then. At least one chip is always in sight.
 */
export function foldChips(widths: number[], avail: number, rows = STRIP_ROWS): number {
  const n = widths.length;
  if (n === 0 || avail <= 0) return n;
  if (lay([...widths, SAVE_ALL_RESERVE_PX], avail).rows <= rows) return n;
  for (let k = n - 1; k > 1; k--) {
    if (lay([...widths.slice(0, k), MORE_RESERVE_PX], avail).rows <= rows) return k;
  }
  return 1;
}
