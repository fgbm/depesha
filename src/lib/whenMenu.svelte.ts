// The menu that asks "when?" (the «Snooze» menu of #95) lent to other plugins by the core: the reminder
// of a letter in writing (#103) opens the same menu, with two rows more. The snooze plugin draws it
// (`available` says it is there); the plugin that asks only names where it hangs, what a chosen moment
// does and the words. Covered by the menu tests of the snooze plugin and the followups'.

import type { Anchor } from "./anchor";

/** Two rows under the moments of the menu: whether no choice is made now, and the words of both. */
export interface WhenExtras {
  none: boolean;
  noneLabel: string;
  setupLabel: string;
}

export interface WhenMenuRequest {
  anchor: Anchor;
  extras: WhenExtras;
  texts: { placeholder: string; title: string; pick: string };
  /** The moment chosen, in unix seconds. */
  onpick: (at: number) => void;
  onnone: () => void;
  onsetup: () => void;
  /** The menu went away, whatever the way. */
  onclose: () => void;
}

export const whenMenu = $state({
  /** The plugin that draws the menu is switched on. */
  available: false,
  request: null as WhenMenuRequest | null,
});

export function openWhenMenu(request: WhenMenuRequest) {
  whenMenu.request = request;
}

export function closeWhenMenu() {
  whenMenu.request = null;
}
