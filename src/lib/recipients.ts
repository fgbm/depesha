// A long list of recipients folds in the letter's header, as in Outlook and Thunderbird:
// the first few by name and "N more", so the letter's text stays on the first screen.

import type { Addr } from "./types";

/** More recipients than this in To and Cc together fold; the send check warns past ten too. */
export const FOLD_OVER = 10;
/** A folded line names this many. */
export const FOLD_SHOW = 3;

/** The header shows To and Cc folded. */
export function foldsRecipients(to: Addr[], cc: Addr[]): boolean {
  return to.length + cc.length > FOLD_OVER;
}

/** A folded line: the recipients it names and how many it leaves out. */
export function foldLine(addrs: Addr[]): { shown: Addr[]; more: number } {
  const shown = addrs.slice(0, FOLD_SHOW);
  return { shown, more: addrs.length - shown.length };
}
