// The keys of the composition window: the handlers and the tooltips ask here. The keys
// themselves are in the table of all commands (keyCommands.ts), where the user may change
// them. Ctrl+K is not among them: it opens the command palette everywhere.
// Covered by composeKeys.test.ts and shortcuts.test.ts.

import { keyText } from "./keymap";
import type { KeyPress } from "./keymap";
import { shortcuts } from "./shortcuts.svelte";

export type ComposeAction = "send" | "fold" | "save" | "bold" | "italic" | "underline" | "link" | "preview";

/** The action of the composition window this press stands for, if any. */
export function composeAction(e: KeyPress): ComposeAction | null {
  const id = shortcuts.find(e, "compose");
  return id?.startsWith("compose.") ? (id.slice(8) as ComposeAction) : null;
}

/** The key as a tooltip shows it: "Ctrl+Shift+P"; empty for an action without a key. */
export function keyLabel(action: ComposeAction): string {
  const k = shortcuts.key(`compose.${action}`);
  return k ? keyText(k, "en") : "";
}
