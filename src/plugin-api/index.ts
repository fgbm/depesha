// The contract between Depesha's core and its plugins. A plugin imports from here and
// nowhere else in the app (plugin-api/boundary.test.ts checks it), so it can later move
// to its own repository. Everything a plugin adds goes through `PluginContext.ui` and is
// removed by the core when the plugin is switched off.

import type { Component } from "svelte";
import type { ComposeDraft, FolderInfo, ListQuery, MessageRow, Moved, OpenedMessage } from "../lib/types";

export type { ComposeDraft, FolderInfo, ListQuery, MessageRow, Moved, OpenedMessage };
export { default as Popover } from "../components/Popover.svelte";
export { default as LaterMenu } from "../components/LaterMenu.svelte";
export { default as Select } from "../components/Select.svelte";
export { sendLaterPresets, snoozePresets, when, type Preset } from "../lib/later";
export { addrName, listDate, matches, size } from "../lib/format";

export type Lang = "en" | "ru";

/** Text in the interface languages; plugins carry their own strings. */
export interface Text {
  en: string;
  ru: string;
}

/** Plural forms by Intl.PluralRules category; `other` is required. */
export interface PluralForms {
  one?: string;
  few?: string;
  many?: string;
  other: string;
}

export interface PluginManifest {
  id: string;
  name: Text;
  description: Text;
}

export interface Plugin {
  manifest: PluginManifest;
  /** Registers contributions; whatever it registers is undone when the plugin is switched off. */
  activate(ctx: PluginContext): void | (() => void);
}

/** A component with the props to render it. Props are the plugin's business, hence `any`. */
export interface Rendered {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: Component<any>;
  props?: Record<string, unknown>;
}

export interface Command {
  id: string;
  title: () => string;
  /** Shown next to the title, e.g. "h". */
  hint?: () => string;
  /** Offered only when this holds. */
  when?: () => boolean;
  run: () => void;
}

export interface MessageAction {
  id: string;
  title: () => string;
  icon?: Component;
  hint?: string;
  when?: (msg: OpenedMessage) => boolean;
  run: (msg: OpenedMessage) => void;
}

export interface Banner {
  text: string;
  tone?: "info" | "warn";
  icon?: Component;
  actions?: { title: string; run: () => void; primary?: boolean }[];
}

export interface RowTag {
  icon?: Component;
  text: string;
  title?: string;
  alert?: boolean;
}

/** A list view of its own, e.g. "Snoozed": a sidebar entry and a query. */
export interface View {
  id: string;
  title: () => string;
  icon: Component;
  /** Sidebar badge; the entry is hidden while it returns 0. */
  count: () => number;
  query: () => ListQuery;
  /** Recipients instead of senders in the list (sent mail). */
  showRecipients?: boolean;
  empty: () => string;
}

/** Tabs above the inbox list, e.g. People / Newsletters. */
export interface ListTabs {
  tabs: () => { id: string; title: string }[];
  current: () => string;
  select: (id: string) => void;
  /** Extra conditions for the inbox query of the current tab. */
  query: () => Partial<ListQuery>;
}

/** The compose window as plugins see it. */
export interface ComposeContext {
  readonly draft: ComposeDraft;
  accountEmail(): string;
  /** Inserts at the caret. */
  insertText(text: string): void;
  /** Send parameters the core passes to the backend; plugins set them. */
  options: { at: number | null; followupDays: number | null };
  /** Sends now, or at `at`, after the checks. */
  send(at?: number | null): void;
}

export interface PluginContext {
  readonly id: string;
  lang(): Lang;
  t(text: Text, params?: Record<string, string | number>): string;
  /** `{n}` in the form for `n`. */
  plural(n: number, forms: { en: PluralForms; ru: PluralForms }): string;
  /** Every command on offer now: the core's and all plugins'. */
  commands(): Command[];

  mail: {
    opened(): OpenedMessage | null;
    /** Selected messages, or the opened one. */
    selection(): number[];
    accounts(): { id: string; email: string; display_name: string; label?: string }[];
    folders(): FolderInfo[];
    /** Takes messages out of the list, runs `run`, offers undo of the moves it returns. */
    perform(text: string, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string): Promise<void>;
    reload(): void;
    showView(id: string): void;
    /** The list shows this plugin view now. */
    viewing(id: string): boolean;
    /** Opens an empty compose window. */
    compose(): void;
  };
  /** Backend commands (see src-tauri/src/commands.rs); the core's IPC contract. */
  backend<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Backend events, e.g. "counters-changed". Unsubscribed with the plugin. */
  onBackend(event: string, run: (payload: unknown) => void): void;
  /** Opens a web link after the user confirms the real address. */
  openLink(url: string): void;
  toast(text: string, opts?: { error?: boolean; action?: { label: string; run: () => void }; ms?: number }): void;
  fail(e: unknown, prefix?: string): void;

  /** Per-plugin settings, kept with the app settings. Reactive. */
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
  };

  ui: {
    command(c: Command): void;
    keybinding(key: string, run: () => void, when?: () => boolean): void;
    /** Buttons in the reader toolbar, before "Delete". */
    readerToolbar(r: Rendered): void;
    /** Buttons in the panel for several selected messages. */
    bulkToolbar(r: Rendered): void;
    /** Next to the sender's name in the reader. */
    readerHeader(r: Rendered): void;
    /** Items in the reader's "More" menu. */
    messageAction(a: MessageAction): void;
    banner(provider: (msg: OpenedMessage) => Banner | null): void;
    rowTag(provider: (row: MessageRow) => RowTag | null): void;
    view(v: View): void;
    listTabs(t: ListTabs): void;
    /** Controls in the compose window; the core adds the `compose` prop to `props`. */
    composeControl(c: {
      component: Component<{ compose: ComposeContext; ctx: PluginContext }>;
      props: { ctx: PluginContext };
      order?: number;
      /** `send`: joined to the Send button; `footer` (default): after the core's buttons. */
      slot?: "send" | "footer";
    }): void;
    /** Warnings before sending; returning any stops sending until the user confirms. */
    sendCheck(check: (draft: ComposeDraft, accountEmail: string) => string[]): void;
    /** A section in Settings. */
    settingsSection(s: { title: () => string; component: Component<{ ctx: PluginContext }>; props: { ctx: PluginContext } }): void;
    /** Rendered on top of the window, e.g. a command palette. */
    overlay(r: Rendered): void;
  };
}
