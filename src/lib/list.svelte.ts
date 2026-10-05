// The message list of the main window: the view, its rows, reloads and paging, search on
// the servers. The app store owns the reader (selection, the open letter) and hears from
// here which rows the list shows after each reload.

import { api } from "./api";
import { t } from "./i18n.svelte";
import { debounce } from "./debounce";
import { compareRows } from "./sort";
import { LARGEST_FIRST, asksLarge } from "./largeMail";
import { registry } from "../plugin-host/registry.svelte";
import type { ListFilter, ListScope } from "../plugin-api";
import type { FolderInfo, FolderRole, ListQuery, MessageRow, Pin, SearchTotals, Settings, SortKey } from "./types";

export type View =
  | { kind: "unified"; role: FolderRole; unread?: boolean; flagged?: boolean }
  | { kind: "folder"; account_id: string; folder: string }
  | { kind: "search"; text: string }
  /** A list contributed by a plugin (`ui.view`). */
  | { kind: "plugin"; id: string }
  | { kind: "outbox" };

export const PAGE = 200;

/**
 * A reload reads the whole loaded list again only up to this many rows. Scrolled further,
 * it reads this many from the top and keeps the rest of the loaded rows below them.
 */
export const RELOAD_CAP = 1000;

/** What the list needs from the app store. */
export interface ListHost {
  readonly settings: Settings;
  folder(accountId: string, name: string): FolderInfo | undefined;
  fail(e: unknown, prefix?: string): void;
  track<T>(p: Promise<T>): Promise<T>;
  /** Letters the reader shows now (the open one, its conversation): the list holds on to their marks. */
  showing(): number[];
  /** The list was read again and now holds `ids`: the selection and the open letter follow it. */
  listed(ids: Set<number>, search: boolean): Promise<void>;
}

export class ListController {
  view = $state<View>({ kind: "unified", role: "inbox" });
  messages = $state<MessageRow[]>([]);
  /** All cached messages of the view are loaded; for folders, older ones may still be on the server. */
  exhausted = $state(false);
  loadingMore = $state(false);
  /** Server-side search: running, and rows it found (kept across list reloads). */
  serverSearching = $state(false);
  serverRows = $state<MessageRow[] | null>(null);
  /** How many letters the search finds in the cache and their size, beyond the rows shown. */
  totals = $state<SearchTotals | null>(null);
  /** The server said the folder has nothing older: scrolling to the end does not ask again. */
  private noOlder = false;
  /** Messages read or (un)flagged in this view: "Unread" and "Flagged" keep them while they are in it. */
  private keep = new Set<number>();
  /** How rows read or (un)flagged in this view looked before: they keep their place in the order while they are in it. */
  private pins = new Map<number, Pin>();
  /**
   * Rows taken out by actions still on their way to the server. The cache keeps
   * them in their folder until the server has moved them, and a reload meanwhile
   * (a sync, the end of the previous action) must not bring them back for a moment.
   */
  readonly leaving = new Set<number>();
  /** Server changes come in bursts: the list reloads when one ends, at least once a second. */
  private reloadSoon = debounce(() => void this.reload(true), 250, 1000);
  /** Numbers reloads: only the answer to the latest one is shown, whatever order answers come in. */
  private reloadSeq = 0;

  constructor(private host: ListHost) {}

  /** Inbox lists: all inboxes, or the inbox of one mailbox. */
  inboxLike(): boolean {
    const v = this.view;
    if (v.kind === "unified") return v.role === "inbox";
    if (v.kind === "folder") return this.host.folder(v.account_id, v.folder)?.role === "inbox";
    return false;
  }

  /** The key the current list keeps its own order and filter under; null for lists without them. */
  listKey(): string | null {
    const v = this.view;
    if (v.kind === "folder") return `folder:${v.account_id}:${v.folder}`;
    if (v.kind === "unified") return `unified:${v.role}${v.unread ? ":unread" : v.flagged ? ":flagged" : ""}`;
    if (v.kind === "plugin") return `plugin:${v.id}`;
    // A search for large letters keeps an order of its own: the largest first, unless changed.
    if (v.kind === "search") return asksLarge(v.text) ? "search:size" : "search";
    return null;
  }

  /** The filter of plugins (People / Newsletters) with the list it applies to; lists of my own mail have none. */
  listFilter(): { filter: ListFilter; list: ListScope } | null {
    const v = this.view;
    const filter = registry.items("listFilters")[0];
    const key = this.listKey();
    if (!filter || !key || (v.kind !== "folder" && v.kind !== "unified")) return null;
    const role = v.kind === "folder" ? this.host.folder(v.account_id, v.folder)?.role : v.role;
    if (role === "sent" || role === "drafts") return null;
    return { filter, list: { key, inbox: this.inboxLike() } };
  }

  /** The order of the current list: its own, or the common one. */
  sort(): SortKey[] {
    const key = this.listKey();
    const s = this.host.settings;
    return (key && s.view_sorts?.[key]) || (key === "search:size" ? LARGEST_FIRST : s.list_sort) || [];
  }

  /** The current list has an order of its own. */
  ownSort(): boolean {
    const key = this.listKey();
    return !!key && !!this.host.settings.view_sorts?.[key];
  }

  /** The user read or (un)flagged the row: the current view keeps it and its place. */
  mark(id: number, row?: MessageRow) {
    this.keep.add(id);
    if (row && !this.pins.has(row.id)) this.pins.set(row.id, { id: row.id, unread: !row.flags.seen, flagged: row.flags.flagged });
  }

  /** Rows left the view (moved, deleted): nothing of theirs is kept. */
  forget(ids: Iterable<number>) {
    for (const id of ids) {
      this.keep.delete(id);
      this.pins.delete(id);
    }
  }

  /** A new order places every row anew: rows changed earlier no longer hold their places. */
  unpin() {
    this.pins = new Map();
  }

  includes(accountId: string, folder: string): boolean {
    const v = this.view;
    if (v.kind === "folder") return v.account_id === accountId && v.folder === folder;
    if (v.kind === "unified") return this.host.folder(accountId, folder)?.role === v.role || (v.role === "inbox" && folder === "INBOX");
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
    const threads = this.host.settings.threads;
    if (v.kind === "folder") {
      const drafts = this.host.folder(v.account_id, v.folder)?.role === "drafts";
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
    this.reloadSoon();
  }

  /**
   * Reloads the current list keeping as many rows as are shown now. `topOnly`, after
   * changes on the server: past `RELOAD_CAP` rows only the top is read again.
   */
  async reload(topOnly = false) {
    const seq = ++this.reloadSeq;
    const v = this.view;
    // The user may have switched views, or asked again, while this was loading.
    const stale = () => seq !== this.reloadSeq || this.view !== v;
    try {
      if (v.kind === "search") {
        const text = v.text.trim();
        const [local, totals] = text ? await Promise.all([api.search(v.text, this.sort()), this.countFound(v.text)]) : [[], null];
        if (stale()) return;
        this.messages = this.visible(this.merge(local, this.serverRows ?? []));
        this.totals = totals;
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
        q.limit = topOnly ? Math.min(want, RELOAD_CAP) : want;
        const rows = await api.messages(q);
        if (stale()) return;
        if (rows.length < q.limit || q.limit === want) {
          this.messages = this.visible(rows);
          this.exhausted = rows.length < want;
        } else {
          // Only the top was read: the rows loaded below it stay as they are.
          this.messages = this.visible(withTail(rows, this.messages));
        }
      }
      // Marks of rows no longer in the view go; the open letter and rows on their way out keep theirs.
      const ids = new Set(this.messages.map((m) => m.id));
      const held = new Set([...ids, ...this.leaving, ...this.host.showing()]);
      this.forget([...this.keep, ...this.pins.keys()].filter((id) => !held.has(id)));
      await this.host.listed(ids, v.kind === "search");
    } catch (e) {
      this.host.fail(e);
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

  /** The totals of a search; without them the list still shows what it found. */
  private async countFound(text: string): Promise<SearchTotals | null> {
    try {
      return (await api.searchTotals(text)) ?? null;
    } catch {
      return null;
    }
  }

  /** Searches on the servers too: finds mail older than the local cache. */
  async searchServer() {
    const v = this.view;
    if (v.kind !== "search" || this.serverSearching) return;
    this.serverSearching = true;
    try {
      const rows = await this.host.track(api.serverSearch(v.text));
      if (this.view !== v) return;
      this.serverRows = rows;
      this.messages = this.visible(this.merge(this.messages, rows));
      // What the servers found is in the cache now: the totals count it too.
      const totals = await this.countFound(v.text);
      if (this.view === v) this.totals = totals;
    } catch (e) {
      this.host.fail(e, t("search.server"));
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
      } else if (v.kind === "folder" && !this.noOlder) {
        // The cache ran out: fetch older headers from the server.
        const n = await this.host.track(api.loadOlder(v.account_id, v.folder));
        if (n === 0 && this.view === v) this.noOlder = true;
        if (n > 0 && this.view === v) {
          this.exhausted = false;
          const rows = await api.messages(this.query(this.messages.length)!);
          if (this.view !== v) return;
          this.messages = this.append(rows);
          this.exhausted = rows.length < PAGE;
        }
      }
    } catch (e) {
      this.host.fail(e);
    } finally {
      this.loadingMore = false;
    }
  }

  /** Switches to another list, empty until it is loaded. */
  reset(v: View) {
    this.view = v;
    this.noOlder = false;
    // A reload asked for by the previous view would load this one twice.
    this.reloadSoon.cancel();
    this.keep = new Set();
    this.pins = new Map();
    this.serverRows = null;
    this.totals = null;
    this.messages = [];
    this.exhausted = false;
  }

  /** Takes rows out of the list; returns where the first of them was, or -1. */
  remove(ids: number[]): number {
    const index = this.messages.findIndex((m) => ids.includes(m.id));
    if (index >= 0) this.messages = this.messages.filter((m) => !ids.includes(m.id));
    return index;
  }

  /** Puts rows taken out of `before` back where they were, if the list has not got them again. */
  restore(before: MessageRow[], ids: Set<number>) {
    const have = new Set(this.messages.map((m) => m.id));
    const list = [...this.messages];
    before.forEach((m, i) => {
      if (ids.has(m.id) && !have.has(m.id) && !this.leaving.has(m.id)) list.splice(Math.min(i, list.length), 0, m);
    });
    if (list.length !== this.messages.length) this.messages = list;
  }

  /** Rows as the list shows them: without the ones on their way out. */
  private visible(rows: MessageRow[]): MessageRow[] {
    return this.leaving.size ? rows.filter((m) => !this.leaving.has(m.id)) : rows;
  }

  /** Appends a page: the cache's offsets count the hidden rows, so one may come twice. */
  private append(rows: MessageRow[]): MessageRow[] {
    const have = new Set(this.messages.map((m) => m.id));
    return [...this.messages, ...this.visible(rows).filter((m) => !have.has(m.id))];
  }
}

/**
 * The freshly read top of the list followed by the loaded rows below it. The tail starts
 * after the last row of the top as the list had it, so rows gone from the top stay gone.
 */
function withTail(top: MessageRow[], loaded: MessageRow[]): MessageRow[] {
  const inTop = new Set(top.map((m) => m.id));
  const last = top.length ? loaded.findIndex((m) => m.id === top[top.length - 1].id) : -1;
  const from = last >= 0 ? last + 1 : Math.min(top.length, loaded.length);
  return [...top, ...loaded.slice(from).filter((m) => !inTop.has(m.id))];
}
