import type { Anchor } from "@depesha/plugin-api";

/** A menu clicked open hangs on the button: its left edge, under it. */
export function anchorOfButton(button: HTMLElement): Anchor {
  const r = button.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height) };
}

/** The reader's «Snooze» button, where a letter's own window has no list to hang the menu on. */
export function readerButtonAnchor(): Anchor | null {
  const button = document.querySelector<HTMLElement>("[data-snooze-button]");
  return button ? anchorOfButton(button) : null;
}
