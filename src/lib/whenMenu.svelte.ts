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
  /** No moment up to this one (unix seconds) is offered: the reminder of a letter that leaves then. */
  notBefore?: number;
  /** The moment chosen, in unix seconds. */
  onpick: (at: number) => void;
  onnone: () => void;
  onsetup: () => void;
  /** The menu went away, whatever the way. */
  onclose: () => void;
}

// Behind functions: what a plugin may do with the menu is these calls, not the state.
const state = $state({
  /** The plugin that draws the menu is switched on. */
  available: false,
  request: null as WhenMenuRequest | null,
});

/** Whether somebody draws the menu now; a borrower without one has to do with its own form. */
export function whenMenuAvailable(): boolean {
  return state.available;
}

/** The plugin that draws the menu says it is there, and later that it is gone. */
export function provideWhenMenu(on: boolean) {
  state.available = on;
}

/** What is asked of the menu now; the drawing plugin reads it. */
export function whenMenuRequest(): WhenMenuRequest | null {
  return state.request;
}

/** Hangs the menu for `request`; the request it replaces is told it went away. */
export function openWhenMenu(request: WhenMenuRequest) {
  const old = state.request;
  state.request = request;
  old?.onclose();
}

export function closeWhenMenu() {
  state.request = null;
}
