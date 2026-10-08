// The core's commands that have keys, or may get them, in one table: the handlers in
// App.svelte, MessageWindow.svelte and the composition window, the menus, the palette and
// the tooltips read the keys from here (through shortcuts.svelte.ts), and the «Keys» page
// lists them. Plugins add theirs with `ui.keybinding`. Covered by keyCommands.test.ts.

import type { Key } from "./i18n.svelte";
import type { Group, KeyCommand, Scope } from "./keymap";

export interface CoreKey extends Omit<KeyCommand, "owner"> {
  title: Key;
}

const row = (id: string, title: Key, keys: string[], group: Group, scope: Scope = group === "compose" ? "compose" : "main"): CoreKey => ({
  id,
  title,
  keys,
  scope,
  group,
});

export const CORE_KEYS: CoreKey[] = [
  // Anywhere in the main window outside text fields; Ctrl combinations from fields too.
  row("core.settings", "settings.title", ["Mod+,"], "everywhere"),
  // Quits for real whatever closing the window does; the backend asks first when letters wait.
  row("core.quit", "bg.quit", ["Mod+q"], "everywhere", "all"),
  row("core.compose", "cmd.compose", ["c"], "everywhere"),
  row("core.search", "cmd.search", ["/"], "everywhere"),
  row("core.undo", "keys.cmd.undo", ["z"], "everywhere"),
  row("core.sync", "cmd.sync", [], "everywhere"),
  // The list and the letter.
  row("core.next", "nav.next", ["j", "ArrowDown"], "list"),
  row("core.prev", "nav.prev", ["k", "ArrowUp"], "list"),
  row("core.select-all", "keys.cmd.selectAll", ["Mod+a"], "list"),
  row("core.reply", "act.reply", ["r"], "list"),
  row("core.reply-all", "cmd.replyAll", ["a"], "list"),
  row("core.forward", "act.forward", ["f"], "list"),
  row("core.archive", "cmd.done", ["e"], "list"),
  // Delete first: menus, the palette and tooltips show the first key.
  row("core.delete", "act.delete", ["Delete", "#"], "list"),
  row("core.spam", "act.spam", ["!"], "list"),
  row("core.unread", "keys.cmd.toggleRead", ["u"], "list"),
  row("core.flag", "cmd.flag", ["s"], "list"),
  // Labels (#42, frame 10): l is free; the Russian д sits on the same key.
  row("core.labels", "act.labels", ["l"], "list"),
  // The composition window: single keys type there, so only with Ctrl or Alt, and Esc.
  row("compose.send", "compose.send", ["Mod+Enter"], "compose"),
  row("compose.fold", "keys.cmd.fold", ["Escape"], "compose"),
  row("compose.save", "compose.saveDraft", ["Mod+s"], "compose"),
  row("compose.bold", "compose.format.bold", ["Mod+b"], "compose"),
  row("compose.italic", "compose.format.italic", ["Mod+i"], "compose"),
  row("compose.underline", "compose.format.underline", ["Mod+u"], "compose"),
  row("compose.link", "compose.format.link", ["Mod+l"], "compose"),
  row("compose.preview", "keys.cmd.preview", ["Mod+Shift+p"], "compose"),
  // Markdown only: they work when the letter is written in Markdown (frame 16 В of the mockup).
  row("compose.heading1", "compose.format.heading1", ["Mod+1"], "compose"),
  row("compose.heading2", "compose.format.heading2", ["Mod+2"], "compose"),
  row("compose.heading3", "compose.format.heading3", ["Mod+3"], "compose"),
  row("compose.code", "compose.format.code", ["Mod+e"], "compose"),
];
