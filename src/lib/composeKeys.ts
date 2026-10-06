// The keys of the composition window, in one table: the handlers and the tooltips read
// them from here. Ctrl+K is not among them: it opens the command palette everywhere.
// Covered by composeKeys.test.ts.

import { shortcutKeys, type KeyPress } from "./keys";

/** Action → key, as plugins name keys: "Mod+" is Ctrl (Cmd on macOS), letters by their US key. */
export const COMPOSE_KEYS = {
  send: "Mod+Enter",
  fold: "Escape",
  save: "Mod+s",
  bold: "Mod+b",
  italic: "Mod+i",
  underline: "Mod+u",
  link: "Mod+l",
  preview: "Mod+Shift+p",
} as const;

export type ComposeAction = keyof typeof COMPOSE_KEYS;

/** The names a press may go by: "Mod+Shift+p"; on the Russian layout Ctrl+Д is also "Mod+l". */
function names(e: KeyPress): string[] {
  const mods = (e.ctrlKey || e.metaKey ? "Mod+" : "") + (e.shiftKey ? "Shift+" : "") + (e.altKey ? "Alt+" : "");
  return shortcutKeys(e).map((k) => mods + k);
}

/** The action of the composition window this press stands for, if any. */
export function composeAction(e: KeyPress): ComposeAction | null {
  const pressed = names(e);
  for (const [action, key] of Object.entries(COMPOSE_KEYS)) {
    if (pressed.includes(key)) return action as ComposeAction;
  }
  return null;
}

/** The key as a tooltip shows it: "Ctrl+Shift+P". */
export function keyLabel(action: ComposeAction): string {
  return COMPOSE_KEYS[action]
    .split("+")
    .map((part) => (part === "Mod" ? "Ctrl" : part.length === 1 ? part.toUpperCase() : part))
    .join("+");
}
