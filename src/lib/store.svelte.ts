import { getVersion } from "@tauri-apps/api/app";
import { accountColor } from "./format";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, asError } from "./api";
import { when } from "./later";
import { applyTheme } from "./theme";
import { i18n, t, tn } from "./i18n.svelte";
import { extensions, listenForMail, textOf, type MailAction } from "./extensions.svelte";
import { registry } from "../plugin-host/registry.svelte";
import { emptyDraft, forward, isForward, reply, withSignature } from "./compose";
import { compareRows } from "./sort";
import type { ListFilter, ListScope } from "../plugin-api";
import type {
  Account,
  AccountStatus,
  AccountView,
  AttachmentSource,
  CmdError,
  ComposeDraft,
  FolderInfo,
  FolderRole,
  ListQuery,
  MessageRow,
  Moved,
  OpenedMessage,
  OutboxItem,
  Pin,
  Settings,
  SortKey,
  Task,
  UpdateStatus,
} from "./types";

export type View =
  | { kind: "unified"; role: FolderRole; unread?: boolean; flagged?: boolean }
  | { kind: "folder"; account_id: string; folder: string }
  | { kind: "search"; text: string }
  /** A list contributed by a plugin (`ui.view`). */
  | { kind: "plugin"; id: string }
  | { kind: "outbox" };

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

export interface ComposeState {
  account_id: string;
  draft: ComposeDraft;
  /** Server draft this composition came from or was last saved as; removed after sending. */
  draft_id: number | null;
  /** The content is kept nowhere yet (typed in a quick reply, taken back from the outbox): save it. */
  unsaved?: boolean;
}

/** A composition window: docked in the corner, minimized to a bar, or full screen. */
export interface ComposeWindow extends ComposeState {
  id: number;
  mode: "open" | "min" | "max";
  /** When the draft was last saved on the server, ms. */
  savedAt: number | null;
}

export interface WizardState {
  /** Existing account when editing. */
  account: Account | null;
}

const PAGE = 200;

class AppStore {
  accounts = $state<AccountView[]>([]);
  folders = $state<FolderInfo[]>([]);
  view = $state<View>({ kind: "unified", role: "inbox" });
  messages = $state<MessageRow[]>([]);
  /** All cached messages of the view are loaded; for folders, older ones may still be on the server. */
  exhausted = $state(false);
  loadingMore = $state(false);
  selected = $state<Set<number>>(new Set());
  anchor = $state<number | null>(null);
  opened = $state<OpenedMessage | null>(null);
  openError = $state<CmdError | null>(null);
  opening = $state(false);
  /** The list row of the message being opened: its header shows at once, before the body arrives. */
  openingRow = $state<MessageRow | null>(null);
  /** User actions still talking to the server; the list shows a progress line meanwhile. */
  busy = $state(0);
  /** The app's version, shown quietly in the sidebar. */
  version = $state("");
  allowRemote = $state(false);
  outbox = $state<OutboxItem[]>([]);
  toasts = $state<Toast[]>([]);
  /** The question the app waits an answer to (`confirm`), drawn above every dialog. */
  confirmation = $state<Confirmation | null>(null);
  /** Compositions in progress, oldest first; at most one is unfolded. */
  composes = $state<ComposeWindow[]>([]);
  /** Server-side search: running, and rows it found (kept across list reloads). */
  serverSearching = $state(false);
  serverRows = $state<MessageRow[] | null>(null);
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
    attachments_dir: "",
    list_sort: [],
    view_sorts: {},
  });
  update = $state<UpdateStatus | null>(null);
  /** The opened message's conversation, oldest first; empty for a lone message. */
  conversation = $state<MessageRow[]>([]);
  /** One window for every setting: the app's, the mailboxes', the plugins'. */
  settingsOpen = $state(false);
  /** The page it opens on: "general", "offline", "accounts", "account:<id>", "account:new", "plugins"… */
  settingsPage = $state("general");
  tasksOpen = $state(false);
  /** Background work: running, and failed until dismissed. */
  tasks = $state<Task[]>([]);
  /** The last move that can be taken back with "z". */
  lastUndo = $state<{ moved: Moved[]; text: string } | null>(null);

  /**
   * The letter a separate message window shows (double click in the list); null in the
   * main window. Such a window has no list: actions on its letter close it, and what
   * concerns the list (undo, a search by sender) goes to the main window.
   */
  windowOf = $state<number | null>(null);

  private toastSeq = 0;
  private composeSeq = 0;
  /** Messages read or (un)flagged in this view: "Unread" and "Flagged" keep them until the view changes. */
  private keep = new Set<number>();
  /** How rows read or (un)flagged in this view looked before: they keep their place in the order until the view changes. */
  private pins = new Map<number, Pin>();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private openSeq = 0;

  async init() {
    getVersion().then((v) => (this.version = v), () => {});
    await this.loadLanguage();
    await Promise.all([this.loadAccounts(), this.loadFolders(), this.loadOutbox(), this.loadSettings()]);
    this.view = this.home();
    await this.reload();
    if (this.accounts.length === 0) this.wizard = { account: null };

    await listen<{ account_id: string; folder: string }>("mail-changed", (e) => {
      // My answers and drafts change how conversations look in every grouped list.
      const role = this.folder(e.payload.account_id, e.payload.folder)?.role;
      const threadPart = this.settings.threads && (role === "sent" || role === "drafts");
      if (threadPart || this.viewIncludes(e.payload.account_id, e.payload.folder)) this.scheduleReload();
      if (this.opened?.row.account_id === e.payload.account_id) this.scheduleConversation();
      this.scheduleFolders();
    });
    await listen("folders-changed", () => this.scheduleFolders());
    await listen<{ account_id: string; status: AccountStatus }>("account-status", (e) => {
      const a = this.accounts.find((x) => x.id === e.payload.account_id);
      if (a) a.status = e.payload.status;
    });
    await listen("outbox-changed", () => this.loadOutbox());
    await listen<Task[]>("tasks-changed", (e) => (this.tasks = e.payload));
    this.tasks = await api.tasks().catch(() => []);
    await listen<{ subject: string }>("sent", (e) => this.toast(t("toast.sent", { subject: e.payload.subject || t("noSubject") })));
    await listen<{ error: CmdError }>("send-failed", (e) =>
      this.toast(t("toast.sendFailed", { error: e.payload.error.message }), true),
    );
    await listen<{ message: string }>("app-error", (e) => this.toast(e.payload.message, true));
    await listen("settings-changed", async () => {
      await this.loadSettings();
      await extensions.load();
    });
    extensions.toast = (text, error) => this.toast(text, error);
    await listen<{ id: string }>("extensions-changed", (e) => {
      // A reinstalled extension starts with its new code.
      extensions.stop(e.payload.id);
      extensions.load();
    });
    await extensions.load();
    await listenForMail((ids) => this.applyRules(ids));
    await listen<UpdateStatus>("update-status", (e) => (this.update = e.payload));
    this.update = await api.updateStatus().catch(() => null);
    // A message window hands over what concerns the list.
    await listen<{ moved: Moved[]; text: string }>("window-moved", (e) => {
      this.lastUndo = e.payload;
      this.toast(e.payload.text, false, { label: t("undo"), run: () => this.undo() });
      this.reload();
    });
    await listen<View>("window-view", (e) => {
      getCurrentWindow().setFocus().catch(() => {});
      this.setView(e.payload);
    });
  }

  /** A separate window with one letter: no list, no background work of its own. */
  async initWindow(id: number) {
    this.windowOf = id;
    await this.loadLanguage();
    await Promise.all([this.loadAccounts(), this.loadFolders(), this.loadSettings()]);
    this.selected = new Set([id]);
    await this.open(id);

    await listen<{ account_id: string; folder: string }>("mail-changed", (e) => {
      const row = this.opened?.row;
      if (row && row.account_id === e.payload.account_id && row.folder === e.payload.folder) this.checkStillThere();
      this.scheduleFolders();
    });
    await listen("folders-changed", () => this.scheduleFolders());
    await listen<{ account_id: string; status: AccountStatus }>("account-status", (e) => {
      const a = this.accounts.find((x) => x.id === e.payload.account_id);
      if (a) a.status = e.payload.status;
    });
    await listen<{ subject: string }>("sent", (e) => this.toast(t("toast.sent", { subject: e.payload.subject || t("noSubject") })));
    await listen<{ error: CmdError }>("send-failed", (e) =>
      this.toast(t("toast.sendFailed", { error: e.payload.error.message }), true),
    );
    await listen("settings-changed", async () => {
      await this.loadSettings();
      await this.loadLanguage();
      await extensions.load();
    });
    extensions.toast = (text, error) => this.toast(text, error);
    // Mail rules run in the main window only, or they would run twice.
    await extensions.load();
  }

  /** The letter was moved or deleted elsewhere: the window says so instead of showing a ghost. */
  private async checkStillThere() {
    const id = this.opened?.row.id ?? this.windowOf;
    if (id === null) return;
    const rows = await api.messagesById([id]).catch(() => null);
    if (rows && rows.length === 0) {
      this.opened = null;
      this.openError = { kind: "not-found", message: t("window.gone") };
    }
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
    }
    await this.loadLanguage();
    if (threadsChanged) this.reload();
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


  /** Mail rules of extensions on newly arrived mail. */
  private async applyRules(ids: number[]) {
    if (!extensions.enabled().some((e) => e.hooks.includes("newMail"))) return;
    const rows = await api.messagesById(ids).catch(() => [] as MessageRow[]);
    if (!rows.length) return;
    const results = await extensions.newMail(rows, (id) => this.account(id)?.email ?? "");
    for (const { ext, actions } of results) {
      let done = 0;
      for (const a of actions) {
        try {
          await this.applyMailAction(a, rows.find((r) => r.id === a.id)!);
          done++;
        } catch (e) {
          this.fail(e, textOf(ext.name));
        }
      }
      if (done) this.toast(tn("ext.ruleApplied", done, { name: textOf(ext.name) }));
    }
    this.reload();
  }

  private async applyMailAction(a: MailAction, row: MessageRow) {
    const ids = [a.id];
    switch (a.do) {
      case "archive":
        return void (await api.archive(ids));
      case "read":
      case "unread":
        return api.setFlag(ids, { flag: "seen", value: a.do === "read" });
      case "flag":
        return api.setFlag(ids, { flag: "flagged", value: true });
      case "delete":
        return void (await api.remove(ids));
      case "spam":
        return void (await api.spam(ids));
      case "move": {
        const want = a.folder.toLowerCase();
        const f = this.folders.find(
          (x) => x.account_id === row.account_id && (x.name.toLowerCase() === want || x.display_name.toLowerCase() === want),
        );
        if (!f) throw new Error(t("ext.noFolder", { folder: a.folder }));
        return void (await api.move(ids, f.name));
      }
    }
  }

  /** Where the app starts and comes back to: all inboxes, or the only account's inbox. */
  home(): View {
    if (this.accounts.length !== 1) return { kind: "unified", role: "inbox" };
    const id = this.accounts[0].id;
    const inbox = this.folders.find((f) => f.account_id === id && f.role === "inbox");
    return { kind: "folder", account_id: id, folder: inbox?.name ?? "INBOX" };
  }

  /** Inbox lists: all inboxes, or the inbox of one mailbox. */
  inboxLike(): boolean {
    const v = this.view;
    if (v.kind === "unified") return v.role === "inbox";
    if (v.kind === "folder") return this.folder(v.account_id, v.folder)?.role === "inbox";
    return false;
  }

  /** The key the current list keeps its own order and filter under; null for lists without them. */
  listKey(): string | null {
    const v = this.view;
    if (v.kind === "folder") return `folder:${v.account_id}:${v.folder}`;
    if (v.kind === "unified") return `unified:${v.role}${v.unread ? ":unread" : v.flagged ? ":flagged" : ""}`;
    if (v.kind === "plugin") return `plugin:${v.id}`;
    if (v.kind === "search") return "search";
    return null;
  }

  /** The filter of plugins (People / Newsletters) with the list it applies to; lists of my own mail have none. */
  listFilter(): { filter: ListFilter; list: ListScope } | null {
    const v = this.view;
    const filter = registry.items("listFilters")[0];
    const key = this.listKey();
    if (!filter || !key || (v.kind !== "folder" && v.kind !== "unified")) return null;
    const role = v.kind === "folder" ? this.folder(v.account_id, v.folder)?.role : v.role;
    if (role === "sent" || role === "drafts") return null;
    return { filter, list: { key, inbox: this.inboxLike() } };
  }

  /** The order of the current list: its own, or the common one. */
  sort(): SortKey[] {
    const key = this.listKey();
    return (key && this.settings.view_sorts?.[key]) || this.settings.list_sort || [];
  }

  /** The current list has an order of its own. */
  ownSort(): boolean {
    const key = this.listKey();
    return !!key && !!this.settings.view_sorts?.[key];
  }

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
    // A new order places every row anew: rows changed earlier no longer hold their places.
    this.pins = new Map();
    await this.saveSettings({ ...this.settings, list_sort, view_sorts });
    this.reload();
  }

  /** Remembers how a row looked before the user changed it, once per view. */
  private pin(row: MessageRow | undefined) {
    if (row && !this.pins.has(row.id)) this.pins.set(row.id, { id: row.id, unread: !row.flags.seen, flagged: row.flags.flagged });
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

  private viewIncludes(accountId: string, folder: string): boolean {
    const v = this.view;
    if (v.kind === "folder") return v.account_id === accountId && v.folder === folder;
    if (v.kind === "unified") return this.folder(accountId, folder)?.role === v.role || (v.role === "inbox" && folder === "INBOX");
    return v.kind === "search" || v.kind === "plugin";
  }

  private query(offset: number): ListQuery | null {
    const v = this.view;
    // The plugins' filter (People / Newsletters) narrows the list.
    const lf = this.listFilter();
    const filter = lf ? lf.filter.query(lf.list) : {};
    const sort = this.sort();
    // Pins matter only where the order looks at what they keep.
    const pins = sort.some((k) => k.by === "unread" || k.by === "flagged") ? [...this.pins.values()] : [];
    const shape = { ...filter, sort, pins };
    const threads = this.settings.threads;
    if (v.kind === "folder") {
      const drafts = this.folder(v.account_id, v.folder)?.role === "drafts";
      return { account_id: v.account_id, folder: v.folder, threads: threads && !drafts, ...shape, limit: PAGE, offset };
    }
    if (v.kind === "unified") {
      const keep_ids = v.unread || v.flagged ? [...this.keep] : [];
      return { role: v.role, unread_only: !!v.unread, flagged_only: !!v.flagged, keep_ids, threads, ...shape, limit: PAGE, offset };
    }
    if (v.kind === "plugin") {
      const pv = registry.view(v.id);
      // Grouped like folders unless the view says otherwise.
      return pv ? { threads, sort, pins, ...pv.query(), limit: PAGE, offset } : null;
    }
    return null;
  }

  scheduleReload() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.reload(), 250);
  }

  /** Reloads the current list keeping as many rows as are shown now. */
  async reload() {
    if (this.windowOf !== null) return;
    const v = this.view;
    try {
      if (v.kind === "search") {
        const local = v.text.trim() ? await api.search(v.text, this.sort()) : [];
        if (this.view !== v) return;
        this.messages = this.visible(this.merge(local, this.serverRows ?? []));
        this.exhausted = true;
      } else if (v.kind === "outbox") {
        this.messages = [];
        this.exhausted = true;
        return;
      } else {
        const want = Math.max(PAGE, this.messages.length + this.leaving.size);
        const q = this.query(0);
        if (!q) {
          // A plugin view whose plugin was switched off.
          this.messages = [];
          this.exhausted = true;
          return;
        }
        q.limit = want;
        const rows = await api.messages(q);
        // The user may have switched views while this was loading.
        if (this.view !== v) return;
        this.messages = this.visible(rows);
        this.exhausted = rows.length < want;
      }
      // Drop selections of rows that disappeared (moved, deleted elsewhere).
      const ids = new Set(this.messages.map((m) => m.id));
      const kept = [...this.selected].filter((id) => ids.has(id));
      if (kept.length !== this.selected.size) this.selected = new Set(kept);
      if (this.opened && !ids.has(this.opened.row.id) && v.kind !== "search") this.opened = null;
    } catch (e) {
      this.fail(e);
    }
  }

  /** Search results of the cache and of the servers, in the list's order. */
  private merge(a: MessageRow[], b: MessageRow[]): MessageRow[] {
    const seen = new Set(a.map((m) => m.id));
    const extra = b.filter((m) => !seen.has(m.id));
    const sort = this.sort();
    // Only the cache knows how well a message matches: the servers' finds follow its best.
    if (sort[0]?.by === "relevance") return [...a, ...extra.sort(compareRows(sort.slice(1)))];
    return [...a, ...extra].sort(compareRows(sort));
  }

  /** Searches on the servers too: finds mail older than the local cache. */
  async searchServer() {
    const v = this.view;
    if (v.kind !== "search" || this.serverSearching) return;
    this.serverSearching = true;
    try {
      const rows = await this.track(api.serverSearch(v.text));
      if (this.view !== v) return;
      this.serverRows = rows;
      this.messages = this.visible(this.merge(this.messages, rows));
    } catch (e) {
      this.fail(e, t("search.server"));
    } finally {
      this.serverSearching = false;
    }
  }

  async loadMore() {
    if (this.loadingMore) return;
    const v = this.view;
    this.loadingMore = true;
    try {
      const q = this.query(this.messages.length);
      if (!q) return;
      if (!this.exhausted) {
        const rows = await api.messages(q);
        if (this.view !== v) return;
        this.messages = this.append(rows);
        this.exhausted = rows.length < PAGE;
      } else if (v.kind === "folder") {
        // The cache ran out: fetch older headers from the server.
        const n = await this.track(api.loadOlder(v.account_id, v.folder));
        if (n > 0 && this.view === v) {
          this.exhausted = false;
          const rows = await api.messages(this.query(this.messages.length)!);
          if (this.view !== v) return;
          this.messages = this.append(rows);
          this.exhausted = rows.length < PAGE;
        }
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.loadingMore = false;
    }
  }

  async setView(v: View) {
    if (this.windowOf !== null) {
      // A message window has no list: the main window shows it.
      await emitTo("main", "window-view", v);
      return;
    }
    this.view = v;
    this.keep = new Set();
    this.pins = new Map();
    this.conversation = [];
    this.serverRows = null;
    this.messages = [];
    this.selected = new Set();
    this.opened = null;
    this.openError = null;
    this.exhausted = false;
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

  async open(id: number, allowRemote = false) {
    const seq = ++this.openSeq;
    this.opening = true;
    this.openingRow = this.messages.find((m) => m.id === id) ?? this.conversation.find((m) => m.id === id) ?? null;
    this.openError = null;
    this.allowRemote = allowRemote;
    try {
      const msg = await api.open(id, allowRemote);
      if (seq !== this.openSeq) return;
      const epoch = this.flagEpoch;
      const wasUnread = !msg.row.flags.seen;
      msg.row.flags.seen = true;
      this.opened = msg;
      this.conversation = [];
      // Marked read on the server only after it was shown.
      if (wasUnread) {
        this.pin(this.messages.find((m) => m.id === id) ?? { ...msg.row, flags: { ...msg.row.flags, seen: false } });
        this.keep.add(id);
        api.setFlag([id], { flag: "seen", value: true }).catch((e) => this.fail(e));
        const row = this.messages.find((m) => m.id === id);
        if (row) row.flags.seen = true;
      }
      this.loadConversation(id, seq, epoch, msg.row.folder);
      extensions.messageOpen(msg, this.account(msg.row.account_id)?.email ?? "");
    } catch (e) {
      if (seq === this.openSeq) {
        this.opened = null;
        this.openError = asError(e);
      }
    } finally {
      if (seq === this.openSeq) {
        this.opening = false;
        this.openingRow = null;
      }
    }
  }

  /** Bumped by every flag change the user makes; late automatic marks yield to it. */
  private flagEpoch = 0;

  private async loadConversation(id: number, seq: number, epoch: number, folder: string) {
    const conversation = await api.thread(id).catch(() => [] as MessageRow[]);
    if (seq !== this.openSeq) return;
    this.conversation = shownConversation(conversation, id, folder);
    // Reading a conversation reads all of it, unless the user changed flags meanwhile.
    const unread = conversation.filter((m) => !m.flags.seen && m.id !== id).map((m) => m.id);
    if (unread.length && epoch === this.flagEpoch) {
      for (const u of unread) this.keep.add(u);
      for (const m of conversation) if (unread.includes(m.id)) this.pin(m);
      api.setFlag(unread, { flag: "seen", value: true }).catch((e) => this.fail(e));
      for (const m of this.messages) if (unread.includes(m.id)) m.flags.seen = true;
    }
  }

  private conversationTimer: ReturnType<typeof setTimeout> | null = null;

  /** A letter joined the open conversation (an answer, a forward, new mail): show it, flags untouched. */
  private scheduleConversation() {
    if (this.conversationTimer) clearTimeout(this.conversationTimer);
    this.conversationTimer = setTimeout(async () => {
      const opened = this.opened;
      if (!opened) return;
      const seq = this.openSeq;
      const rows = await api.thread(opened.row.id).catch(() => []);
      // A letter moved or deleted meanwhile keeps its conversation until opened again.
      if (seq !== this.openSeq || rows.length === 0) return;
      const next = shownConversation(rows, opened.row.id, opened.row.folder);
      const same = (a: MessageRow[], b: MessageRow[]) =>
        a.length === b.length && a.every((m, i) => m.id === b[i].id && m.flags.seen === b[i].flags.seen && m.flags.flagged === b[i].flags.flagged);
      if (!same(next, this.conversation)) this.conversation = next;
    }, 250);
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
  private takeOut(ids: number[]) {
    // A message window keeps showing its letter until the action is through.
    if (this.windowOf !== null) return;
    const index = this.messages.findIndex((m) => ids.includes(m.id));
    this.messages = this.messages.filter((m) => !ids.includes(m.id));
    this.opened = null;
    this.conversation = [];
    this.selected = new Set();
    const next = this.messages[Math.min(Math.max(index, 0), this.messages.length - 1)];
    if (next && index >= 0) this.select(next.id);
  }

  /** The ids an action applies to: in a grouped list a row stands for its whole conversation. */
  private async withConversation(ids: number[]): Promise<number[]> {
    // A message window shows one letter, not a row of the list: the action is for it alone.
    if (!this.settings.threads || this.windowOf !== null) return ids;
    const out = new Set(ids);
    for (const id of ids) {
      const row = this.messages.find((m) => m.id === id) ?? this.opened?.row;
      if (!row || row.thread_count <= 1) continue;
      for (const m of await api.thread(id)) {
        // Only messages of the same folder: my replies stay in Sent.
        if (m.folder === row.folder && m.account_id === row.account_id) out.add(m.id);
      }
    }
    return [...out];
  }

  /** The action still talking to the server; "z" pressed meanwhile waits for it. */
  private pending: Promise<void> | null = null;

  /**
   * Rows taken out by actions still on their way to the server. The cache keeps
   * them in their folder until the server has moved them, and a reload meanwhile
   * (a sync, the end of the previous action) must not bring them back for a moment.
   */
  private leaving = new Set<number>();

  /** Rows as the list shows them: without the ones on their way out. */
  private visible(rows: MessageRow[]): MessageRow[] {
    return this.leaving.size ? rows.filter((m) => !this.leaving.has(m.id)) : rows;
  }

  /** Appends a page: the cache's offsets count the hidden rows, so one may come twice. */
  private append(rows: MessageRow[]): MessageRow[] {
    const have = new Set(this.messages.map((m) => m.id));
    return [...this.messages, ...this.visible(rows).filter((m) => !have.has(m.id))];
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

  /** Takes messages out of the list and runs `run`; the moves it returns can be undone. */
  async perform(text: string, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string) {
    if (!ids.length) return;
    const p = this.track(this.doAct(text, ids, run, failText));
    this.pending = p;
    await p;
    if (this.pending === p) this.pending = null;
  }

  private async doAct(text: string, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string) {
    // "z" always means the latest action, never an older one.
    this.lastUndo = null;
    const all = await this.withConversation(ids);
    const hidden = [...new Set([...ids, ...all])];
    for (const id of hidden) this.leaving.add(id);
    this.takeOut(ids);
    try {
      const moved = (await run(all)).filter((m) => m.message_ids.length);
      if (this.windowOf !== null) {
        // The letter is done with: its window closes, the main window offers the undo.
        if (moved.length) await emitTo("main", "window-moved", { moved, text });
        await getCurrentWindow().close();
        return;
      }
      if (moved.length) {
        this.lastUndo = { moved, text };
        this.toast(text, false, { label: t("undo"), run: () => this.undo() });
      }
    } catch (e) {
      this.fail(e, failText);
    } finally {
      // Moved: the cache no longer has them here. Refused: they come back with the error.
      for (const id of hidden) this.leaving.delete(id);
    }
    this.reload();
  }

  remove(ids = this.selectedIds()) {
    return this.perform(tn("done.deleted", ids.length), ids, api.remove, t("err.delete"));
  }

  moveTo(folder: string, ids = this.selectedIds()) {
    const name = this.folders.find((f) => f.name === folder)?.display_name ?? folder;
    return this.perform(t("done.moved", { folder: name }), ids, (all) => api.move(all, folder), t("err.move"));
  }

  /** "Done": out of the inbox, into the archive. */
  archive(ids = this.selectedIds()) {
    return this.perform(tn("done.archived", ids.length), ids, api.archive, t("err.archive"));
  }

  spam(ids = this.selectedIds()) {
    return this.perform(t("done.spam"), ids, api.spam, t("err.spam"));
  }

  async undo() {
    if (!this.lastUndo && this.pending) await this.pending;
    const u = this.lastUndo;
    if (!u) return;
    this.lastUndo = null;
    try {
      await api.undo(u.moved);
      this.toast(t("done.undone"));
    } catch (e) {
      this.fail(e, t("err.undo"));
    }
    this.reload();
  }

  /** Queues the composition; it leaves after the undo delay or at `at`. */
  async send(accountId: string, draft: ComposeDraft, draftId: number | null, at: number | null, followupSecs: number | null) {
    const queued = await api.send(accountId, draft, draftId, at, followupSecs);
    const undo = { label: t("undo"), run: () => this.reopenOutbox(queued.id) };
    const secs = Math.round(queued.at - Date.now() / 1000);
    if (at) this.toast(t("toast.scheduled", { when: when(queued.at) }), false, undo, 10000);
    else if (secs > 0) this.toast(tn("toast.sending", secs), false, undo, secs * 1000);
  }

  /** Takes a queued message back into the composer. */
  async reopenOutbox(id: number) {
    try {
      const item = this.outbox.find((i) => i.id === id);
      const back = await api.outboxCancel(id);
      if (!back) {
        this.toast(t("toast.alreadySent"), true);
        return;
      }
      const attachments: AttachmentSource[] = [];
      for (const [name, , data] of back.attachments) {
        const path = await api.tempAttachment(name, data);
        attachments.push({ kind: "file", path, name, size: Math.floor((data.length * 3) / 4) });
      }
      const d = back.draft;
      this.openCompose({
        account_id: back.account_id,
        draft: {
          from: d.from,
          to: d.to,
          cc: d.cc,
          bcc: d.bcc,
          subject: d.subject,
          text: d.text,
          in_reply_to: d.in_reply_to,
          references: d.references,
          attachments,
          // A scheduled letter comes back with its time (as the Outbox tells them apart).
          send_at: item && item.attempts === 0 && item.next_attempt - item.created > 60 && item.next_attempt * 1000 > Date.now() ? item.next_attempt : null,
        },
        draft_id: null,
        unsaved: true,
      });
    } catch (e) {
      this.fail(e);
    }
  }

  async flag(change: "seen" | "flagged", value: boolean, ids = this.selectedIds()) {
    if (!ids.length) return;
    this.flagEpoch++;
    for (const id of ids) this.keep.add(id);
    for (const m of this.messages) if (ids.includes(m.id)) this.pin(m);
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

  openSettings(page = "general") {
    this.settingsPage = page;
    this.settingsOpen = true;
  }

  /** A mailbox's page in the settings; the very first one is set up by the wizard alone. */
  accountSettings(acc: AccountView | null) {
    if (this.accounts.length === 0) this.wizard = { account: null };
    else this.openSettings(acc ? `account:${acc.id}` : "account:new");
  }

  newMessage() {
    const acc = this.defaultAccount();
    if (!acc) {
      this.wizard = { account: null };
      return;
    }
    const draft = withSignature(emptyDraft({ name: acc.display_name, email: acc.email }), acc.signature);
    this.openCompose({ account_id: acc.id, draft, draft_id: null });
  }

  replyTo(all: boolean) {
    const msg = this.opened;
    const acc = msg && this.account(msg.row.account_id);
    if (!msg || !acc) return;
    // An answer already being written to this letter comes back instead of a second one.
    // A forward of it is threaded the same way and is not an answer.
    const same = this.composes.find(
      (c) => c.draft.in_reply_to && c.draft.in_reply_to === msg.view.summary.message_id && !isForward(c.draft.subject),
    );
    if (same) return this.showCompose(same.id);
    const draft = withSignature(reply(msg, { name: acc.display_name, email: acc.email }, all), acc.signature);
    this.openCompose({ account_id: acc.id, draft, draft_id: null });
  }

  forwardOpened() {
    const msg = this.opened;
    const acc = msg && this.account(msg.row.account_id);
    if (!msg || !acc) return;
    const draft = withSignature(forward(msg, { name: acc.display_name, email: acc.email }), acc.signature);
    this.openCompose({ account_id: acc.id, draft, draft_id: null });
  }

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
  openCompose(c: ComposeState, mode: ComposeWindow["mode"] = this.windowOf !== null ? "max" : "open"): number {
    // A saved draft opened again goes to its window.
    const open = c.draft_id !== null ? this.composes.find((w) => w.draft_id === c.draft_id) : undefined;
    if (open) {
      this.showCompose(open.id);
      return open.id;
    }
    const id = ++this.composeSeq;
    for (const w of this.composes) if (w.mode !== "min") w.mode = "min";
    this.composes.push({ ...c, id, mode, savedAt: null });
    return id;
  }

  /** Unfolds a window and folds the rest. */
  showCompose(id: number, mode: "open" | "max" = "open") {
    for (const w of this.composes) w.mode = w.id === id ? (w.mode === "max" ? "max" : mode) : "min";
  }

  closeCompose(id: number) {
    this.composes = this.composes.filter((w) => w.id !== id);
  }

  /** The window that takes dropped files: the unfolded one, else the newest. */
  activeCompose(): ComposeWindow | undefined {
    return this.composes.find((w) => w.mode !== "min") ?? this.composes.at(-1);
  }

  defaultAccount(): AccountView | undefined {
    const v = this.view;
    if (v.kind === "folder") return this.account(v.account_id);
    if (this.opened) return this.account(this.opened.row.account_id);
    return this.accounts[0];
  }
}

export const app = new AppStore();

/** One entry per letter, oldest first: a copy in the folder of the opened one wins over the one in Sent. */
function shownConversation(conversation: MessageRow[], id: number, folder: string): MessageRow[] {
  const shown = new Map<string, MessageRow>();
  for (const m of conversation) {
    const key = m.message_id ?? `#${m.id}`;
    const prev = shown.get(key);
    if (!prev || m.id === id || (prev.id !== id && m.folder === folder)) shown.set(key, m);
  }
  const unique = [...shown.values()].sort((a, b) => a.date - b.date || a.id - b.id);
  return unique.length > 1 ? unique : [];
}
