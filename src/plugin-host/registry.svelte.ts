// What plugins have contributed, by owner. The core renders from here; switching a
// plugin off removes everything it owns. No imports of the app store: the store reads
// this registry, the host (host.svelte.ts) writes it.

import type { Component } from "svelte";
import type { FileViewer } from "../lib/viewer";
import type { Banner, Command, KeyBinding, ComposeContext, ComposeDraft, ListFilter, MessageAction, MessageRow, OpenedMessage, PluginContext, Rendered, RowAction, RowTag, View } from "../plugin-api";

export interface Owned<T> {
  owner: string;
  item: T;
}

export type Keybinding = KeyBinding;

export interface ComposeControl {
  component: Component<{ compose: ComposeContext; ctx: PluginContext }>;
  props: { ctx: PluginContext };
  order?: number;
  /** `send`: joined to the Send button; `footer` (default): after it; `line`: a quiet line above the buttons; `from`: in the "From" row. */
  slot?: "send" | "footer" | "line" | "from";
}

export interface SettingsSection {
  title: () => string;
  component: Component<{ ctx: PluginContext }>;
  props: { ctx: PluginContext };
}

interface Lists {
  commands: Owned<Command>[];
  keybindings: Owned<Keybinding>[];
  readerToolbar: Owned<Rendered>[];
  bulkToolbar: Owned<Rendered>[];
  readerHeader: Owned<Rendered>[];
  messageActions: Owned<MessageAction>[];
  rowActions: Owned<RowAction>[];
  banners: Owned<(msg: OpenedMessage) => Banner | null>[];
  rowTags: Owned<(row: MessageRow) => RowTag | null>[];
  views: Owned<View>[];
  listFilters: Owned<ListFilter>[];
  composeControls: Owned<ComposeControl>[];
  sendChecks: Owned<(draft: ComposeDraft, accountEmail: string) => string[]>[];
  settingsSections: Owned<SettingsSection>[];
  overlays: Owned<Rendered>[];
  /** Renderers of the attachment viewer; the core's are owned by "core". */
  fileViewers: Owned<FileViewer>[];
}

const empty = (): Lists => ({
  commands: [],
  keybindings: [],
  readerToolbar: [],
  bulkToolbar: [],
  readerHeader: [],
  messageActions: [],
  rowActions: [],
  banners: [],
  rowTags: [],
  views: [],
  listFilters: [],
  composeControls: [],
  sendChecks: [],
  settingsSections: [],
  overlays: [],
  fileViewers: [],
});

class Registry {
  // Raw state: lists are replaced, never mutated, and items hold components and functions.
  lists = $state.raw<Lists>(empty());

  add<K extends keyof Lists>(kind: K, owner: string, item: Lists[K][number]["item"]) {
    this.lists = { ...this.lists, [kind]: [...this.lists[kind], { owner, item }] };
  }

  removeOwner(owner: string) {
    const next = { ...this.lists };
    for (const k of Object.keys(next) as (keyof Lists)[]) {
      (next[k] as Owned<unknown>[]) = (next[k] as Owned<unknown>[]).filter((e) => e.owner !== owner);
    }
    this.lists = next;
  }

  items<K extends keyof Lists>(kind: K): Lists[K][number]["item"][] {
    return this.lists[kind].map((e) => e.item);
  }

  view(id: string): View | undefined {
    return this.lists.views.find((v) => v.item.id === id)?.item;
  }

  /** Banners, row tags and similar providers: a plugin that throws only loses its own. */
  collect<T, A>(kind: "banners" | "rowTags", arg: A): T[] {
    const out: T[] = [];
    for (const e of this.lists[kind] as Owned<(a: A) => T | null>[]) {
      try {
        const v = e.item(arg);
        if (v) out.push(v);
      } catch (err) {
        console.error(`plugin ${e.owner}:`, err);
      }
    }
    return out;
  }
}

export const registry = new Registry();
