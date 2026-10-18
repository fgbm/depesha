// The keys a letter's frame stops by itself (#124). Its relay has to decide during the press
// whether the page keeps the key's own meaning — scroll, selection, print — and the app's answer
// comes through `postMessage`, one turn too late for a default action. So the app tells the frame
// ahead of time which keys it takes, in the shortcut layer's own names (keymap.ts): a key moved in
// Settings → Keys moves here too. Covered by frameKeys.test.ts.

import { MAIN_ONLY } from "./commands";
import type { FrameKey } from "./frameRelay";
import { frameKey } from "./keymap";
import { layout } from "./layout.svelte";
import { shortcuts } from "./shortcuts.svelte";
import { app } from "./store.svelte";

/** The keys a viewer of a letter takes on top of the window's own (#124): its arrows, its save. */
export const VIEWER_TAKES = ["ArrowLeft", "ArrowRight", "Mod+s"];

/**
 * The keys the app may take from a letter's frame open here, as the relay matches a press. `extra`
 * is what the surroundings take besides the shortcut table (VIEWER_TAKES).
 */
export function frameTakes(extra: string[] = []): FrameKey[] {
  const r = shortcuts.resolved();
  const main = app.windowOf === null;
  // The main window takes them all. A letter's own window runs neither «Select all» — there Ctrl+A
  // selects the text of the letter (App.svelte) — nor what the list of the main window owns
  // (MAIN_ONLY): those keys keep their meaning for the page.
  const names = shortcuts
    .commands()
    .filter((c) => (c.scope === "main" || c.scope === "all") && (main || (c.id !== "core.select-all" && !MAIN_ONLY.test(c.id))))
    .flatMap((c) => r.keys[c.id] ?? []);
  // Enter: the one column of a narrow window takes the letter with it, as App.svelte's Enter does.
  const narrow = layout.single && app.selection.selected.size === 1;
  return [...new Set([...names, ...(narrow ? ["Enter"] : []), ...extra])].map(frameKey).filter((k) => k !== null);
}
