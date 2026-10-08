import type { Anchor } from "@depesha/plugin-api";

/** `menu`: the open «Snooze» menu — for which messages and where it hangs. */
export const snooze = $state({ count: 0, menu: null as { ids: number[]; anchor: Anchor } | null });

export function openSnooze(ids: number[], anchor: Anchor) {
  if (ids.length) snooze.menu = { ids, anchor };
}

export function closeSnooze() {
  snooze.menu = null;
}
