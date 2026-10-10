// The menu that asks "when?" (the «Snooze» menu of #95) lent to other plugins by the core: the reminder
// of a letter in writing (#103) opens the same menu, with two rows more. The snooze plugin draws it
// (`available` says it is there); the plugin that asks only names where it hangs, what a chosen moment
// does and the words. Covered by the menu tests of the snooze plugin and the followups'.
//
// @experimental: not part of the v1 contract (#82). Two built-in plugins lend each other a service
// through the core here, which a contract between the core and a plugin should not be; it stays
// until plugins can offer each other services in a way the contract describes, and then it goes.

import type { Anchor } from "../lib/anchor";

/** @experimental Two rows under the moments of the menu: whether no choice is made now, and the words of both. */
export interface WhenExtras {
  none: boolean;
  noneLabel: string;
  setupLabel: string;
}

/** @experimental */
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

/** @experimental Whether somebody draws the menu now; a borrower without one has to do with its own form. */
export function whenMenuAvailable(): boolean {
  return state.available;
}

/** @experimental The plugin that draws the menu says it is there, and later that it is gone. */
export function provideWhenMenu(on: boolean) {
  state.available = on;
}

/** @experimental What is asked of the menu now; the drawing plugin reads it. */
export function whenMenuRequest(): WhenMenuRequest | null {
  return state.request;
}

/** @experimental Hangs the menu for `request`; the request it replaces is told it went away. */
export function openWhenMenu(request: WhenMenuRequest) {
  const old = state.request;
  state.request = request;
  old?.onclose();
}

/** @experimental */
export function closeWhenMenu() {
  state.request = null;
}
