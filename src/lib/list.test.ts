import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { RELOAD_CAP, type View } from "./list.svelte";
import { api, deferred, emit, flush, opened, resetFakes, row, rows, settings } from "./testing";
import type { FolderInfo, ListQuery, MessageRow } from "./types";

const inbox: View = { kind: "folder", account_id: "a", folder: "INBOX" };
const archive: View = { kind: "folder", account_id: "a", folder: "Archive" };

/** A cache of rows the fake backend answers list queries from. */
function serve(cache: MessageRow[]) {
  api.messages.mockImplementation(async (q: ListQuery) => cache.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 200)));
}

const lastQuery = () => api.messages.mock.calls.at(-1)![0];

beforeEach(() => resetFakes());
afterEach(() => vi.useRealTimers());

describe("list reloads", () => {
  it("show the answer to the latest reload when an earlier one answers last", async () => {
    const s = new AppStore();
    await s.setView(inbox);
    const first = deferred<MessageRow[]>();
    const second = deferred<MessageRow[]>();
    api.messages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = s.reload();
    const b = s.reload();
    second.resolve(rows(10, 2));
    await b;
    first.resolve(rows(1, 3));
    await a;
    expect(s.messages.map((m) => m.id)).toEqual([10, 11]);
  });

  it("hold a search asked again while one is in flight, and show the latest", async () => {
    const s = new AppStore();
    const first = deferred<MessageRow[]>();
    api.search.mockResolvedValue([row(7)]);
    api.search.mockReturnValueOnce(first.promise);
    const a = s.setView({ kind: "search", text: "invoice" });
    await flush();
    expect(api.search).toHaveBeenCalledTimes(1);
    const b = s.setView({ kind: "search", text: "invoice" });
    await flush();
    // The second waits: no request while the first is in flight.
    expect(api.search).toHaveBeenCalledTimes(1);
    first.resolve([row(1), row(2)]);
    await Promise.all([a, b]);
    await flush();
    expect(s.messages.map((m) => m.id)).toEqual([7]);
  });

  it("of a search by size put the largest first, keep their own order and count what they found", async () => {
    const s = new AppStore();
    await s.loadSettings();
    api.search.mockResolvedValue([row(1)]);
    api.searchTotals.mockResolvedValue({ count: 412, size: 9 * 1024 ** 3 });
    await s.setView({ kind: "search", text: "larger:25MB year:2024" });
    expect(s.selection.listKey()).toBe("search:size");
    expect(api.search).toHaveBeenLastCalledWith("larger:25MB year:2024", [{ by: "size", desc: true }]);
    expect(s.searchTotals).toEqual({ count: 412, size: 9 * 1024 ** 3 });

    // Another order for searches by size stays theirs; other searches keep theirs.
    api.settingsPatch.mockResolvedValue(undefined);
    await s.selection.setSort([{ by: "date", desc: false }], true);
    expect(s.settings.view_sorts["search:size"]).toEqual([{ by: "date", desc: false }]);
    // The order is saved as a patch of its own keys, not the whole settings from memory.
    const patch = api.settingsPatch.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(["list_sort", "view_sorts"]);
    await s.setView({ kind: "search", text: "invoice" });
    expect(s.selection.listKey()).toBe("search");
    expect(api.search).toHaveBeenLastCalledWith("invoice", []);

    // Only a lower bound asks for large letters: "smaller than" keeps the search's order.
    await s.setView({ kind: "search", text: "меньше:1М" });
    expect(s.selection.listKey()).toBe("search");

    // Without totals the list still shows what it found.
    api.searchTotals.mockRejectedValue(new Error("old backend"));
    await s.setView({ kind: "search", text: "larger:1MB" });
    expect(s.messages.map((m) => m.id)).toEqual([1]);
    expect(s.searchTotals).toBeNull();
  });

  it("sum the size of the selection and select everything found", async () => {
    const s = new AppStore();
    api.search.mockResolvedValue([row(1, { size: 30 * 1024 ** 2 }), row(2, { size: 10 * 1024 ** 2, thread_size: 10 * 1024 ** 2 }), row(3, { size: 5 })]);
    api.searchTotals.mockResolvedValue({ count: 3, size: 40 * 1024 ** 2 + 5 });
    await s.setView({ kind: "search", text: "larger:1M" });
    await s.select(1);
    await s.select(2, "toggle");
    expect(s.selection.selectedSize()).toBe(40 * 1024 ** 2);
    s.selection.selectAll();
    expect([...s.selection.selected]).toEqual([1, 2, 3]);
    expect(s.selection.selectedSize()).toBe(40 * 1024 ** 2 + 5);
  });

  it("asked for by the previous view do not run after switching views", async () => {
    vi.useFakeTimers();
    const s = new AppStore();
    await s.setView(inbox);
    api.messages.mockClear();
    s.selection.scheduleReload();
    await s.setView(archive);
    vi.advanceTimersByTime(300);
    await flush();
    expect(api.messages).toHaveBeenCalledTimes(1);
    expect(lastQuery().folder).toBe("Archive");
  });

  it("after a server change read only the top of a long list and keep the rest", async () => {
    const cache = rows(1, 1500);
    serve(cache);
    api.accounts.mockResolvedValue([{ id: "a" } as never]);
    api.folders.mockResolvedValue([{ account_id: "a", name: "INBOX", role: "inbox" } as never]);
    const s = new AppStore();
    await s.init();
    while (s.messages.length < 1400) await s.selection.loadMore();
    s.selection.selected = new Set([1300]);
    cache.unshift(row(9999));

    vi.useFakeTimers();
    emit("mail-changed", { account_id: "a", folder: "INBOX" });
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    await flush();

    expect(lastQuery().limit).toBeLessThanOrEqual(RELOAD_CAP);
    expect(s.messages.length).toBe(1401);
    expect(s.messages[0].id).toBe(9999);
    expect(new Set(s.messages.map((m) => m.id)).size).toBe(1401);
    expect([...s.selection.selected]).toEqual([1300]);
  });

  it("read the whole loaded list again when asked directly", async () => {
    serve(rows(1, 1500));
    const s = new AppStore();
    await s.setView(inbox);
    while (s.messages.length < 1400) await s.selection.loadMore();
    await s.reload();
    expect(lastQuery().limit).toBe(1400);
  });
});

describe("a search while one is already in flight", () => {
  it("waits its turn, and the latest text wins", async () => {
    api.search.mockResolvedValue([row(2)]);
    const first = deferred<MessageRow[]>();
    api.search.mockReturnValueOnce(first.promise);
    const s = new AppStore();
    const a = s.setView({ kind: "search", text: "one" });
    await flush();
    expect(api.search).toHaveBeenCalledTimes(1);

    // Asked again while the first is in flight: held, not sent.
    const b = s.setView({ kind: "search", text: "two" });
    await flush();
    expect(api.search).toHaveBeenCalledTimes(1);

    first.resolve([row(1)]);
    await Promise.all([a, b]);
    await flush();
    expect(api.search).toHaveBeenCalledTimes(2);
    expect(api.search).toHaveBeenLastCalledWith("two", []);
    expect(s.messages.map((m) => m.id)).toEqual([2]);
  });
});

describe("marks kept by the view", () => {
  it("are let go once the letters left it", async () => {
    const cache = rows(1, 60);
    serve(cache);
    api.open.mockImplementation(async (id: number) => opened(cache.find((m) => m.id === id) ?? row(id)));
    const s = new AppStore();
    s.settings = { ...settings(), threads: false, list_sort: [{ by: "unread", desc: true }] };
    await s.setView({ kind: "unified", role: "inbox", unread: true });
    const gone = cache.slice(0, 50).map((m) => m.id);
    for (const id of gone) await s.open(id);
    await s.reload();
    expect(lastQuery().keep_ids).toHaveLength(50);

    cache.splice(0, 50);
    await s.archive(gone);
    await flush();
    await s.reload();
    const q = lastQuery();
    expect(q.keep_ids!.filter((id) => gone.includes(id))).toEqual([]);
    expect(q.pins!.filter((p) => gone.includes(p.id))).toEqual([]);
  });
});

describe("a letter whose answer takes it to Waiting for reply", () => {
  const going = (id: number, scheduled = false) => row(id, { outgoing: { act: "reply", at: 2_000_000_000, park: true, scheduled } });
  const ids = (s: AppStore) => s.messages.map((m) => m.id);

  const folder = (name: string, role: FolderInfo["role"]): FolderInfo => ({ account_id: "a", name, display_name: name, delimiter: "/", role, selectable: true, hidden: false, total: 0, unread: 0 });

  async function storeWith(cache: MessageRow[], view: View) {
    serve(cache);
    api.open.mockImplementation(async (id: number) => opened(cache.find((m) => m.id === id) ?? row(id)));
    api.folders.mockResolvedValue([folder("INBOX", "inbox"), folder("Archive", "archive")]);
    const s = new AppStore();
    await s.loadFolders();
    await s.setView(view);
    return s;
  }
  const inboxOf = (cache: MessageRow[]) => storeWith(cache, inbox);

  it("stays under the hand while it is open, and goes once another letter is opened", async () => {
    const cache = [row(1), row(2), row(3)];
    const s = await inboxOf(cache);
    await s.select(2);
    cache[1] = going(2);
    await s.reload();
    expect(ids(s)).toEqual([1, 2, 3]);
    // Sent: the server moved it while it is still open.
    cache.splice(1, 1);
    await s.reload();
    expect(ids(s)).toEqual([1, 2, 3]);
    expect(s.opened?.row.id).toBe(2);
    await s.select(3);
    expect(ids(s)).toEqual([1, 3]);
    await s.reload();
    expect(ids(s)).toEqual([1, 3]);
  });

  it("is not shown while its answer leaves when nobody is on it", async () => {
    const s = await inboxOf([row(1), going(2), row(3, { followup: { status: "waiting", due: 0, deadline: 0, own_deadline: false, repeat_secs: 0, expect: "", kind: "", ended: null, answered_by: null, answer: null, reminded: [], sent: 1, park: "pending", park_folder: "", auto_reply: null } })]);
    expect(ids(s)).toEqual([1]);
  });

  it("comes back when the sending is taken back", async () => {
    const cache = [row(1), row(2), row(3)];
    const s = await inboxOf(cache);
    await s.select(2);
    cache[1] = going(2);
    await s.reload();
    await s.select(1);
    expect(ids(s)).toEqual([1, 3]);
    cache[1] = row(2);
    await s.reload();
    expect(ids(s)).toEqual([1, 2, 3]);
  });

  it("an answer sent later leaves the letter in the inbox until then", async () => {
    const s = await inboxOf([row(1), going(2, true)]);
    expect(ids(s)).toEqual([1, 2]);
  });

  it("only inbox lists let it go: another folder shows it as it is", async () => {
    const s = await storeWith([row(1, { folder: "Archive" }), going(2)], archive);
    expect(ids(s)).toEqual([1, 2]);
  });
});
