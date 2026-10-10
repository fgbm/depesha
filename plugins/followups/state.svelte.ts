const COUNTS_KEY = "depesha.followups.counts";

/**
 * The counts the last run ended with. The sidebar's row waits for them, and counts that come from
 * the backend after the first frame push the folder tree down under the pointer (#158).
 */
function lastCounts(): { count: number; closed: number } {
  const none = { count: 0, closed: 0 };
  try {
    const v = JSON.parse(localStorage.getItem(COUNTS_KEY) ?? "null");
    const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;
    return v ? { count: ok(v.count) ? v.count : 0, closed: ok(v.closed) ? v.closed : 0 } : none;
  } catch {
    return none;
  }
}

/**
 * The plugin's state shared by its parts. `count`: letters waiting; `closed`: waits kept
 * after they ended; `tab`: what the view shows; `repick`: the letter "Set a new date" or
 * "Wait for a reply again" was asked for, and how to show the new date on it.
 */
export const followups = $state<{
  count: number;
  closed: number;
  tab: "active" | "closed";
  repick: { id: number; set: (due: number) => void } | null;
}>({ ...lastCounts(), tab: "active", repick: null });

/** What the backend reports; kept for the next launch. */
export function setCounts(count: number, closed: number) {
  followups.count = count;
  followups.closed = closed;
  try {
    localStorage.setItem(COUNTS_KEY, JSON.stringify({ count, closed }));
  } catch {
    // A storage that refuses only costs the next launch its early row.
  }
}
