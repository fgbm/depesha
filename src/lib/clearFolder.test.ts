import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { ClearFolder, DELAY_SECS, type ClearHost } from "./clearFolder.svelte";
import { t, tn } from "./i18n.svelte";
import { api, flush, resetFakes } from "./testing";
import type { AccountView, FolderInfo, Task } from "./types";

const folder = (role: FolderInfo["role"] | null, total = 128): FolderInfo => ({
  account_id: "a",
  name: role === "trash" ? "Trash" : role === "junk" ? "Spam" : "Drafts",
  display_name: "x",
  delimiter: "/",
  role,
  selectable: true,
  hidden: false,
  total,
  unread: 0,
});

/** The host with one mailbox, a toast log and a dialog the test answers. */
function host(over: { role?: FolderInfo["role"] | null; total?: number; online?: boolean; windows?: { account_id: string; draft_id: number | null; local_id: string }[]; tasks?: Task[] } = {}) {
  const f = folder("role" in over ? over.role! : "trash", over.total);
  const state = { online: over.online ?? true, answer: true };
  const toasts: { text: string; error: boolean; action?: { label: string; run: () => void }; ms?: number }[] = [];
  const asked: unknown[] = [];
  const h: ClearHost = {
    view: { kind: "folder", account_id: "a", folder: f.name },
    windowOf: null,
    composes: (over.windows ?? []) as never,
    tasks: over.tasks ?? [],
    account: () => ({ id: "a", status: { state: state.online ? "online" : "error" } }) as AccountView,
    folder: (acc, name) => (acc === "a" && name === f.name ? f : undefined),
    toast: (text, error = false, action, ms) => toasts.push({ text, error, action, ms }),
    retext: () => true,
    dismiss: () => {},
    confirm: async (q) => (asked.push(q), state.answer),
    track: (p) => p,
    fail: (e) => toasts.push({ text: String((e as Error).message), error: true }),
  };
  return { h, f, state, toasts, asked, clear: new ClearFolder(h) };
}

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers();
  api.folderTotal.mockResolvedValue({ total: 128, bound: 11 });
  api.openDrafts.mockResolvedValue(0);
  api.folderEmpty.mockResolvedValue({ total: 128, done: 128, stopped: false });
  api.draftCacheList.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("Clear on Trash, Spam and Drafts", () => {
  it("is offered in those three folders only", () => {
    for (const role of ["trash", "junk", "drafts"] as const) expect(host({ role }).clear.here()).not.toBeNull();
    for (const role of ["inbox", "sent", "archive", "snoozed", null] as const) expect(host({ role }).clear.here()).toBeNull();
  });

  it("is not offered in the window of a letter", () => {
    const x = host();
    const inWindow = new ClearFolder({ ...x.h, windowOf: 5 });
    expect(inWindow.here()).toBeNull();
  });

  it("is unavailable offline, and for an empty folder, with the reason", () => {
    const off = host({ online: false });
    expect(off.clear.reason(off.f)).toBe(t("clear.offline"));
    const none = host({ total: 0 });
    expect(none.clear.reason(none.f)).toBe(t("clear.nothing"));
    const ok = host();
    expect(ok.clear.reason(ok.f)).toBeNull();
  });

  it("asks with the number of letters on the server and sets the focus on Cancel", async () => {
    const x = host();
    api.folderTotal.mockResolvedValue({ total: 2100, bound: 11 });
    await x.clear.begin("a", "Trash");
    expect(api.folderTotal).toHaveBeenCalledWith("a", "Trash");
    const q = x.asked[0] as { text: string; okLabel: string; danger: boolean };
    expect(q.danger).toBe(true);
    expect(q.text).toContain("2100");
    expect(q.text).toContain("128");
    expect(q.okLabel).toContain("2100");
    expect(api.folderEmpty).not.toHaveBeenCalled();
  });

  it("tells the list's own number only when it differs from the server's", async () => {
    const same = host({ total: 128 });
    await same.clear.begin("a", "Trash");
    expect((same.asked[0] as { text: string }).text).toBe(t("clear.eraseText", { total: 128 }));
    const more = host({ total: 100 });
    await more.clear.begin("a", "Trash");
    expect((more.asked[0] as { text: string }).text).toContain("100");
  });

  it("does nothing when the question is declined", async () => {
    const x = host();
    x.state.answer = false;
    await x.clear.begin("a", "Trash");
    await vi.advanceTimersByTimeAsync(DELAY_SECS * 1000 + 100);
    expect(api.folderEmpty).not.toHaveBeenCalled();
    expect(x.toasts).toEqual([]);
  });

});

describe("Clear: the delay after the question", () => {
  it("waits out the delay with a way to cancel it, and only then asks the server", async () => {
    const x = host();
    await x.clear.begin("a", "Trash");
    expect(x.toasts[0].action?.label).toBe(t("undo"));
    expect(x.toasts[0].ms).toBe(DELAY_SECS * 1000);
    await vi.advanceTimersByTimeAsync(DELAY_SECS * 1000 - 100);
    expect(api.folderEmpty).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(api.folderEmpty).toHaveBeenCalledWith("a", "Trash", [], 11);
    await flush();
    expect(x.toasts.at(-1)?.text).toBe(t("clear.done.trash", { n: 128 }));
  });

  it("changes nothing when the delay is cancelled", async () => {
    const x = host();
    await x.clear.begin("a", "Trash");
    x.toasts[0].action!.run();
    await vi.advanceTimersByTimeAsync(DELAY_SECS * 1000 + 1000);
    expect(api.folderEmpty).not.toHaveBeenCalled();
  });

  it("does not begin when the network is gone during the delay", async () => {
    const x = host();
    await x.clear.begin("a", "Trash");
    x.state.online = false;
    await vi.advanceTimersByTimeAsync(DELAY_SECS * 1000 + 100);
    expect(api.folderEmpty).not.toHaveBeenCalled();
    expect(x.toasts.at(-1)).toMatchObject({ text: t("clear.lost"), error: true });
  });

  it("does not even ask offline", async () => {
    const x = host({ online: false });
    await x.clear.begin("a", "Trash");
    expect(api.folderTotal).not.toHaveBeenCalled();
    expect(x.asked).toEqual([]);
    expect(x.toasts[0]).toMatchObject({ text: t("clear.offline"), error: true });
  });

  it("sends no request for a folder that is empty on the server", async () => {
    const x = host();
    api.folderTotal.mockResolvedValue({ total: 0, bound: 11 });
    await x.clear.begin("a", "Trash");
    expect(x.asked).toEqual([]);
    expect(api.folderEmpty).not.toHaveBeenCalled();
    expect(x.toasts[0].text).toBe(t("clear.nothing"));
  });

  it("is not begun twice for one folder", async () => {
    const x = host();
    await x.clear.begin("a", "Trash");
    await x.clear.begin("a", "Trash");
    expect(x.asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DELAY_SECS * 1000 + 100);
    expect(api.folderEmpty).toHaveBeenCalledTimes(1);
  });

});

describe("Clear: what the backend answers", () => {
  it("says how far it got when it was stopped", async () => {
    const x = host();
    api.folderEmpty.mockResolvedValue({ total: 2100, done: 340, stopped: true });
    await x.clear.begin("a", "Trash");
    await vi.advanceTimersByTimeAsync(DELAY_SECS * 1000 + 100);
    await flush();
    expect(x.toasts.at(-1)?.text).toBe(t("clear.stopped", { done: 340, total: 2100 }));
  });

  it("tells the summary of a failure, with a retry that does not ask again", async () => {
    const task: Task = { key: "empty:a:Trash", kind: "empty", account_id: "a", label: "x", done: 0, total: 0, state: "failed", error: { kind: "network", message: "Стёрто 1200 из 2100, осталось 900. timeout" }, started: 1 };
    const x = host({ tasks: [task] });
    api.folderEmpty.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    await x.clear.begin("a", "Trash");
    await vi.advanceTimersByTimeAsync(DELAY_SECS * 1000 + 100);
    await flush();
    const failed = x.toasts.at(-1)!;
    expect(failed).toMatchObject({ text: task.error!.message, error: true });
    expect(failed.action?.label).toBe(t("retry"));
    failed.action!.run();
    await flush();
    expect(api.folderEmpty).toHaveBeenCalledTimes(2);
    expect(x.asked).toHaveLength(1);
  });

  it("retries on what the question counted, not on a fresh count of the folder", async () => {
    const x = host();
    api.folderEmpty.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    await x.clear.begin("a", "Trash");
    await vi.advanceTimersByTimeAsync(DELAY_SECS * 1000 + 100);
    await flush();
    // The folder has grown meanwhile; a count taken now would be another bound.
    api.folderTotal.mockResolvedValue({ total: 500, bound: 12 });
    x.toasts.at(-1)!.action!.run();
    await flush();
    expect(api.folderEmpty).toHaveBeenNthCalledWith(1, "a", "Trash", [], 11);
    expect(api.folderEmpty).toHaveBeenNthCalledWith(2, "a", "Trash", [], 11);
    expect(api.folderTotal).toHaveBeenCalledTimes(1);
    expect(x.asked).toHaveLength(1);
  });

  it("asks again to retry a clearing it has no count of", async () => {
    const x = host();
    const task = { key: "empty:a:Trash", kind: "empty", account_id: "a" } as Task;
    await x.clear.retryTask(task);
    expect(api.taskDismiss).toHaveBeenCalledWith("empty:a:Trash");
    expect(api.folderEmpty).not.toHaveBeenCalled();
    expect(x.asked).toHaveLength(1);
  });
});

describe("Clear on Drafts", () => {
  const open = [
    { account_id: "a", draft_id: 7, local_id: "k1" },
    { account_id: "a", draft_id: null, local_id: "k2" },
    { account_id: "b", draft_id: 9, local_id: "k3" },
  ];

  it("names what stays: the draft in a window and the copy not on the server", async () => {
    const x = host({ role: "drafts", total: 5, windows: open });
    api.folderTotal.mockResolvedValue({ total: 5, bound: 11 });
    api.draftCacheList.mockResolvedValue([
      { key: "k2", account_id: "a", draft: {} as never, draft_id: null, updated: 1 },
      { key: "old", account_id: "a", draft: {} as never, draft_id: null, updated: 1 },
      { key: "synced", account_id: "a", draft: {} as never, draft_id: 3, updated: 1 },
      { key: "other", account_id: "b", draft: {} as never, draft_id: null, updated: 1 },
    ]);
    await x.clear.begin("a", "Drafts");
    const q = x.asked[0] as { text: string; okLabel: string; items: string[] };
    // Five on the server, one of them open: four go to the Trash.
    expect(q.okLabel).toContain("4");
    expect(q.items).toEqual([tn("clear.keptOpen", 1), tn("clear.keptCopies", 1)]);
    await vi.advanceTimersByTimeAsync(DELAY_SECS * 1000 + 100);
    expect(api.folderEmpty).toHaveBeenCalledWith("a", "Drafts", [7], 11);
  });

  it("counts the drafts open in the windows of letters too, as the backend knows them", async () => {
    const x = host({ role: "drafts", total: 5 });
    api.folderTotal.mockResolvedValue({ total: 5, bound: 11 });
    api.openDrafts.mockResolvedValue(2);
    await x.clear.begin("a", "Drafts");
    const q = x.asked[0] as { okLabel: string; items: string[] };
    expect(api.openDrafts).toHaveBeenCalledWith("a");
    expect(q.okLabel).toContain("3");
    expect(q.items).toEqual([tn("clear.keptOpen", 2)]);
  });

  it("has nothing to do when every draft is open", async () => {
    const x = host({ role: "drafts", windows: [{ account_id: "a", draft_id: 7, local_id: "k1" }] });
    api.folderTotal.mockResolvedValue({ total: 1, bound: 11 });
    await x.clear.begin("a", "Drafts");
    expect(x.asked).toEqual([]);
    expect(x.toasts[0].text).toBe(t("clear.allOpen"));
  });
});
