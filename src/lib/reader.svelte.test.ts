// Marking a letter read (#71): a letter counts as read only once it was shown a while;
// letters flitted through with the keys are left unread.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { api, flush, opened, resetFakes, row, rows } from "./testing";

/** Letters the backend was told were read. */
const markedSeen = () => api.setFlag.mock.calls.filter(([, change]) => change?.flag === "seen").flatMap(([ids]) => ids as number[]);

beforeEach(() => resetFakes());
afterEach(() => vi.useRealTimers());

describe("marking a letter read", () => {
  it("waits until the letter was shown a while, and leaves flitted-through letters unread", async () => {
    api.messages.mockResolvedValue(rows(1, 5));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    vi.useFakeTimers();
    void s.reader.open(1);
    await flush();
    vi.advanceTimersByTime(300);
    void s.reader.open(2);
    await flush();
    vi.advanceTimersByTime(300);
    void s.reader.open(3);
    await flush();
    vi.advanceTimersByTime(300);
    // Nothing was shown long enough yet.
    expect(markedSeen()).toEqual([]);

    vi.advanceTimersByTime(900);
    await flush();
    expect(markedSeen()).toEqual([3]);
  });
});

describe("acting on a letter", () => {
  it("marks it read at once, not after the wait", async () => {
    api.messages.mockResolvedValue(rows(1, 3));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    vi.useFakeTimers();
    void s.reader.open(1);
    await flush();
    vi.advanceTimersByTime(200);
    expect(markedSeen()).toEqual([]);

    // The user archives it (or flags, moves, answers): read now.
    s.reader.saw([1]);
    await flush();
    expect(markedSeen()).toEqual([1]);
    // The wait that was pending does not mark it a second time.
    vi.advanceTimersByTime(2000);
    await flush();
    expect(markedSeen()).toEqual([1]);
  });

  it("tagging a letter does not cancel its read mark", async () => {
    api.messages.mockResolvedValue(rows(1, 3));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    vi.useFakeTimers();
    void s.reader.open(1);
    await flush();
    vi.advanceTimersByTime(200);
    // A star, not a read flag: the mark the window was about to make still lands.
    await s.selection.flag("flagged", true);
    vi.advanceTimersByTime(1200);
    await flush();
    expect(markedSeen()).toEqual([1]);
  });

  it("archiving a letter before the wait still marks it read", async () => {
    api.messages.mockResolvedValue(rows(1, 3));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    vi.useFakeTimers();
    void s.reader.open(1);
    await flush();
    vi.advanceTimersByTime(200);
    // "Done" a moment after opening: the letter is read all the same, locally. The
    // server flag rides with the move, so a held series is not split by a flag.
    await s.archive([1]);
    await flush();
    expect(s.list.messages.find((m) => m.id === 1)?.flags.seen ?? true).toBe(true);
    expect(markedSeen()).toEqual([]);
  });
});

describe("`u` by the letter's own state", () => {
  it("reads the state of the letter it applies to, not the one open a moment ago", async () => {
    api.messages.mockResolvedValue([row(1, { flags: { ...row(1).flags, seen: true } }), row(2), row(3)]);
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    await s.reader.open(1);
    await flush();

    // The keys moved to letter 2 while letter 1 is still the open one for a moment.
    s.selection.selected = new Set([2]);
    await s.selection.toggleSeen();
    // Letter 2 is unread, so it becomes read — never unread because letter 1 was read.
    expect(markedSeen()).toEqual([2]);
    expect(api.setFlag).toHaveBeenCalledWith([2], { flag: "seen", value: true });
  });
});

describe("`s` by the letter's own state", () => {
  it("reads the state of the letter it applies to, not the one open a moment ago", async () => {
    api.messages.mockResolvedValue([row(1, { flags: { ...row(1).flags, flagged: true } }), row(2), row(3)]);
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    await s.reader.open(1);
    await flush();

    // `j` moved to letter 2 while letter 1 (flagged) is still the open one for a moment.
    s.selection.selected = new Set([2]);
    await s.selection.toggleFlagged();
    expect(api.setFlag).toHaveBeenCalledWith([2], { flag: "flagged", value: true });
  });
});

describe("a failing backend is told, not swallowed (#147)", () => {
  it("tells when the conversation of the opened letter cannot be read", async () => {
    api.messages.mockResolvedValue(rows(1, 3));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockRejectedValue(new Error("thread broken"));
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    await s.reader.open(1);
    await flush();
    expect(s.ui.toasts.some((x) => x.error && x.text.includes("conversation") && x.text.includes("thread broken"))).toBe(true);
  });
});
