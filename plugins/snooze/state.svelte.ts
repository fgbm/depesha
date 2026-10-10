import type { Anchor } from "@depesha/plugin-api";

const COUNT_KEY = "depesha.snooze.count";

/**
 * The count the last run ended with. The sidebar's row waits for the count, and a count that comes
 * from the backend after the first frame pushes the folder tree down under the pointer (#158).
 */
function lastCount(): number {
  try {
    const n = Number(localStorage.getItem(COUNT_KEY));
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    // An unreadable or broken stored value starts from nothing.
    return 0;
  }
}

/** `count`: letters snoozed; `menu`: the open «Snooze» menu — for which messages and where it hangs. */
export const snooze = $state({ count: lastCount(), menu: null as { ids: number[]; anchor: Anchor } | null });

/** What the backend reports; kept for the next launch. */
export function setCount(n: number) {
  snooze.count = n;
  try {
    localStorage.setItem(COUNT_KEY, String(n));
  } catch {
    // A storage that refuses only costs the next launch its early row.
  }
}

export function openSnooze(ids: number[], anchor: Anchor) {
  if (ids.length) snooze.menu = { ids, anchor };
}

export function closeSnooze() {
  snooze.menu = null;
}
