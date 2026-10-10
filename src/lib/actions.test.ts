import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { t } from "./i18n.svelte";
import { api, deferred, flush, resetFakes, row } from "./testing";
import type { MessageRow } from "./types";

const ids = (s: AppStore) => s.list.messages.map((m) => m.id);

/** The inbox with five rows; the first three are conversations of two letters. */
async function inbox() {
  const list = [1, 2, 3, 4, 5].map((id) => row(id, { thread_count: id <= 3 ? 2 : 1 }));
  api.messages.mockResolvedValue(list);
  const s = new AppStore();
  await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
  return s;
}

beforeEach(() => resetFakes());

describe("an action", () => {
  it("takes the rows out before asking about their conversations", async () => {
    const s = await inbox();
    const pending = deferred<MessageRow[]>();
    api.thread.mockReturnValue(pending.promise);
    void s.archive([1]);
    expect(ids(s)).not.toContain(1);
    expect(api.thread).toHaveBeenCalledWith(1);
    expect(api.archive).not.toHaveBeenCalled();
  });

  it("asks about every conversation at once", async () => {
    const s = await inbox();
    api.thread.mockReturnValue(new Promise(() => {}));
    void s.archive([1, 2, 3]);
    await flush();
    for (const id of [1, 2, 3]) expect(api.thread).toHaveBeenCalledWith(id);
  });

  it("applies to the whole conversation of a row", async () => {
    const s = await inbox();
    api.thread.mockImplementation(async (id: number) => [row(id), row(id + 100), row(id + 200, { folder: "Sent" })]);
    await s.archive([1]);
    expect(api.archive).toHaveBeenCalledWith(expect.arrayContaining([1, 101]), [1]);
    expect(api.archive.mock.calls[0][0]).not.toContain(201);
  });

  it.each([
    ["the conversation cannot be read", () => api.thread.mockRejectedValue({ kind: "other", message: "cache broken" })],
    ["the server refuses", () => api.archive.mockRejectedValue({ kind: "other", message: "cache broken" })],
  ])("that fails because %s is told, and the app goes on", async (_, breakIt) => {
    const s = await inbox();
    breakIt();
    await expect(s.archive([1])).resolves.toBeUndefined();
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

describe("a refusal for lack of rights (#42, frame 8)", () => {
  it("brings the letter back and says so, with the folder's properties one click away", async () => {
    const s = await inbox();
    api.archive.mockRejectedValue({ kind: "no-rights", message: "сервер отказал: NOPERM" });
    await s.archive([4]);
    // The letter is back in place.
    expect(ids(s)).toEqual([1, 2, 3, 4, 5]);
    // One notice, of the "no rights" kind, with a way to the folder's properties.
    const toast = s.ui.toasts.at(-1)!;
    expect(toast.text).toBe(t("refuse.noRights", { folder: "INBOX" }));
    expect(toast.error).toBe(true);
    expect(toast.action?.label).toBe(t("folder.properties"));
  });

  it("a server error says it is not about rights", async () => {
    const s = await inbox();
    api.archive.mockRejectedValue({ kind: "other", message: "NO Internal error" });
    await s.archive([4]);
    expect(ids(s)).toContain(4);
    const toast = s.ui.toasts.at(-1)!;
    expect(toast.text).toBe(t("refuse.error", { folder: "INBOX" }));
  });

  it("no answer is not a refusal: the letter waits, the tone is not red", async () => {
    const s = await inbox();
    api.archive.mockRejectedValue({ kind: "network", message: "timed out" });
    await s.archive([4]);
    const toast = s.ui.toasts.at(-1)!;
    expect(toast.text).toBe(t("refuse.noAnswer", { folder: "INBOX" }));
    expect(toast.error).toBe(false);
  });
});

describe("undo", () => {  it("takes back the last action that went through", async () => {
    const s = await inbox();
    await s.archive([4]);
    const moved = s.actions.lastUndo?.moved;
    expect(moved?.[0].message_ids).toEqual(["4"]);
    await s.actions.undo();
    expect(api.undo).toHaveBeenCalledWith(moved);
    expect(s.actions.lastUndo).toBeNull();
  });

  it("of a letter brought back from the snoozed mail snoozes it again for the same time (#93)", async () => {
    const s = await inbox();
    const snoozed = { account_id: "a", message_id: "<4@example.com>", folder: "Snoozed", return_to: "INBOX", until: 5000, subject: "Счёт" };
    const moved = { account_id: "a", from: "Snoozed", to: "INBOX", message_ids: ["<4@example.com>"], snoozed: [snoozed] };
    const text = vi.fn((m: { to: string }[]) => `Возвращено во «${m[0].to}»: Счёт`);
    await s.actions.perform(text, [4], async () => [moved], "fail");
    expect(s.ui.toasts.some((x) => x.text === "Возвращено во «INBOX»: Счёт")).toBe(true);
    await s.actions.undo();
    // The backend sets the time again from what the move carried.
    expect(api.undo).toHaveBeenCalledWith([moved]);
  });

  it("pressed while the action is on its way waits for it", async () => {
    const s = await inbox();
    const answer = deferred<{ account_id: string; from: string; to: string; message_ids: string[] }[]>();
    api.archive.mockReturnValue(answer.promise);
    void s.archive([4]);
    const undone = s.actions.undo();
    answer.resolve([{ account_id: "a", from: "INBOX", to: "Archive", message_ids: ["4"] }]);
    await undone;
    expect(api.undo).toHaveBeenCalledTimes(1);
  });

  it("after a failed action waits for it and does nothing", async () => {
    const s = await inbox();
    const answer = deferred<never>();
    api.archive.mockReturnValue(answer.promise);
    void s.archive([4]);
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
    await s.archive([1]);
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
