// The main window's list: which view it shows and in what order, the selection of rows,
// opening and moving through it. The list itself (./list.svelte) reads the rows; here is
// what the user does with them. `app.*` on the store delegates straight to these methods.

import { emitTo } from "@tauri-apps/api/event";
import { api } from "./api";
import { t } from "./i18n.svelte";
import type { ListController, View } from "./list.svelte";
import type { Reader } from "./reader.svelte";
import type { FolderInfo, MessageRow, Settings, SortKey } from "./types";

/** What the list view and the selection need from the app store. */
export interface SelectionHost {
  /** The letter of a separate message window; null in the main window. */
  readonly windowOf: number | null;
  readonly list: ListController;
  readonly reader: Reader;
  readonly settings: Settings;
  folder(accountId: string, name: string): FolderInfo | undefined;
  track<T>(p: Promise<T>): Promise<T>;
  fail(e: unknown, prefix?: string): void;
  saveSettings(next: Settings): Promise<void>;
  reload(): Promise<void>;
}

export class SelectionController {
  selected = $state<Set<number>>(new Set());
  anchor = $state<number | null>(null);

  constructor(private host: SelectionHost) {}

  /** Inbox lists: all inboxes, or the inbox of one mailbox. */
  inboxLike() { return this.host.list.inboxLike(); }
  /** The key the current list keeps its own order and filter under; null for lists without them. */
  listKey() { return this.host.list.listKey(); }
  /** The filter of plugins (People / Newsletters) with the list it applies to. */
  listFilter() { return this.host.list.listFilter(); }
  sort() { return this.host.list.sort(); }
  ownSort() { return this.host.list.ownSort(); }

  /** Orders the current list (`own`), or every list without an order of its own. */
  async setSort(sort: SortKey[], own = this.ownSort()) {
    const key = this.listKey();
    const view_sorts = { ...(this.host.settings.view_sorts ?? {}) };
    let list_sort = this.host.settings.list_sort ?? [];
    if (own && key) view_sorts[key] = sort;
    else {
      if (key) delete view_sorts[key];
      list_sort = sort;
    }
    this.host.list.unpin();
    await this.host.saveSettings({ ...this.host.settings, list_sort, view_sorts });
    this.host.reload();
  }

  /** Bytes of the selected rows: a conversation counts with its letters in the list. */
  selectedSize(): number {
    return this.host.list.messages.reduce((sum, m) => (this.selected.has(m.id) ? sum + (m.thread_size ?? m.size) : sum), 0);
  }

  /** Selects every row of the list: "Select all found" in a search, Ctrl+A. */
  selectAll() {
    if (this.host.windowOf !== null || !this.host.list.messages.length) return;
    this.selected = new Set(this.host.list.messages.map((m) => m.id));
  }

  scheduleReload() { this.host.list.scheduleReload(); }

  /** Reloads the current list keeping as many rows as are shown now; a message window has none. */
  async reload() {
    if (this.host.windowOf === null) await this.host.list.reload();
  }

  /** Letters the reader shows now: the open one and its conversation. */
  showing(): number[] { return this.host.reader.showing(); }

  /** The list was read again: selections of rows that disappeared (moved, deleted elsewhere) go. */
  async listed(ids: Set<number>, search: boolean) {
    const kept = [...this.selected].filter((id) => ids.has(id));
    if (kept.length !== this.selected.size) this.selected = new Set(kept);
    // Not in the list is not gone: a letter opened from its conversation (an older one,
    // my answer in Sent) is not a row of a grouped list. Closed only when it left the cache.
    const opened = this.host.reader.opened;
    if (opened && !ids.has(opened.row.id) && !search) {
      const rows = await api.messagesById([opened.row.id]).catch(() => null);
      if (rows?.length === 0 && this.host.reader.opened === opened) this.host.reader.opened = null;
    }
  }

  /** Searches on the servers too: finds mail older than the local cache. */
  searchServer() { return this.host.list.searchServer(); }
  loadMore() { return this.host.list.loadMore(); }

  async setView(v: View) {
    if (this.host.windowOf !== null) {
      // A message window has no list: the main window shows it.
      await emitTo("main", "window-view", v);
      return;
    }
    this.host.list.reset(v);
    this.host.reader.close();
    this.host.reader.openError = null;
    this.selected = new Set();
    // The list shows the cache at once; fresh mail from the server follows, with the progress line.
    if (v.kind === "folder") this.host.track(api.syncNow(v.account_id, v.folder)).catch(() => {});
    await this.host.reload();
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
      const a = this.host.list.messages.findIndex((m) => m.id === this.anchor);
      const b = this.host.list.messages.findIndex((m) => m.id === id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        this.selected = new Set(this.host.list.messages.slice(from, to + 1).map((m) => m.id));
        return;
      }
    } else {
      this.selected = new Set([id]);
      this.anchor = id;
    }
    // A letter going to "Waiting for reply" goes once the user leaves it.
    this.host.list.collapse(this.selected);
    await this.host.reader.open(id);
  }

  move(step: 1 | -1) {
    const rows = this.host.list.messages;
    if (rows.length === 0) return;
    const current = this.host.reader.opened?.row.id ?? [...this.selected][0];
    const i = rows.findIndex((m) => m.id === current);
    const next = rows[Math.min(rows.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
    if (next) this.select(next.id);
  }

  selectedIds(): number[] {
    // A message window acts on the letter it shows, also after a click in its conversation.
    if (this.host.windowOf !== null) return this.host.reader.opened ? [this.host.reader.opened.row.id] : [];
    if (this.selected.size) return [...this.selected];
    return this.host.reader.opened ? [this.host.reader.opened.row.id] : [];
  }

  /** Takes rows out of the list and opens the next one: triage keeps going. */
  takeOut(ids: number[]) {
    // A message window keeps showing its letter until the action is through.
    if (this.host.windowOf !== null) return;
    const index = this.host.list.remove(ids);
    this.host.reader.close();
    this.selected = new Set();
    const rows = this.host.list.messages;
    const next = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (next && index >= 0) this.select(next.id);
  }

  async flag(change: "seen" | "flagged", value: boolean, ids = this.selectedIds()) {
    if (!ids.length) return;
    this.host.reader.flagEpoch++;
    for (const id of ids) this.host.list.mark(id, this.host.list.messages.find((m) => m.id === id));
    for (const m of this.host.list.messages) if (ids.includes(m.id)) m.flags[change] = value;
    if (this.host.reader.opened && ids.includes(this.host.reader.opened.row.id)) this.host.reader.opened.row.flags[change] = value;
    try {
      await this.host.track(api.setFlag(ids, { flag: change, value }));
    } catch (e) {
      this.host.fail(e);
    }
  }

  /** Opens a letter in a window of its own; a draft opens in the composer instead. */
  async openWindow(row: MessageRow) {
    if (this.host.folder(row.account_id, row.folder)?.role === "drafts") {
      await this.select(row.id);
      return;
    }
    try {
      await api.messageWindow(row.id, row.subject || t("noSubject"));
    } catch (e) {
      this.host.fail(e);
    }
  }
}
