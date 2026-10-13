import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { t } from "./i18n.svelte";
import { labels } from "./labels.svelte";
import { api, deferred, flush, opened, resetFakes, row, win } from "./testing";
import type { Moved, MessageRow } from "./types";

const ids = (s: AppStore) => s.list.messages.map((m) => m.id);

/** The inbox with five rows; the first three are conversations of two letters. */
async function inbox() {
  const list = [1, 2, 3, 4, 5].map((id) => row(id, { thread_count: id <= 3 ? 2 : 1 }));
  api.messages.mockResolvedValue(list);
  const s = new AppStore();
  await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
  return s;
}

/** A conversation of three letters (5, 6, 7), the newest (7) open in the pane. */
const dated = (id: number) => row(id, { date: 1000 + id });
async function threaded(grouped = true) {
  const chain = [5, 6, 7].map(dated);
  api.messages.mockResolvedValue(grouped ? [row(7, { date: 1007, thread_count: 3 }), dated(9)] : chain.map((m) => ({ ...m, thread_count: 3 })));
  const s = new AppStore();
  await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
  api.thread.mockImplementation(async () => chain);
  api.open.mockImplementation(async (id: number) => opened(dated(id)));
  await s.reader.open(7);
  await flush();
  return s;
}

beforeEach(() => resetFakes());

describe("an action", () => {
  it("takes the rows out before asking about their conversations", async () => {
    const s = await inbox();
    const pending = deferred<MessageRow[]>();
    api.thread.mockReturnValue(pending.promise);
    void s.actions.archive([1]);
    expect(ids(s)).not.toContain(1);
    expect(api.thread).toHaveBeenCalledWith(1);
    expect(api.archive).not.toHaveBeenCalled();
  });

  it("asks about every conversation at once", async () => {
    const s = await inbox();
    api.thread.mockReturnValue(new Promise(() => {}));
    void s.actions.archive([1, 2, 3]);
    await flush();
    for (const id of [1, 2, 3]) expect(api.thread).toHaveBeenCalledWith(id);
  });

  it("applies to the whole conversation of a row", async () => {
    const s = await inbox();
    api.thread.mockImplementation(async (id: number) => [row(id), row(id + 100), row(id + 200, { folder: "Sent" })]);
    await s.actions.archive([1]);
    expect(api.archive).toHaveBeenCalledWith(expect.arrayContaining([1, 101]), [1]);
    expect(api.archive.mock.calls[0][0]).not.toContain(201);
  });

  it.each([
    ["the conversation cannot be read", () => api.thread.mockRejectedValue({ kind: "other", message: "cache broken" })],
    ["the server refuses", () => api.archive.mockRejectedValue({ kind: "other", message: "cache broken" })],
  ])("that fails because %s is told, and the app goes on", async (_, breakIt) => {
    const s = await inbox();
    breakIt();
    await expect(s.actions.archive([1])).resolves.toBeUndefined();
    // A server error is told as such (#42, frame 8): not about rights, and it can be retried.
    expect(s.ui.toasts.some((x) => x.error && x.text === t("refuse.error", { folder: "INBOX" }))).toBe(true);
    expect(ids(s)).toEqual([1, 2, 3, 4, 5]);
    expect(s.list.leaving.size).toBe(0);
    await expect(s.actions.undo()).resolves.toBeUndefined();
    expect(api.undo).not.toHaveBeenCalled();
  });

  it("whose run throws at once does not reject either", async () => {
    const s = await inbox();
    const run = () => {
      throw new Error("plugin bug");
    };
    await expect(s.actions.perform("Done", [4], run, "Plugin")).resolves.toBeUndefined();
    expect(ids(s)).toContain(4);
    expect(s.ui.busy).toBe(0);
  });
});

describe("an action on a letter of the thread (0.8.4, #180)", () => {
  it("acts on that letter alone, without unfolding its conversation", async () => {
    // The list is not grouped: every letter of the thread is a row of it.
    const s = await threaded(false);
    const drop = vi.spyOn(s.list, "remove");
    await s.actions.remove([5], true);
    expect(api.remove.mock.calls[0][0]).toEqual([5]);
    // The conversation was not asked about: the whole thread is not deleted with the letter.
    expect(api.thread).toHaveBeenCalledTimes(1);
    // The row goes all the same; the reader is not touched.
    expect(drop).toHaveBeenCalledWith([5]);
    expect(s.reader.opened?.row.id).toBe(7);
  });

  it("leaves the letter the pane shows open, and takes the letter out of the conversation", async () => {
    // The list is grouped: 5 is not a row of it, only 7 is.
    const s = await threaded();
    const shown = s.reader.opened;
    await s.actions.remove([5], true);
    expect(s.reader.opened).toBe(shown);
    expect(s.reader.conversation.map((m) => m.id)).not.toContain(5);
    expect(ids(s)).toEqual([7, 9]);
  });

  it("does not close the window of a letter opened in one of its own", async () => {
    const s = new AppStore();
    s.windowOf = 7;
    const chain = [5, 6, 7].map(dated);
    api.thread.mockImplementation(async () => chain);
    api.open.mockImplementation(async (id: number) => opened(dated(id)));
    await s.reader.open(7);
    await flush();

    await s.actions.remove([5], true);
    expect(win.close).not.toHaveBeenCalled();
    expect(s.reader.opened?.row.id).toBe(7);
  });
});

describe("a refusal for lack of rights (#42, frame 8)", () => {
  it("brings the letter back and says so, with the folder's properties one click away", async () => {
    const s = await inbox();
    api.archive.mockRejectedValue({ kind: "no-rights", message: "сервер отказал: NOPERM" });
    await s.actions.archive([4]);
    // The letter is back in place.
    expect(ids(s)).toEqual([1, 2, 3, 4, 5]);
    // One notice, of the "no rights" kind, with a way to the folder's properties.
    const toast = s.ui.toasts.at(-1)!;
    expect(toast.text).toBe(t("refuse.noRights", { folder: "INBOX" }));
    expect(toast.error).toBe(true);
    expect(toast.action?.label).toBe(t("folder.properties"));
    // The button opens the folder's card.
    const card = vi.spyOn(labels, "openCard").mockImplementation(() => {});
    toast.action!.run();
    expect(card).toHaveBeenCalledWith("a", "INBOX");
  });

  it("a server error says it is not about rights", async () => {
    const s = await inbox();
    api.archive.mockRejectedValue({ kind: "other", message: "NO Internal error" });
    await s.actions.archive([4]);
    expect(ids(s)).toContain(4);
    const toast = s.ui.toasts.at(-1)!;
    expect(toast.text).toBe(t("refuse.error", { folder: "INBOX" }));
  });

  it("no answer is not a refusal: the letter waits, the tone is not red", async () => {
    const s = await inbox();
    api.archive.mockRejectedValue({ kind: "network", message: "timed out" });
    await s.actions.archive([4]);
    const toast = s.ui.toasts.at(-1)!;
    expect(toast.text).toBe(t("refuse.noAnswer", { folder: "INBOX" }));
    expect(toast.error).toBe(false);
  });
});

describe("undo", () => {  it("takes back the last action that went through", async () => {
    const s = await inbox();
    await s.actions.archive([4]);
    const moved = s.actions.lastUndo?.moved;
    expect(moved?.[0].message_ids).toEqual(["4"]);
    await s.actions.undo();
    expect(api.undo).toHaveBeenCalledWith(moved);
    expect(s.actions.lastUndo).toBeNull();
  });

  it("of a letter brought back from the snoozed mail snoozes it again for the same time (#93)", async () => {
    const s = await inbox();
    const snoozed = { account_id: "a", message_id: "<4@example.com>", folder: "Snoozed", return_to: "INBOX", until: 5000, subject: "Счёт" };
    const moved = { account_id: "a", from: "Snoozed", to: "INBOX", message_ids: ["<4@example.com>"], snoozed: [snoozed], unseen: [], waits: [] };
    const text = vi.fn((m: { to: string }[]) => `Возвращено во «${m[0].to}»: Счёт`);
    await s.actions.perform(text, [4], async () => [moved], "fail");
    expect(s.ui.toasts.some((x) => x.text === "Возвращено во «INBOX»: Счёт")).toBe(true);
    await s.actions.undo();
    // The backend sets the time again from what the move carried.
    expect(api.undo).toHaveBeenCalledWith([moved]);
  });

  it("pressed while the action is on its way waits for it", async () => {
    const s = await inbox();
    const answer = deferred<Moved[]>();
    api.archive.mockReturnValue(answer.promise);
    void s.actions.archive([4]);
    const undone = s.actions.undo();
    answer.resolve([{ account_id: "a", from: "INBOX", to: "Archive", message_ids: ["4"], unseen: [], snoozed: [], waits: [] }]);
    await undone;
    expect(api.undo).toHaveBeenCalledTimes(1);
  });

  it("after a failed action waits for it and does nothing", async () => {
    const s = await inbox();
    const answer = deferred<never>();
    api.archive.mockReturnValue(answer.promise);
    void s.actions.archive([4]);
    const undone = s.actions.undo();
    answer.reject({ kind: "other", message: "offline" });
    await expect(undone).resolves.toBeUndefined();
    await expect(s.actions.undo()).resolves.toBeUndefined();
    expect(api.undo).not.toHaveBeenCalled();
  });
});

describe("an offer to take back something that is not a move (#104)", () => {
  it("runs on z and is gone after ten seconds", async () => {
    vi.useFakeTimers();
    try {
      const s = new AppStore();
      const run = vi.fn(async () => {});
      s.actions.offer("Объединено: «Ольга», 2 адреса.", run);
      expect(s.actions.lastUndo?.text).toBe("Объединено: «Ольга», 2 адреса.");
      expect(s.ui.toasts.at(-1)?.action?.label).toBe(t("undo"));
      await s.actions.undo();
      expect(run).toHaveBeenCalledTimes(1);
      expect(s.actions.lastUndo).toBeNull();

      s.actions.offer("Ещё одно", run);
      vi.advanceTimersByTime(10_001);
      expect(s.actions.lastUndo).toBeNull();
      await s.actions.undo();
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an undo held while something else counts down", () => {
  it("is what z takes back instead of the older move, and goes when released", async () => {
    const s = await inbox();
    await s.actions.archive([1]);
    expect(s.actions.lastUndo?.moved.length).toBeGreaterThan(0);
    const run = vi.fn(async () => {});
    const release = s.actions.hold("Очистка Корзины", run);
    expect(s.actions.lastUndo?.text).toBe("Очистка Корзины");
    await s.actions.undo();
    expect(run).toHaveBeenCalledTimes(1);
    expect(api.undo).not.toHaveBeenCalled();

    const again = s.actions.hold("Ещё", run);
    again();
    expect(s.actions.lastUndo).toBeNull();
    // A release after something newer took the place does not remove the newer one.
    const old = s.actions.hold("Старое", run);
    s.actions.offer("Новое", run);
    old();
    expect(s.actions.lastUndo?.text).toBe("Новое");
    release();
  });
});

describe("an undo held over an older one", () => {
  it("gives the older back when it is let go, if it is still on offer", async () => {
    vi.useFakeTimers();
    try {
      const s = new AppStore();
      const older = vi.fn(async () => {});
      s.actions.offer("Старое", older);
      const release = s.actions.hold("Очистка", async () => {});
      expect(s.actions.lastUndo?.text).toBe("Очистка");
      release();
      expect(s.actions.lastUndo?.text).toBe("Старое");
      await s.actions.undo();
      expect(older).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not give back one that ran out meanwhile, or was taken back", async () => {
    vi.useFakeTimers();
    try {
      const s = new AppStore();
      s.actions.offer("Старое", async () => {});
      const release = s.actions.hold("Очистка", async () => {});
      vi.advanceTimersByTime(10_001);
      release();
      expect(s.actions.lastUndo).toBeNull();

      const run = vi.fn(async () => {});
      s.actions.offer("Другое", run);
      const again = s.actions.hold("Очистка", async () => {});
      await s.actions.undo();
      again();
      expect(s.actions.lastUndo).toBeNull();
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
