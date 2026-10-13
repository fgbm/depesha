// The message list of the main window: the view, its rows, reloads and paging, search on
// the servers. The app store owns the reader (selection, the open letter) and hears from
// here which rows the list shows after each reload.

import type { MailboxController } from "./mailboxes.svelte";
import type { SettingsController } from "./settings.svelte";
import type { UiController } from "./ui.svelte";
import type { SelectionController } from "./selection.svelte";
import { api } from "./api";
import { t } from "./i18n.svelte";
import { debounce } from "./debounce";
import { compareRows } from "./sort";
import { LARGEST_FIRST, asksLarge } from "./largeMail";
import { shownConversation } from "./reader.svelte";
import { registry } from "../plugin-host/registry.svelte";
import type { ListFilter, ListScope } from "../plugin-api";
import type { FolderRole, ListQuery, MessageRow, Pin, SearchTotals, SortKey } from "./types";

/** The step between the rows of the list: the 62 px row and its 2 px of air (#177). */
export const ROW = 64;
/** A letter of an unfolded thread (#179): a little shorter, the group reads as one block. */
export const SUB = 58;

/** A row of the list as it is drawn (#179): a summary row, or a letter of an unfolded thread. */
export interface PlacedRow {
  m: MessageRow;
  /** A letter of an unfolded thread, drawn indented under its summary row. */
  sub: boolean;
  top: number;
  height: number;
}

/** The key of a thread: its mailbox and its name (#179) — the same name lives in each mailbox. */
export function threadKey(m: MessageRow): string {
  return `${m.account_id}\u0000${m.thread}`;
}

/** What a thread's row says that a reload compares: a letter arrived, or the newest one changed (#179). */
function threadSig(m: MessageRow): string {
  return `${m.thread_count}\u0000${m.thread_date}`;
}

/**
 * The rows of `placed` in sight (#179): `from` and `to` bound the window, and the rows are in
 * order, so the window is found by two binary searches rather than by walking every row.
 */
export function rowsInSight(rows: PlacedRow[], from: number, to: number): PlacedRow[] {
  // The first row whose bottom is past `from` (bottoms grow with the rows), then the first
  // whose top is at `to` or past it.
  const first = (past: (r: PlacedRow) => boolean) => {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (past(rows[mid])) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const start = first((r) => r.top + r.height > from);
  return rows.slice(start, first((r) => r.top >= to));
}

export type View =
  | { kind: "unified"; role: FolderRole; unread?: boolean; flagged?: boolean }
  | { kind: "folder"; account_id: string; folder: string }
  | { kind: "search"; text: string }
  /** A list contributed by a plugin (`ui.view`). */
  | { kind: "plugin"; id: string }
  | { kind: "outbox" }
  /** The address book (#104): not a list of letters. */
  | { kind: "people" };

export const PAGE = 200;

/**
 * A reload reads the whole loaded list again only up to this many rows. Scrolled further,
 * it reads this many from the top and keeps the rest of the loaded rows below them.
 */
export const RELOAD_CAP = 1000;

/** What the list needs from the app store. */
export interface ListHost {
  readonly mailboxes: Pick<MailboxController, "folder">;
  readonly settingsCtl: Pick<SettingsController, "settings">;
  readonly ui: Pick<UiController, "fail" | "track">;
  readonly selection: Pick<SelectionController, "listed" | "showing">;
  /** Rows the user is on: the selection and the open letter. */
  using(): number[];
}

export class ListController {
  view = $state<View>({ kind: "unified", role: "inbox" });
  messages = $state<MessageRow[]>([]);
  /** The threads unfolded in the list, by thread key (#179). */
  expandedThreads = $state<Set<string>>(new Set());
  /** The letters of an unfolded thread, by thread key: asked of the backend once. */
  threadLetters = $state<Map<string, MessageRow[]>>(new Map());
  /** A thread whose letters are on their way: a second click does not ask twice. */
  private askingThreads = new Set<string>();
  /** What each unfolded thread's row said when its letters were read (#179): a reload compares. */
  private threadSigs = new Map<string, string>();
  /** Numbers views: an answer of `thread` that arrives after the view changed is dropped (#179). */
  private viewEpoch = 0;
  /** All cached messages of the view are loaded; for folders, older ones may still be on the server. */
  exhausted = $state(false);
  loadingMore = $state(false);
  /** Server-side search: running, and rows it found (kept across list reloads). */
  serverSearching = $state(false);
  serverRows = $state<MessageRow[] | null>(null);
  /** How many letters the search finds in the cache and their size, beyond the rows shown. */
  totals = $state<SearchTotals | null>(null);
  /** Numbers beside the plugin's filter options (e.g. unread newsletters): what each would show. */
  filterCounts = $state<Record<string, number>>({});
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
  /** One search in flight; the next waits and the latest wins (#71). */
  private searchBusy = false;
  private searchWaiting: View | null = null;
  private searchWaiters: (() => void)[] = [];

  constructor(private host: ListHost) {}

  /** Inbox lists: all inboxes, or the inbox of one mailbox. */
  inboxLike(): boolean {
    const v = this.view;
    if (v.kind === "unified") return v.role === "inbox";
    if (v.kind === "folder") return this.host.mailboxes.folder(v.account_id, v.folder)?.role === "inbox";
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
    const role = v.kind === "folder" ? this.host.mailboxes.folder(v.account_id, v.folder)?.role : v.role;
    if (role === "sent" || role === "drafts") return null;
    return { filter, list: { key, inbox: this.inboxLike() } };
  }

  /** The order of the current list: its own, or the common one. */
  sort(): SortKey[] {
    const key = this.listKey();
    const s = this.host.settingsCtl.settings;
    return (key && s.view_sorts?.[key]) || (key === "search:size" ? LARGEST_FIRST : s.list_sort) || [];
  }

  /** The current list has an order of its own. */
  ownSort(): boolean {
    const key = this.listKey();
    return !!key && !!this.host.settingsCtl.settings.view_sorts?.[key];
  }

  /** The user read or (un)flagged the row: the current view keeps it and its place. */
  mark(id: number, row?: MessageRow) {
    this.keep.add(id);
    if (row && !this.pins.has(row.id)) this.pins.set(row.id, { id: row.id, unread: !row.flags.seen, flagged: row.flags.flagged });
  }

  /** Whether the thread of a row is unfolded in the list (#179). */
  threadOpen(m: MessageRow): boolean {
    return this.expandedThreads.has(threadKey(m));
  }

  /** The letters of an unfolded thread with this id, if they are loaded. */
  threadRow(id: number): MessageRow | undefined {
    for (const list of this.threadLetters.values()) {
      const m = list.find((r) => r.id === id);
      if (m) return m;
    }
    return undefined;
  }

  /** Folds every thread: a new view starts with none unfolded. */
  clearThreads() {
    this.expandedThreads = new Set();
    this.threadLetters = new Map();
    this.threadSigs = new Map();
    this.askingThreads.clear();
  }

  /**
   * Unfolds or folds the thread of a row right in the list (#179, decisions 0.8.3, 3.1 А);
   * the letters are asked of the backend once and kept, so folding and unfolding is instant.
   */
  async toggleThread(m: MessageRow) {
    const key = threadKey(m);
    if (this.expandedThreads.has(key)) {
      const next = new Set(this.expandedThreads);
      next.delete(key);
      this.expandedThreads = next;
      return;
    }
    this.expandedThreads = new Set(this.expandedThreads).add(key);
    if (!this.threadLetters.has(key)) await this.loadThread(m, this.viewEpoch);
  }

  /**
   * Reads the letters of a thread and keeps them (#179). The row's own letter is not among them:
   * it is the row itself, and two rows with one id would light up together and act as one. An
   * answer that arrives after the view changed is dropped, not written into the new view.
   */
  private async loadThread(m: MessageRow, epoch: number) {
    const key = threadKey(m);
    if (this.askingThreads.has(key)) return;
    this.askingThreads.add(key);
    try {
      const rows = await api.thread(m.id);
      if (epoch !== this.viewEpoch) return;
      // The same letters the reader shows: the copy in the row's own folder wins (#179, разбор №8).
      const letters = shownConversation(rows, m.id, m.folder).filter((l) => l.id !== m.id);
      this.threadLetters = new Map(this.threadLetters).set(key, letters);
      this.threadSigs = new Map(this.threadSigs).set(key, threadSig(m));
    } catch (e) {
      if (epoch === this.viewEpoch) this.host.ui.fail(e, t("reader.conversationFailed"));
    } finally {
      this.askingThreads.delete(key);
    }
  }

  /** A reload: the letters of an unfolded thread are read again when its row changed (#179). */
  private async refreshThreads() {
    if (!this.expandedThreads.size) return;
    const epoch = this.viewEpoch;
    const changed = this.messages.filter((m) => this.expandedThreads.has(threadKey(m)) && this.threadSigs.get(threadKey(m)) !== threadSig(m));
    await Promise.all(changed.map((m) => this.loadThread(m, epoch)));
  }

  /**
   * The rows the list shows now, in order, with their places (#179): the summary rows and,
   * under each unfolded thread, its letters. The list is virtualized by these places.
   */
  placed(): PlacedRow[] {
    const rows: PlacedRow[] = [];
    let top = 0;
    for (const m of this.messages) {
      rows.push({ m, sub: false, top, height: ROW });
      top += ROW;
      const key = threadKey(m);
      if (m.thread_count > 1 && this.expandedThreads.has(key)) {
        for (const l of this.threadLetters.get(key) ?? []) {
          rows.push({ m: l, sub: true, top, height: SUB });
          top += SUB;
        }
      }
    }
    return rows;
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
    if (v.kind === "unified") return this.host.mailboxes.folder(accountId, folder)?.role === v.role || (v.role === "inbox" && folder === "INBOX");
    return v.kind === "search" || v.kind === "plugin";
  }

  /** The list's own scope: its folder or role and the flags of the view, without any plugin filter. */
  private scopeQuery(v: View): ListQuery | null {
    const threads = this.host.settingsCtl.settings.threads;
    if (v.kind === "folder") {
      const drafts = this.host.mailboxes.folder(v.account_id, v.folder)?.role === "drafts";
      return { account_id: v.account_id, folder: v.folder, threads: threads && !drafts };
    }
    if (v.kind === "unified") {
      const keep_ids = v.unread || v.flagged ? [...this.keep] : [];
      return { role: v.role, unread_only: !!v.unread, flagged_only: !!v.flagged, keep_ids, threads };
    }
    return null;
  }

  private query(offset: number): ListQuery | null {
    const v = this.view;
    // The plugins' filter (People / Newsletters) narrows the list.
    const lf = this.listFilter();
    const filter = lf ? lf.filter.query(lf.list) : {};
    const sort = this.sort();
    // Pins matter only where the order looks at what they keep.
    const pins = sort.some((k) => k.by === "unread" || k.by === "flagged") ? [...this.pins.values()] : [];
    if (v.kind === "plugin") {
      const pv = registry.view(v.id);
      // Grouped like folders unless the view says otherwise.
      return pv ? { threads: this.host.settingsCtl.settings.threads, sort, pins, ...pv.query(), limit: PAGE, offset } : null;
    }
    const scope = this.scopeQuery(v);
    return scope ? { ...scope, ...filter, sort, pins, limit: PAGE, offset } : null;
  }

  /** Numbers beside the plugin's filter options: how many letters each would show. */
  private async loadFilterCounts(v: View, stale: () => boolean) {
    const lf = this.listFilter();
    const count = lf?.filter.count;
    const base = this.scopeQuery(v);
    if (!count || !lf || !base) {
      if (Object.keys(this.filterCounts).length) this.filterCounts = {};
      return;
    }
    const counts: Record<string, number> = {};
    for (const o of lf.filter.options()) {
      const extra = count(lf.list, o.id);
      if (!extra) continue;
      // The plugin narrows the list; it does not move the count to another folder or role.
      const filter: Partial<ListQuery> = {};
      if (extra.bulk !== undefined) filter.bulk = extra.bulk;
      if (extra.unread_only !== undefined) filter.unread_only = extra.unread_only;
      if (extra.flagged_only !== undefined) filter.flagged_only = extra.flagged_only;
      try {
        counts[o.id] = (await api.countMessages({ ...base, ...filter })) ?? 0;
      } catch {
        // The number is a nicety beside the option; the list itself is what matters.
      }
    }
    if (!stale()) this.filterCounts = counts;
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
        // One search at a time: a newer one waits, and only the latest is run (#71).
        if (this.searchBusy) {
          this.searchWaiting = v;
          await new Promise<void>((resolve) => this.searchWaiters.push(resolve));
          return;
        }
        this.searchBusy = true;
        try {
          const text = v.text.trim();
          const [local, totals] = text ? await Promise.all([api.search(v.text, this.sort()), this.countFound(v.text)]) : [[], null];
          if (stale()) return;
          this.messages = this.visible(this.merge(local, this.serverRows ?? []));
          this.totals = totals;
          this.exhausted = true;
        } finally {
          this.searchBusy = false;
          const waiting = this.searchWaiting;
          const waiters = this.searchWaiters;
          this.searchWaiting = null;
          this.searchWaiters = [];
          if (waiting && this.view === waiting) await this.reload();
          for (const done of waiters) done();
        }
      } else if (v.kind === "outbox" || v.kind === "people") {
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
        void this.loadFilterCounts(v, stale); // beside the list, not before it
        const rows = await api.messages(q);
        if (stale()) return;
        const before = this.messages;
        if (rows.length < q.limit || q.limit === want) {
          this.messages = this.held(before, this.visible(rows));
          this.exhausted = rows.length < want;
        } else {
          // Only the top was read: the rows loaded below it stay as they are.
          this.messages = this.held(before, this.visible(withTail(rows, this.messages)));
        }
      }
      // Marks of rows no longer in the view go; the open letter and rows on their way out keep theirs.
      const ids = new Set(this.messages.map((m) => m.id));
      const held = new Set([...ids, ...this.leaving, ...this.host.selection.showing()]);
      this.forget([...this.keep, ...this.pins.keys()].filter((id) => !held.has(id)));
      await Promise.all([this.refreshThreads(), this.host.selection.listed(ids, v.kind === "search")]);
    } catch (e) {
      this.host.ui.fail(e);
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
      // The total is a nicety next to the found letters.
      return null;
    }
  }

  /** Searches on the servers too: finds mail older than the local cache. */
  async searchServer() {
    const v = this.view;
    if (v.kind !== "search" || this.serverSearching) return;
    this.serverSearching = true;
    try {
      const rows = await this.host.ui.track(api.serverSearch(v.text));
      if (this.view !== v) return;
      this.serverRows = rows;
      this.messages = this.visible(this.merge(this.messages, rows));
      // What the servers found is in the cache now: the totals count it too.
      const totals = await this.countFound(v.text);
      if (this.view === v) this.totals = totals;
    } catch (e) {
      this.host.ui.fail(e, t("search.server"));
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
        const n = await this.host.ui.track(api.loadOlder(v.account_id, v.folder));
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
      this.host.ui.fail(e);
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
    this.filterCounts = {};
    this.messages = [];
    this.exhausted = false;
    // Unfolded threads belong to the list left behind (#179); letters still on their way
    // carry the old epoch and are dropped rather than shown in the new list.
    this.viewEpoch++;
    this.clearThreads();
  }

  /** Takes rows out of the list; returns where the first of them was, or -1. */
  remove(ids: number[]): number {
    const index = this.messages.findIndex((m) => ids.includes(m.id));
    if (index >= 0) this.messages = this.messages.filter((m) => !ids.includes(m.id));
    // A letter of an unfolded thread taken out goes too, not only the row of its thread (#179).
    if (this.threadLetters.size && [...this.threadLetters.values()].some((list) => list.some((m) => ids.includes(m.id)))) {
      const next = new Map<string, MessageRow[]>();
      for (const [key, list] of this.threadLetters) next.set(key, list.filter((m) => !ids.includes(m.id)));
      this.threadLetters = next;
    }
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
    const using = new Set(this.host.using());
    const queue = this.inboxLike();
    return rows.filter((m) => !this.leaving.has(m.id) && !(queue && goingToWait(m) && !using.has(m.id)));
  }

  /**
   * A letter going to "Waiting for reply" stays under the hand while the user is on it,
   * even once the server has moved it (ux.md, 7): it is put back where it was.
   */
  private held(before: MessageRow[], rows: MessageRow[]): MessageRow[] {
    if (!this.inboxLike()) return rows;
    const using = new Set(this.host.using());
    const have = new Set(rows.map((m) => m.id));
    const out = [...rows];
    before.forEach((m, i) => {
      if (using.has(m.id) && !have.has(m.id) && goingToWait(m) && !this.leaving.has(m.id)) out.splice(Math.min(i, out.length), 0, m);
    });
    return out;
  }

  /** The user left the rows going to wait: they go now, the ones in `keep` stay. */
  collapse(keep: Set<number>) {
    if (!this.inboxLike()) return;
    const next = this.messages.filter((m) => keep.has(m.id) || !goingToWait(m));
    if (next.length !== this.messages.length) this.messages = next;
  }

  /** Appends a page: the cache's offsets count the hidden rows, so one may come twice. */
  private append(rows: MessageRow[]): MessageRow[] {
    const have = new Set(this.messages.map((m) => m.id));
    return [...this.messages, ...this.visible(rows).filter((m) => !have.has(m.id))];
  }
}

/** Its answer takes the letter to "Waiting for reply" now: not a letter sent later. */
export function goingToWait(m: MessageRow): boolean {
  return (!!m.outgoing?.park && !m.outgoing.scheduled) || (m.followup?.status === "waiting" && m.followup.park === "pending");
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
