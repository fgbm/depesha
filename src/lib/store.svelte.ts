import { listen } from "@tauri-apps/api/event";
import { api, asError } from "./api";
import { when } from "./later";
import { i18n, t, tn } from "./i18n.svelte";
import type {
  Account,
  AccountStatus,
  AccountView,
  AttachmentSource,
  CmdError,
  ComposeDraft,
  Counters,
  FolderInfo,
  FolderRole,
  ListQuery,
  MessageRow,
  Moved,
  OpenedMessage,
  OutboxItem,
  Settings,
  UpdateStatus,
} from "./types";

export type View =
  | { kind: "unified"; role: FolderRole; unread?: boolean; flagged?: boolean }
  | { kind: "folder"; account_id: string; folder: string }
  | { kind: "search"; text: string }
  | { kind: "snoozed" }
  | { kind: "followups" }
  | { kind: "outbox" };

/** Inbox split: everything, mail from people, or lists and notifications. */
export type Split = "all" | "people" | "bulk";

export interface Toast {
  id: number;
  text: string;
  error: boolean;
  action?: { label: string; run: () => void };
}

export interface ComposeState {
  account_id: string;
  draft: ComposeDraft;
  /** Server draft this composition came from; removed after sending. */
  draft_id: number | null;
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
  allowRemote = $state(false);
  outbox = $state<OutboxItem[]>([]);
  toasts = $state<Toast[]>([]);
  compose = $state<ComposeState | null>(null);
  /** Server-side search: running, and rows it found (kept across list reloads). */
  serverSearching = $state(false);
  serverRows = $state<MessageRow[] | null>(null);
  wizard = $state<WizardState | null>(null);
  settings = $state<Settings>({ undo_send_secs: 10, notify: "people", dnd_until: 0, threads: true, templates: [], updates: "auto", language: "auto" });
  update = $state<UpdateStatus | null>(null);
  counters = $state<Counters>({ snoozed: 0, followups: 0 });
  split = $state<Split>((localStorage.getItem("depesha.split") as Split) ?? "all");
  /** The opened message's conversation, oldest first; empty for a lone message. */
  conversation = $state<MessageRow[]>([]);
  paletteOpen = $state(false);
  /** The snooze menu of the reader, opened by "h" too. */
  snoozeOpen = $state(false);
  settingsOpen = $state(false);
  /** The last move that can be taken back with "z". */
  lastUndo = $state<{ moved: Moved[]; text: string } | null>(null);

  private toastSeq = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private openSeq = 0;

  async init() {
    await this.loadLanguage();
    await Promise.all([this.loadAccounts(), this.loadFolders(), this.loadOutbox(), this.loadSettings(), this.loadCounters()]);
    await this.reload();
    if (this.accounts.length === 0) this.wizard = { account: null };

    await listen<{ account_id: string; folder: string }>("mail-changed", (e) => {
      if (this.viewIncludes(e.payload.account_id, e.payload.folder)) this.scheduleReload();
      this.scheduleFolders();
    });
    await listen("folders-changed", () => this.scheduleFolders());
    await listen<{ account_id: string; status: AccountStatus }>("account-status", (e) => {
      const a = this.accounts.find((x) => x.id === e.payload.account_id);
      if (a) a.status = e.payload.status;
    });
    await listen("outbox-changed", () => this.loadOutbox());
    await listen<{ subject: string }>("sent", (e) => this.toast(t("toast.sent", { subject: e.payload.subject || t("noSubject") })));
    await listen<{ error: CmdError }>("send-failed", (e) =>
      this.toast(t("toast.sendFailed", { error: e.payload.error.message }), true),
    );
    await listen<{ message: string }>("app-error", (e) => this.toast(e.payload.message, true));
    await listen("counters-changed", () => {
      this.loadCounters();
      if (this.view.kind === "snoozed" || this.view.kind === "followups") this.scheduleReload();
    });
    await listen("settings-changed", () => this.loadSettings());
    await listen<UpdateStatus>("update-status", (e) => (this.update = e.payload));
    this.update = await api.updateStatus().catch(() => null);
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
    } catch (e) {
      this.fail(e);
    }
  }

  async saveSettings(next: Settings) {
    const threadsChanged = next.threads !== this.settings.threads;
    this.settings = next;
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

  async loadCounters() {
    try {
      this.counters = await api.counters();
    } catch {
      // Counters are decoration; the list itself reports real errors.
    }
  }

  setSplit(split: Split) {
    this.split = split;
    localStorage.setItem("depesha.split", split);
    this.messages = [];
    this.exhausted = false;
    this.reload();
  }

  /** Inbox-like lists can be split into people and robots. */
  splittable(): boolean {
    const v = this.view;
    if (v.kind === "unified") return v.role === "inbox";
    if (v.kind === "folder") return this.folder(v.account_id, v.folder)?.role === "inbox";
    return false;
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

  folder(accountId: string, name: string) {
    return this.folders.find((f) => f.account_id === accountId && f.name === name);
  }

  private viewIncludes(accountId: string, folder: string): boolean {
    const v = this.view;
    if (v.kind === "folder") return v.account_id === accountId && v.folder === folder;
    if (v.kind === "unified") return this.folder(accountId, folder)?.role === v.role || folder === "INBOX";
    return v.kind === "search" || v.kind === "snoozed" || v.kind === "followups";
  }

  private query(offset: number): ListQuery | null {
    const v = this.view;
    const bulk = this.splittable() && this.split !== "all" ? this.split === "bulk" : null;
    const threads = this.settings.threads;
    if (v.kind === "folder") {
      const drafts = this.folder(v.account_id, v.folder)?.role === "drafts";
      return { account_id: v.account_id, folder: v.folder, bulk, threads: threads && !drafts, limit: PAGE, offset };
    }
    if (v.kind === "unified")
      return { role: v.role, unread_only: !!v.unread, flagged_only: !!v.flagged, bulk, threads, limit: PAGE, offset };
    if (v.kind === "snoozed") return { snoozed_only: true, limit: PAGE, offset };
    if (v.kind === "followups") return { followups_only: true, limit: PAGE, offset };
    return null;
  }

  scheduleReload() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.reload(), 250);
  }

  /** Reloads the current list keeping as many rows as are shown now. */
  async reload() {
    const v = this.view;
    try {
      if (v.kind === "search") {
        const local = v.text.trim() ? await api.search(v.text) : [];
        if (this.view !== v) return;
        this.messages = this.merge(local, this.serverRows ?? []);
        this.exhausted = true;
      } else if (v.kind === "outbox") {
        this.messages = [];
        this.exhausted = true;
        return;
      } else {
        const want = Math.max(PAGE, this.messages.length);
        const q = this.query(0)!;
        q.limit = want;
        const rows = await api.messages(q);
        // The user may have switched views while this was loading.
        if (this.view !== v) return;
        this.messages = rows;
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

  private merge(a: MessageRow[], b: MessageRow[]): MessageRow[] {
    const seen = new Set(a.map((m) => m.id));
    return [...a, ...b.filter((m) => !seen.has(m.id))].sort((x, y) => y.date - x.date);
  }

  /** Searches on the servers too: finds mail older than the local cache. */
  async searchServer() {
    const v = this.view;
    if (v.kind !== "search" || this.serverSearching) return;
    this.serverSearching = true;
    try {
      const rows = await api.serverSearch(v.text);
      if (this.view !== v) return;
      this.serverRows = rows;
      this.messages = this.merge(this.messages, rows);
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
      if (v.kind === "search" || v.kind === "outbox") return;
      if (!this.exhausted) {
        const rows = await api.messages(this.query(this.messages.length)!);
        if (this.view !== v) return;
        this.messages = [...this.messages, ...rows];
        this.exhausted = rows.length < PAGE;
      } else if (v.kind === "folder") {
        // The cache ran out: fetch older headers from the server.
        const n = await api.loadOlder(v.account_id, v.folder);
        if (n > 0 && this.view === v) {
          this.exhausted = false;
          const rows = await api.messages(this.query(this.messages.length)!);
          if (this.view !== v) return;
          this.messages = [...this.messages, ...rows];
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
    this.view = v;
    this.conversation = [];
    this.serverRows = null;
    this.messages = [];
    this.selected = new Set();
    this.opened = null;
    this.openError = null;
    this.exhausted = false;
    await this.reload();
    if (v.kind === "folder") api.syncNow(v.account_id, v.folder).catch(() => {});
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
        api.setFlag([id], { flag: "seen", value: true }).catch((e) => this.fail(e));
        const row = this.messages.find((m) => m.id === id);
        if (row) row.flags.seen = true;
      }
      this.loadConversation(id, seq, epoch, msg.row.folder);
    } catch (e) {
      if (seq === this.openSeq) {
        this.opened = null;
        this.openError = asError(e);
      }
    } finally {
      if (seq === this.openSeq) this.opening = false;
    }
  }

  /** Bumped by every flag change the user makes; late automatic marks yield to it. */
  private flagEpoch = 0;

  private async loadConversation(id: number, seq: number, epoch: number, folder: string) {
    const conversation = await api.thread(id).catch(() => [] as MessageRow[]);
    if (seq !== this.openSeq) return;
    // One entry per letter: a copy in this folder wins over the one in Sent.
    const shown = new Map<string, MessageRow>();
    for (const m of conversation) {
      const key = m.message_id ?? `#${m.id}`;
      const prev = shown.get(key);
      if (!prev || m.id === id || (prev.id !== id && m.folder === folder)) shown.set(key, m);
    }
    const unique = [...shown.values()].sort((a, b) => a.date - b.date || a.id - b.id);
    this.conversation = unique.length > 1 ? unique : [];
    // Reading a conversation reads all of it, unless the user changed flags meanwhile.
    const unread = conversation.filter((m) => !m.flags.seen && m.id !== id).map((m) => m.id);
    if (unread.length && epoch === this.flagEpoch) {
      api.setFlag(unread, { flag: "seen", value: true }).catch((e) => this.fail(e));
      for (const m of this.messages) if (unread.includes(m.id)) m.flags.seen = true;
    }
  }

  move(step: 1 | -1) {
    if (this.messages.length === 0) return;
    const current = this.opened?.row.id ?? [...this.selected][0];
    const i = this.messages.findIndex((m) => m.id === current);
    const next = this.messages[Math.min(this.messages.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
    if (next) this.select(next.id);
  }

  selectedIds(): number[] {
    if (this.selected.size) return [...this.selected];
    return this.opened ? [this.opened.row.id] : [];
  }

  /** Takes rows out of the list and opens the next one: triage keeps going. */
  private takeOut(ids: number[]) {
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
    if (!this.settings.threads) return ids;
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

  private async act(text: string, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string) {
    if (!ids.length) return;
    const p = this.doAct(text, ids, run, failText);
    this.pending = p;
    await p;
    if (this.pending === p) this.pending = null;
  }

  private async doAct(text: string, ids: number[], run: (ids: number[]) => Promise<Moved[]>, failText: string) {
    // "z" always means the latest action, never an older one.
    this.lastUndo = null;
    const all = await this.withConversation(ids);
    this.takeOut(ids);
    try {
      const moved = (await run(all)).filter((m) => m.message_ids.length);
      if (moved.length) {
        this.lastUndo = { moved, text };
        this.toast(text, false, { label: t("undo"), run: () => this.undo() });
      }
    } catch (e) {
      this.fail(e, failText);
    }
    this.reload();
  }

  remove(ids = this.selectedIds()) {
    return this.act(tn("done.deleted", ids.length), ids, api.remove, t("err.delete"));
  }

  moveTo(folder: string, ids = this.selectedIds()) {
    const name = this.folders.find((f) => f.name === folder)?.display_name ?? folder;
    return this.act(t("done.moved", { folder: name }), ids, (all) => api.move(all, folder), t("err.move"));
  }

  /** "Done": out of the inbox, into the archive. */
  archive(ids = this.selectedIds()) {
    return this.act(tn("done.archived", ids.length), ids, api.archive, t("err.archive"));
  }

  spam(ids = this.selectedIds()) {
    return this.act(t("done.spam"), ids, api.spam, t("err.spam"));
  }

  snooze(until: number, ids = this.selectedIds()) {
    return this.act(t("done.snoozed", { when: when(until) }), ids, (all) => api.snooze(all, until), t("err.snooze"));
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
  async send(accountId: string, draft: ComposeDraft, draftId: number | null, at: number | null, followupDays: number | null) {
    const queued = await api.send(accountId, draft, draftId, at, followupDays);
    const undo = { label: t("undo"), run: () => this.reopenOutbox(queued.id) };
    const secs = Math.round(queued.at - Date.now() / 1000);
    if (at) this.toast(t("toast.scheduled", { when: when(queued.at) }), false, undo, 10000);
    else if (secs > 0) this.toast(tn("toast.sending", secs), false, undo, secs * 1000);
  }

  /** Takes a queued message back into the composer. */
  async reopenOutbox(id: number) {
    try {
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
      this.compose = {
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
        },
        draft_id: null,
      };
    } catch (e) {
      this.fail(e);
    }
  }

  async flag(change: "seen" | "flagged", value: boolean, ids = this.selectedIds()) {
    if (!ids.length) return;
    this.flagEpoch++;
    for (const m of this.messages) if (ids.includes(m.id)) m.flags[change] = value;
    if (this.opened && ids.includes(this.opened.row.id)) this.opened.row.flags[change] = value;
    try {
      await api.setFlag(ids, { flag: change, value });
    } catch (e) {
      this.fail(e);
    }
  }

  defaultAccount(): AccountView | undefined {
    const v = this.view;
    if (v.kind === "folder") return this.account(v.account_id);
    if (this.opened) return this.account(this.opened.row.account_id);
    return this.accounts[0];
  }
}

export const app = new AppStore();
