import { getVersion } from "@tauri-apps/api/app";
import { accountColor } from "./format";
import { emitTo } from "@tauri-apps/api/event";
import { api, asError } from "./api";
import { applyTheme } from "./theme";
import { i18n, t } from "./i18n.svelte";
import { extensions } from "./extensions.svelte";
import { listenMain, listenWindow } from "./events";
import { ListController, type View } from "./list.svelte";
import { ActionRunner } from "./actions.svelte";
import { Reader } from "./reader.svelte";
import { ComposeManager, type ComposeState, type ComposeWindow } from "./composes.svelte";
import type { AccountView, Account, ComposeDraft, FolderInfo, FollowupPlan, MessageRow, Moved, OutboxItem, Settings, SortKey, Task, UpdateStatus } from "./types";

export type { View } from "./list.svelte";
export type { ComposeState, ComposeWindow } from "./composes.svelte";

export interface Toast {
  id: number;
  text: string;
  error: boolean;
  action?: { label: string; run: () => void };
}

export interface Confirmation {
  title?: string;
  text: string;
  /** Shown apart from the text, in monospace: a link's real address. */
  detail?: string;
  okLabel: string;
  cancelLabel?: string;
  /** The action loses something: the safe button gets the focus. */
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export interface WizardState {
  /** Existing account when editing. */
  account: Account | null;
}

// The list (./list.svelte), the reader (./reader.svelte), actions with their undo
// (./actions.svelte) and compositions (./composes.svelte) live in modules of their own;
// the events of the backend are in ./events. The store ties them together and keeps
// `app.*` as the interface's one way in.
export class AppStore {
  accounts = $state<AccountView[]>([]);
  folders = $state<FolderInfo[]>([]);
  selected = $state<Set<number>>(new Set());
  anchor = $state<number | null>(null);
  /** User actions still talking to the server; the list shows a progress line meanwhile. */
  busy = $state(0);
  /** The app's version, shown quietly in the sidebar. */
  version = $state("");
  outbox = $state<OutboxItem[]>([]);
  toasts = $state<Toast[]>([]);
  /** The question the app waits an answer to (`confirm`), drawn above every dialog. */
  confirmation = $state<Confirmation | null>(null);
  wizard = $state<WizardState | null>(null);
  settings = $state<Settings>({
    undo_send_secs: 10,
    notify: "people",
    dnd_until: 0,
    threads: true,
    templates: [],
    updates: "auto",
    language: "auto",
    theme: "system",
    disabled_plugins: [],
    plugin_settings: {},
    disabled_extensions: [],
    oauth_clients: {},
    offline: "30",
    offline_attachments: false,
    sender_logos: true,
    letter_view: "sender",
    attachments_dir: "",
    list_sort: [],
    view_sorts: {},
    large_mb: 25,
    compose_format: "html",
  });
  update = $state<UpdateStatus | null>(null);
  /** One window for every setting: the app's, the mailboxes', the plugins'. */
  settingsOpen = $state(false);
  /** The page it opens on: "general", "offline", "accounts", "account:<id>", "account:new", "plugins"… */
  settingsPage = $state("general");
  /** A section of a mailbox's page to open the settings at (`letters`), once. */
  settingsSection: string | null = null;
  tasksOpen = $state(false);
  /** Background work: running, and failed until dismissed. */
  tasks = $state<Task[]>([]);

  /**
   * The letter a separate message window shows (double click in the list); null in the
   * main window. Such a window has no list: actions on its letter close it, and what
   * concerns the list (undo, a search by sender) goes to the main window.
   */
  windowOf = $state<number | null>(null);

  readonly list = new ListController(this);
  readonly actions = new ActionRunner(this);
  readonly compose = new ComposeManager(this);
  readonly reader = new Reader(this);

  private toastSeq = 0;

  get view() { return this.list.view; }
  get messages() { return this.list.messages; }
  get exhausted() { return this.list.exhausted; }
  get loadingMore() { return this.list.loadingMore; }
  get serverSearching() { return this.list.serverSearching; }
  /** Rows the server-side search found, kept across list reloads. */
  get serverRows() { return this.list.serverRows; }
  /** How many letters the search finds in the cache and their size. */
  get searchTotals() { return this.list.totals; }
  /** The last move that can be taken back with "z". */
  get lastUndo() { return this.actions.lastUndo; }
  /** Compositions in progress, oldest first; at most one is unfolded. */
  get composes() { return this.compose.windows; }
  get opened() { return this.reader.opened; }
  get openError() { return this.reader.openError; }
  get opening() { return this.reader.opening; }
  /** The list row of the message being opened: its header shows at once, before the body arrives. */
  get openingRow() { return this.reader.openingRow; }
  get allowRemote() { return this.reader.allowRemote; }
  /** The opened message's conversation, oldest first; empty for a lone message. */
  get conversation() { return this.reader.conversation; }

  async init() {
    getVersion().then((v) => (this.version = v), () => {});
    extensions.toast = (text, error) => this.toast(text, error);
    await listenMain(this);
    await this.loadLanguage();
    // Each request that fails is told and does not hold up the others.
    const [accounts] = await Promise.all([
      this.loadAccounts().then(() => true, (e) => (this.fail(e), false)),
      this.loadFolders(),
      this.loadOutbox(),
      this.loadSettings(),
      extensions.load(),
      api.tasks().then((tasks) => (this.tasks = tasks), (e) => this.fail(e)),
      api.updateStatus().then((u) => (this.update = u), (e) => this.fail(e)),
    ]);
    this.list.view = this.home();
    await this.reload();
    // Unknown mailboxes are not no mailboxes: the wizard waits for a list it could read.
    if (accounts && this.accounts.length === 0) this.wizard = { account: null };
  }

  /** A separate window with one letter: no list, no background work of its own. */
  async initWindow(id: number) {
    this.windowOf = id;
    extensions.toast = (text, error) => this.toast(text, error);
    await listenWindow(this);
    await this.loadLanguage();
    await Promise.all([this.loadAccounts().catch((e) => this.fail(e)), this.loadFolders(), this.loadSettings(), extensions.load()]);
    this.selected = new Set([id]);
    await this.open(id);
  }

  toast(text: string, error = false, action?: Toast["action"], ms?: number) {
    const id = ++this.toastSeq;
    this.toasts.push({ id, text, error, action });
    setTimeout(() => this.dismiss(id), ms ?? (error ? 12000 : action ? 8000 : 4000));
  }

  /** The language resolved by the backend: the setting, or the system locale. */
  async loadLanguage() {
    try {
      i18n.lang = await api.language();
      document.documentElement.lang = i18n.lang;
    } catch {
      // Stays English.
    }
  }

  async loadSettings() {
    try {
      this.settings = await api.settings();
      applyTheme(this.settings.theme);
    } catch (e) {
      this.fail(e);
    }
  }

  async saveSettings(next: Settings) {
    const threadsChanged = next.threads !== this.settings.threads;
    this.settings = next;
    applyTheme(next.theme);
    try {
      await api.saveSettings($state.snapshot(next));
    } catch (e) {
      this.fail(e, t("err.settings"));
      // Refused (a folder not picked in the dialog): the window shows what is saved.
      await this.loadSettings();
    }
    await this.loadLanguage();
    if (threadsChanged) this.reload();
  }

  /** A built-in plugin's own settings; a letter's window may save them, not the rest. */
  async savePluginSettings(plugin: string, values: Record<string, unknown>) {
    this.settings = { ...this.settings, plugin_settings: { ...(this.settings.plugin_settings ?? {}), [plugin]: values } };
    try {
      await api.pluginSettingsSet(plugin, $state.snapshot(values));
    } catch (e) {
      this.fail(e, t("err.settings"));
    }
  }

  async checkUpdates() {
    try {
      this.update = await api.updateCheck();
      if (this.update.state === "idle") this.toast(t("update.latest", { version: this.update.current }));
    } catch (e) {
      this.fail(e);
    }
  }

  async installUpdate() {
    try {
      this.update = await api.updateInstall();
    } catch (e) {
      this.fail(e, t("update.title"));
    }
  }

  restartForUpdate() {
    api.updateRestart().catch((e) => this.fail(e));
  }

  /** Where the app starts and comes back to: all inboxes, or the only account's inbox. */
  home(): View {
    if (this.accounts.length !== 1) return { kind: "unified", role: "inbox" };
    const id = this.accounts[0].id;
    const inbox = this.folders.find((f) => f.account_id === id && f.role === "inbox");
    return { kind: "folder", account_id: id, folder: inbox?.name ?? "INBOX" };
  }

  inboxLike() { return this.list.inboxLike(); }
  listKey() { return this.list.listKey(); }
  listFilter() { return this.list.listFilter(); }
  sort() { return this.list.sort(); }
  ownSort() { return this.list.ownSort(); }

  /** Orders the current list (`own`), or every list without an order of its own. */
  async setSort(sort: SortKey[], own = this.ownSort()) {
    const key = this.listKey();
    const view_sorts = { ...(this.settings.view_sorts ?? {}) };
    let list_sort = this.settings.list_sort ?? [];
    if (own && key) view_sorts[key] = sort;
    else {
      if (key) delete view_sorts[key];
      list_sort = sort;
    }
    this.list.unpin();
    await this.saveSettings({ ...this.settings, list_sort, view_sorts });
    this.reload();
  }

  /** Bytes of the selected rows: a conversation counts with its letters in the list. */
  selectedSize(): number {
    return this.messages.reduce((sum, m) => (this.selected.has(m.id) ? sum + (m.thread_size ?? m.size) : sum), 0);
  }

  /** Selects every row of the list: "Select all found" in a search, Ctrl+A. */
  selectAll() {
    if (this.windowOf !== null || !this.messages.length) return;
    this.selected = new Set(this.messages.map((m) => m.id));
  }

  /** Asks in the app's own dialog; true when the user agreed. */
  confirm(q: Omit<Confirmation, "resolve">): Promise<boolean> {
    this.confirmation?.resolve(false);
    return new Promise((resolve) => {
      this.confirmation = {
        ...q,
        resolve: (ok) => {
          this.confirmation = null;
          resolve(ok);
        },
      };
    });
  }

  dismiss(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  fail(e: unknown, prefix = "") {
    const err = asError(e);
    this.toast(prefix ? `${prefix}: ${err.message}` : err.message, true);
  }

  async loadAccounts() {
    this.accounts = await api.accounts();
  }

  private foldersTimer: ReturnType<typeof setTimeout> | null = null;
  scheduleFolders() {
    if (this.foldersTimer) return;
    this.foldersTimer = setTimeout(() => {
      this.foldersTimer = null;
      this.loadFolders();
    }, 400);
  }

  async loadFolders() {
    try {
      this.folders = await api.folders();
    } catch (e) {
      this.fail(e);
    }
  }

  async loadOutbox() {
    try {
      this.outbox = await api.outbox();
    } catch (e) {
      this.fail(e);
    }
  }

  account(id: string) {
    return this.accounts.find((a) => a.id === id);
  }

  /** The colour that marks a mailbox in the sidebar and in shared lists. */
  accountColor(id: string): string {
    const i = this.accounts.findIndex((a) => a.id === id);
    return accountColor(this.accounts[i], i);
  }

  folder(accountId: string, name: string) {
    return this.folders.find((f) => f.account_id === accountId && f.name === name);
  }

  scheduleReload() {
    this.list.scheduleReload();
  }

  /** Reloads the current list keeping as many rows as are shown now; a message window has none. */
  async reload() {
    if (this.windowOf === null) await this.list.reload();
  }

  /** Letters the reader shows now: the open one and its conversation. */
  showing(): number[] {
    return this.reader.showing();
  }

  /** The list was read again: selections of rows that disappeared (moved, deleted elsewhere) go. */
  async listed(ids: Set<number>, search: boolean) {
    const kept = [...this.selected].filter((id) => ids.has(id));
    if (kept.length !== this.selected.size) this.selected = new Set(kept);
    // Not in the list is not gone: a letter opened from its conversation (an older one,
    // my answer in Sent) is not a row of a grouped list. Closed only when it left the cache.
    const opened = this.opened;
    if (opened && !ids.has(opened.row.id) && !search) {
      const rows = await api.messagesById([opened.row.id]).catch(() => null);
      if (rows?.length === 0 && this.opened === opened) this.reader.opened = null;
    }
  }

  /** Searches on the servers too: finds mail older than the local cache. */
  searchServer() {
    return this.list.searchServer();
  }

  loadMore() {
    return this.list.loadMore();
  }

  async setView(v: View) {
    if (this.windowOf !== null) {
      // A message window has no list: the main window shows it.
      await emitTo("main", "window-view", v);
      return;
    }
    this.list.reset(v);
    this.reader.close();
    this.reader.openError = null;
    this.selected = new Set();
    // The list shows the cache at once; fresh mail from the server follows, with the progress line.
    if (v.kind === "folder") this.track(api.syncNow(v.account_id, v.folder)).catch(() => {});
    await this.reload();
  }

  async select(id: number, mode: "single" | "toggle" | "range" = "single") {
    if (mode === "toggle") {
      const s = new Set(this.selected);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      this.selected = s;
      this.anchor = id;
      if (s.size !== 1) return;
      id = [...s][0];
    } else if (mode === "range" && this.anchor !== null) {
      const a = this.messages.findIndex((m) => m.id === this.anchor);
      const b = this.messages.findIndex((m) => m.id === id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        this.selected = new Set(this.messages.slice(from, to + 1).map((m) => m.id));
        return;
      }
    } else {
      this.selected = new Set([id]);
      this.anchor = id;
    }
    await this.open(id);
  }

  open(id: number, allowRemote = false) {
    return this.reader.open(id, allowRemote);
  }

  move(step: 1 | -1) {
    if (this.messages.length === 0) return;
    const current = this.opened?.row.id ?? [...this.selected][0];
    const i = this.messages.findIndex((m) => m.id === current);
    const next = this.messages[Math.min(this.messages.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
    if (next) this.select(next.id);
  }

  selectedIds(): number[] {
    // A message window acts on the letter it shows, also after a click in its conversation.
    if (this.windowOf !== null) return this.opened ? [this.opened.row.id] : [];
    if (this.selected.size) return [...this.selected];
    return this.opened ? [this.opened.row.id] : [];
  }

  /** Takes rows out of the list and opens the next one: triage keeps going. */
  takeOut(ids: number[]) {
    // A message window keeps showing its letter until the action is through.
    if (this.windowOf !== null) return;
    const index = this.list.remove(ids);
    this.reader.close();
    this.selected = new Set();
    const next = this.messages[Math.min(Math.max(index, 0), this.messages.length - 1)];
    if (next && index >= 0) this.select(next.id);
  }

  /** Runs a user action that waits for the server, with the progress line shown meanwhile. */
  async track<T>(p: Promise<T>): Promise<T> {
    this.busy++;
    try {
      return await p;
    } finally {
      this.busy--;
    }
  }

  /** Takes messages out of the list and runs `run`; the moves it returns can be undone. Never rejects. */
  perform(text: string, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string) {
    return this.actions.perform(text, ids, run, failText);
  }

  remove(ids = this.selectedIds()) { return this.actions.remove(ids); }
  moveTo(folder: string, ids = this.selectedIds()) { return this.actions.moveTo(folder, ids); }
  /** "Done": out of the inbox, into the archive. */
  archive(ids = this.selectedIds()) { return this.actions.archive(ids); }
  spam(ids = this.selectedIds()) { return this.actions.spam(ids); }
  undo() { return this.actions.undo(); }

  /** Queues the composition; it leaves after the undo delay or at `at`. */
  send(accountId: string, draft: ComposeDraft, draftId: number | null, at: number | null, followupSecs: number | null, followup: FollowupPlan | null = null) {
    return this.compose.send(accountId, draft, draftId, at, followupSecs, followup);
  }

  /** Takes a queued message back into the composer. */
  reopenOutbox(id: number) {
    return this.compose.reopenOutbox(id);
  }

  async flag(change: "seen" | "flagged", value: boolean, ids = this.selectedIds()) {
    if (!ids.length) return;
    this.reader.flagEpoch++;
    for (const id of ids) this.list.mark(id, this.messages.find((m) => m.id === id));
    for (const m of this.messages) if (ids.includes(m.id)) m.flags[change] = value;
    if (this.opened && ids.includes(this.opened.row.id)) this.opened.row.flags[change] = value;
    try {
      await this.track(api.setFlag(ids, { flag: change, value }));
    } catch (e) {
      this.fail(e);
    }
  }

  /** Focuses the search box; set by the window that owns it. */
  focusSearch: () => void = () => {};

  /** Opens a web link after confirming the real address with the user. */
  async openLink(href: string) {
    const ok = await this.confirm({ text: t("link.open"), detail: href, okLabel: t("link.openButton") });
    if (ok) api.openLink(href).catch((e) => this.fail(e));
  }

  openSettings(page = "general", section: string | null = null) {
    this.settingsPage = page;
    this.settingsSection = section;
    this.settingsOpen = true;
  }

  /** A mailbox's page in the settings; the very first one is set up by the wizard alone. */
  accountSettings(acc: AccountView | null) {
    if (this.accounts.length === 0) this.wizard = { account: null };
    else this.openSettings(acc ? `account:${acc.id}` : "account:new");
  }

  newMessage() { this.compose.newMessage(); }
  replyTo(all: boolean) { this.compose.replyTo(all); }
  forwardOpened() { this.compose.forwardOpened(); }

  /** Opens a letter in a window of its own; a draft opens in the composer instead. */
  async openWindow(row: MessageRow) {
    if (this.folder(row.account_id, row.folder)?.role === "drafts") {
      await this.select(row.id);
      return;
    }
    try {
      await api.messageWindow(row.id, row.subject || t("noSubject"));
    } catch (e) {
      this.fail(e);
    }
  }

  /** Opens a composition window; the others fold into bars, as in Gmail. */
  openCompose(c: ComposeState, mode?: ComposeWindow["mode"]): number {
    return this.compose.open(c, mode);
  }

  /** Unfolds a window and folds the rest. */
  showCompose(id: number, mode: "open" | "max" = "open") {
    this.compose.show(id, mode);
  }

  closeCompose(id: number) {
    this.compose.close(id);
  }

  /** The window that takes dropped files: the unfolded one, else the newest. */
  activeCompose(): ComposeWindow | undefined {
    return this.compose.active();
  }

  defaultAccount(): AccountView | undefined {
    const v = this.view;
    if (v.kind === "folder") return this.account(v.account_id);
    if (this.opened) return this.account(this.opened.row.account_id);
    return this.accounts[0];
  }
}

export const app = new AppStore();
