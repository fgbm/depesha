import { listen } from "@tauri-apps/api/event";
import { api, asError } from "./api";
import type {
  Account,
  AccountStatus,
  AccountView,
  CmdError,
  ComposeDraft,
  FolderInfo,
  FolderRole,
  ListQuery,
  MessageRow,
  OpenedMessage,
  OutboxItem,
} from "./types";

export type View =
  | { kind: "unified"; role: FolderRole; unread?: boolean; flagged?: boolean }
  | { kind: "folder"; account_id: string; folder: string }
  | { kind: "search"; text: string }
  | { kind: "outbox" };

export interface Toast {
  id: number;
  text: string;
  error: boolean;
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

  private toastSeq = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private openSeq = 0;

  async init() {
    await Promise.all([this.loadAccounts(), this.loadFolders(), this.loadOutbox()]);
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
    await listen<{ subject: string }>("sent", (e) => this.toast(`Отправлено: ${e.payload.subject || "(без темы)"}`));
    await listen<{ error: CmdError }>("send-failed", (e) =>
      this.toast(`Письмо не отправлено: ${e.payload.error.message}. Оно в «Исходящих».`, true),
    );
    await listen<{ message: string }>("app-error", (e) => this.toast(e.payload.message, true));
  }

  toast(text: string, error = false) {
    const id = ++this.toastSeq;
    this.toasts.push({ id, text, error });
    setTimeout(() => this.dismiss(id), error ? 12000 : 4000);
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
    return v.kind === "search";
  }

  private query(offset: number): ListQuery | null {
    const v = this.view;
    if (v.kind === "folder") return { account_id: v.account_id, folder: v.folder, limit: PAGE, offset };
    if (v.kind === "unified")
      return { role: v.role, unread_only: !!v.unread, flagged_only: !!v.flagged, limit: PAGE, offset };
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
      this.fail(e, "Поиск на сервере");
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
      const wasUnread = !msg.row.flags.seen;
      msg.row.flags.seen = true;
      this.opened = msg;
      // Marked read on the server only after it was shown.
      if (wasUnread) {
        api.setFlag([id], { flag: "seen", value: true }).catch((e) => this.fail(e));
        const row = this.messages.find((m) => m.id === id);
        if (row) row.flags.seen = true;
      }
    } catch (e) {
      if (seq === this.openSeq) {
        this.opened = null;
        this.openError = asError(e);
      }
    } finally {
      if (seq === this.openSeq) this.opening = false;
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

  async remove(ids = this.selectedIds()) {
    if (!ids.length) return;
    const index = this.messages.findIndex((m) => m.id === ids[0]);
    this.messages = this.messages.filter((m) => !ids.includes(m.id));
    this.opened = null;
    this.selected = new Set();
    const next = this.messages[Math.min(index, this.messages.length - 1)];
    if (next) this.select(next.id);
    try {
      await api.remove(ids);
    } catch (e) {
      this.fail(e, "Не удалось удалить");
    }
    this.reload();
  }

  async moveTo(folder: string, ids = this.selectedIds()) {
    if (!ids.length) return;
    this.messages = this.messages.filter((m) => !ids.includes(m.id));
    this.opened = null;
    this.selected = new Set();
    try {
      await api.move(ids, folder);
    } catch (e) {
      this.fail(e, "Не удалось переместить");
    }
    this.reload();
  }

  async flag(change: "seen" | "flagged", value: boolean, ids = this.selectedIds()) {
    if (!ids.length) return;
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
