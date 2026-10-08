// The keys in force: the core's table (keyCommands.ts), the plugins' keys and the user's
// own (Settings → Keys), put together by keymap.ts. Every handler, menu, tooltip and the
// palette asks here, so a changed key shows everywhere at once. Covered by shortcuts.test.ts.

import { registry } from "../plugin-host/registry.svelte";
import { i18n, t } from "./i18n.svelte";
import { CORE_KEYS } from "./keyCommands";
import { findCommand, keyText, PALETTE_KEY, pressNames, resolve, type Custom, type KeyCommand, type KeyPress, type Lost, type Resolved } from "./keymap";
import type { KeySettings } from "./types";

export interface TitledCommand extends KeyCommand {
  title: () => string;
}

/** A command of the palette without a key of its own in any table. */
export interface OtherCommand {
  id: string;
  title: () => string;
}

const EMPTY: KeySettings = { custom: {}, dismissed: [] };

const other = (id: string, title: () => string): TitledCommand => ({
  id,
  title,
  keys: [],
  scope: "main",
  group: "other",
  owner: id.startsWith("core.") ? "core" : "other",
});

class Shortcuts {
  private source: () => KeySettings | undefined = () => undefined;

  /** Where the user's keys are read from: the settings. */
  use(source: () => KeySettings | undefined) {
    this.source = source;
  }

  saved(): KeySettings {
    return this.source() ?? EMPTY;
  }

  /**
   * The commands with keys: the core's, the plugins' and, given `others`, the rest of the
   * palette; a command the user gave a key to stays even when nobody offers it now.
   */
  commands(others: OtherCommand[] = [], custom: Custom = this.saved().custom): TitledCommand[] {
    const list: TitledCommand[] = CORE_KEYS.map((c) => ({ ...c, owner: "core", title: () => t(c.title) }));
    for (const { owner, item } of registry.lists.keybindings) {
      // A plugin carrying out a core key (`core.release`) adds no command of its own.
      if (list.some((c) => c.id === item.id)) continue;
      // Ctrl+K is the palette's, in the composition window too, and is not reassigned.
      const palette = item.key === PALETTE_KEY;
      list.push({
        id: item.id,
        title: item.title,
        keys: item.key ? [item.key] : [],
        scope: palette ? "all" : "main",
        group: palette || item.where === "everywhere" ? "everywhere" : "list",
        owner,
        locked: palette,
      });
    }
    const known = new Set(list.map((c) => c.id));
    for (const o of others) {
      if (!known.has(o.id)) list.push(other(o.id, o.title));
      known.add(o.id);
    }
    for (const id of Object.keys(custom)) if (!known.has(id)) list.push(other(id, () => id));
    return list;
  }

  command(id: string | undefined): TitledCommand | undefined {
    return id === undefined ? undefined : this.commands().find((c) => c.id === id);
  }

  resolved(): Resolved {
    return resolve(this.commands(), this.saved().custom);
  }

  keys(id: string): string[] {
    return this.resolved().keys[id] ?? [];
  }

  /** The key menus and tooltips show: the first one. */
  key(id: string): string | undefined {
    return this.keys(id)[0];
  }

  /** "e/у", or nothing for a command without a key. */
  hint(id: string): string {
    const k = this.key(id);
    return k ? keyText(k, i18n.lang) : "";
  }

  /** A tooltip with the command's key: "Reply (r)"; without a key, the text alone. */
  titled(text: string, id: string): string {
    const h = this.hint(id);
    return h ? `${text} (${h})` : text;
  }

  /** The command a press runs in the main window or in the composition window. */
  find(e: KeyPress, where: "main" | "compose"): string | undefined {
    const cmds = this.commands();
    return findCommand(resolve(cmds, this.saved().custom), cmds, pressNames(e), where === "main" ? ["main", "all"] : ["compose", "all"]);
  }

  /** Plugins' default keys taken by someone else, whose notice was not seen yet. */
  lost(custom: Custom = this.saved().custom, dismissed: string[] = this.saved().dismissed): Lost[] {
    const cmds = this.commands([], custom);
    return resolve(cmds, custom).lost.filter((l) => cmds.find((c) => c.id === l.id)?.owner !== "core" && !dismissed.includes(`${l.id}:${l.key}`));
  }
}

export const shortcuts = new Shortcuts();
