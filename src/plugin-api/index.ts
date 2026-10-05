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
export { fromLocalInput, sendLaterPresets, snoozePresets, toLocalInput, when, type Preset } from "../lib/later";
export { addrName, listDate, matches, size } from "../lib/format";
export type { FileViewer, ViewedFile } from "../lib/viewer";
import type { FileViewer } from "../lib/viewer";

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

/**
 * An item in the context menu of list rows. `ids` are the rows it applies to: the
 * selection, or the row clicked. With `menu`, the item opens that component in its
 * place; the core adds the props `ids` and `done` (closes the menu).
 */
export interface RowAction {
  id: string;
  title: () => string;
  icon?: Component;
  hint?: string;
  when?: (ids: number[]) => boolean;
  run?: (ids: number[]) => void;
  menu?: Rendered;
}

export interface Banner {
  text: string;
  tone?: "info" | "warn";
  icon?: Component;
  /** Lines under the text, shown as they are (line breaks kept): what an action will send. */
  details?: { label: string; value: string }[];
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

/** The list a filter applies to: each list keeps its own choice. */
export interface ListScope {
  /** Stable key of the list, e.g. `folder:<account>:INBOX` or `unified:inbox`. */
  key: string;
  /** An inbox: all inboxes, or the inbox of one mailbox. */
  inbox: boolean;
}

/**
 * Which messages a list shows, e.g. All / People / Newsletters: a section of the list's
 * "View" menu, next to the order. The first option means "no filter"; any other is
 * named on the "View" button so hidden mail is not forgotten.
 */
export interface ListFilter {
  /** The section's title, e.g. "Show". */
  title: () => string;
  options: () => { id: string; title: string }[];
  current: (list: ListScope) => string;
  select: (list: ListScope, id: string) => void;
  /** Extra conditions for the list's query under its current option. */
  query: (list: ListScope) => Partial<ListQuery>;
}

/** The compose window as plugins see it. */
export interface ComposeContext {
  readonly draft: ComposeDraft;
  accountEmail(): string;
  /** Inserts at the caret. */
  insertText(text: string): void;
  /** Send parameters the core passes to the backend; plugins set them. */
  /** `followupSecs`: remind when no answer comes that long after sending; `followupDays` is the older form of it. */
  options: { at: number | null; followupDays: number | null; followupSecs: number | null };
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
    /** Answers the opened letter; to one's own sent letter, to its recipients again. */
    reply(all: boolean): void;
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
    /** Items in the context menu of list rows. */
    rowAction(a: RowAction): void;
    banner(provider: (msg: OpenedMessage) => Banner | null): void;
    rowTag(provider: (row: MessageRow) => RowTag | null): void;
    view(v: View): void;
    /** Which messages lists show; lists without mail from outside (Sent, Drafts) do not offer it. */
    listFilter(f: ListFilter): void;
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
    /**
     * A renderer of attachments in the viewer: a new format, or a better one for a format
     * the core shows (the core's have priority 0). The component gets `file` besides `props`.
     */
    fileViewer(v: FileViewer): void;
  };
}
