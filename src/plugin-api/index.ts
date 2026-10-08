// The contract between Depesha's core and its plugins. A plugin imports from here and
// nowhere else in the app (plugin-api/boundary.test.ts checks it), so it can later move
// to its own repository. Everything a plugin adds goes through `PluginContext.ui` and is
// removed by the core when the plugin is switched off.

import type { Component } from "svelte";
import type { ActsOn, ComposeDraft, FolderInfo, FollowupInfo, FollowupPlan, ListQuery, MessageRow, Moved, OpenedMessage, Waiting } from "../lib/types";

export type { ActsOn, ComposeDraft, FolderInfo, FollowupInfo, FollowupPlan, ListQuery, MessageRow, Moved, OpenedMessage, Waiting };
export { default as Popover } from "../components/Popover.svelte";
export { default as LaterMenu } from "../components/LaterMenu.svelte";
export { default as Select } from "../components/Select.svelte";
/** A key as menus and the palette show it, `e у`: `key="Mod+k"`, or `of` a command's key. */
export { default as Keys } from "../components/Keys.svelte";
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
  /** Off until the user switches it on in Settings → Plugins; without it a plugin is on from the start. */
  defaultOff?: boolean;
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

/**
 * A command with a key. It is listed on the «Keys» page, where the user may change the
 * key; a default key taken already (by the core, the user or a plugin before) is not
 * taken from them: the command goes without one, and the user is told once.
 * Keys are named "Mod+k" (Ctrl, Cmd on macOS), "Shift+r", "h", "Delete"; letters by
 * their Latin letter, so they work on any layout.
 */
export interface KeyBinding {
  id: string;
  title: () => string;
  key?: string;
  run: () => void;
  when?: () => boolean;
  /** `everywhere` in the main window, or `list` (default): the list and the letter. */
  where?: "everywhere" | "list";
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
  /** The command whose key the item shows, as the user set it (instead of `hint`). */
  command?: string;
  when?: (ids: number[], rows: MessageRow[]) => boolean;
  run?: (ids: number[]) => void;
  menu?: Rendered;
}

export interface Banner {
  text: string;
  /** `good`: something went as hoped, e.g. the awaited answer came. */
  tone?: "info" | "warn" | "good";
  icon?: Component;
  /** Lines under the text, shown as they are (line breaks kept): what an action will send. */
  details?: { label: string; value: string }[];
  /** In a narrow window the details fold into the "⋯" menu under this title; without it they stay shown. */
  detailsTitle?: string;
  /** In a narrow window the first one stays a button, the others fold into "⋯". */
  actions?: { title: string; run: () => void; primary?: boolean }[];
}

export interface RowTag {
  icon?: Component;
  text: string;
  /** Small and quiet in the first line, before the date, e.g. the kind of a reminder; hidden in a narrow list. */
  note?: { text: string; icon?: Component };
  title?: string;
  alert?: boolean;
  /** Green: e.g. an answer came. */
  good?: boolean;
  /** Blue: where the letter is going, e.g. "to Waiting for reply". */
  info?: boolean;
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
  /** A segmented switch over the list, e.g. Active / Closed; `query` reads what it chose. */
  tabs?: ViewTabs;
  /** The sidebar entry shows while this holds, even with nothing to count. */
  shown?: () => boolean;
}

export interface ViewTabs {
  options: () => { id: string; title: string; count?: number }[];
  current: () => string;
  select: (id: string) => void;
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
  /**
   * The letter being written. In a plain or Markdown letter `draft.text` may be set as a
   * whole; in an HTML letter (`draft.format === "html"`) it is only the plain version of
   * the HTML and is read-only: a value set there is put back. Use `insertText` instead.
   */
  readonly draft: ComposeDraft;
  accountEmail(): string;
  /** The mailbox the letter is written from, as chosen in "From". */
  accountId(): string;
  /** The colour that marks that mailbox: a plugin may tint the "From" field with it. */
  accountColor(): string;
  /** Inserts at the caret. */
  insertText(text: string): void;
  /** Send parameters the core passes to the backend; plugins set them. */
  /**
   * `followupSecs`: remind when no answer comes that long after sending; `followupDays` is the older form of it.
   * `followup`: the rest of that wait (a deadline, repeats, the awaited recipient, the choice's name).
   */
  /** `park`: the answer takes its letter to wait in the folder ("Waiting for reply"); null: as the mailbox says. */
  options: { at: number | null; followupDays: number | null; followupSecs: number | null; followup: FollowupPlan | null; park: boolean | null };
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
  /** The key of a command now, as the user set it ("Mod+k", "h"); none without one. */
  keyOf(commandId: string): string | undefined;
  /** A tooltip with the command's key: "Snooze (h/р)"; without a key, the text alone. */
  keyTitle(text: string, commandId: string): string;
  /**
   * Opens Settings → «Keys» at a command, highlighting its row: the entry from the palette
   * (Alt+Enter). A command the page has no row for — a context one — is searched for by
   * `title` instead (#46).
   */
  editKeys(commandId: string, title: string): void;

  mail: {
    opened(): OpenedMessage | null;
    /** Selected messages, or the opened one. */
    selection(): number[];
    accounts(): { id: string; email: string; display_name: string; label?: string; waiting?: Waiting }[];
    folders(): FolderInfo[];
    /** Takes messages out of the list, runs `run`, offers undo of the moves it returns. */
    perform(text: string | ((moved: Moved[]) => string), ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string): Promise<void>;
    reload(): void;
    /** Like `reload`, but for backend events in bursts: waits out the burst, then reloads once. */
    scheduleReload(): void;
    showView(id: string): void;
    /** The list shows this plugin view now. */
    viewing(id: string): boolean;
    /** Opens an empty compose window. */
    compose(): void;
    /** Answers the opened letter; to one's own sent letter, to its recipients again. */
    reply(all: boolean): void;
    /** Opens a letter with its conversation, as a click on its row; with `view`, that plugin view's list is shown first. Main window only. */
    open(id: number, view?: string): Promise<void>;
    /** The main window, with the list; false in a window of one letter. */
    main(): boolean;
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
    keybinding(b: KeyBinding): void;
    /** A key without a command of its own: on the «Keys» page under the plugin's name. */
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
      /**
       * `send`: joined to the Send button; `footer` (default): after the core's buttons;
       * `line`: a quiet line above them; `from`: in the "From" row, beside the mailbox list.
       */
      slot?: "send" | "footer" | "line" | "from";
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
