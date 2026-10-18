import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { BULK_LIMIT } from "./actions.svelte";
import { i18n, t, tn } from "./i18n.svelte";
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

/** `n` rows of the inbox, none of them a conversation. */
async function many(n: number) {
  api.messages.mockResolvedValue(Array.from({ length: n }, (_, i) => row(i + 1)));
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

// The rows leave the list at once on the quick way, so the key after a key finds the next row (#196).
describe("keys pressed faster than the conversations are read (#196)", () => {
  it("takes the next row for a key pressed before the conversation is read", async () => {
    api.messages.mockResolvedValue([row(1, { thread_count: 2 }), row(2, { thread_count: 2 }), row(3)]);
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    await s.selection.select(1);
    api.thread.mockClear();
    vi.useFakeTimers();
    try {
      // The server takes its time over every conversation.
      const reading: ReturnType<typeof deferred<MessageRow[]>>[] = [];
      api.thread.mockImplementation(() => {
        const a = deferred<MessageRow[]>();
        reading.push(a);
        return a.promise;
      });
      void s.actions.archive();
      void s.actions.archive();
      // Each key takes its own row out at once, the answer of the server still on its way.
      expect(api.thread.mock.calls.map((c) => c[0])).toEqual([1, 2]);
      expect(s.list.messages.map((m) => m.id)).toEqual([3]);
      expect([...s.selection.selected]).toEqual([3]);

      reading.forEach((a) => a.resolve([]));
      await flush();
      expect(api.archive.mock.calls.map((c) => c[1])).toEqual([[1], [2]]);
      expect(s.list.leaving.size).toBe(0);

      // The reader was not left empty: the row the cursor stopped on opens.
      vi.advanceTimersByTime(200);
      await flush();
      expect(s.reader.opened?.row.id).toBe(3);
    } finally {
      vi.useRealTimers();
    }
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
    s.mailboxes.folders = [{ account_id: "a", name: "Trash", role: "trash" }] as never;
    const shown = s.reader.opened;
    // The trash takes the letter out of the thread, as the backend's `thread` leaves it out (#180).
    api.remove.mockResolvedValue([{ account_id: "a", from: "INBOX", to: "Trash", message_ids: ["<5@example.com>"], unseen: [], snoozed: [], waits: [] }]);
    await s.actions.remove([5], true);
    expect(s.reader.opened).toBe(shown);
    expect(s.reader.conversation.map((m) => m.id)).not.toContain(5);
    expect(ids(s)).toEqual([7, 9]);
  });

  it("keeps the letter in the conversation when the archive leaves it in the thread (#180)", async () => {
    const s = await threaded();
    s.mailboxes.folders = [{ account_id: "a", name: "Archive", role: "archive" }] as never;
    api.archive.mockResolvedValue([{ account_id: "a", from: "INBOX", to: "Archive", message_ids: ["<5@example.com>"], unseen: [], snoozed: [], waits: [] }]);
    await s.actions.archive([5], true);
    // The letter keeps its place; only the folder it names changed.
    expect(s.reader.conversation.map((m) => m.id)).toContain(5);
    expect(s.reader.conversation.find((m) => m.id === 5)?.folder).toBe("Archive");
    // A row the list shows on screen is not touched: 5 is not one of them here.
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

// A slip of «select all» must not take thousands of letters out without a word (#196).
describe("many letters at once (#196)", () => {
  it("takes ten out without a question", async () => {
    const s = await many(BULK_LIMIT);
    const all = ids(s);
    await s.actions.remove(all);
    expect(s.ui.confirmation).toBeNull();
    expect(api.remove).toHaveBeenCalledWith(all, all);
  });

  it("asks about eleven, and a refusal changes nothing", async () => {
    const s = await many(BULK_LIMIT + 1);
    const all = ids(s);
    const p = s.actions.remove(all);
    await flush();
    expect(s.ui.confirmation?.title).toContain("11");
    // A destructive action: the dialog puts the focus on Cancel, not on «Удалить».
    expect(s.ui.confirmation?.danger).toBe(true);
    s.ui.confirmation!.resolve(false);
    await p;
    expect(api.remove).not.toHaveBeenCalled();
    expect(ids(s)).toEqual(all);
    expect(s.list.leaving.size).toBe(0);
    expect(s.actions.lastUndo).toBeNull();
  });

  it("takes eleven out once the question is agreed to, and offers the undo as usual", async () => {
    const s = await many(BULK_LIMIT + 1);
    const all = ids(s);
    const p = s.actions.remove(all);
    await flush();
    s.ui.confirmation!.resolve(true);
    await p;
    expect(api.remove.mock.calls[0][0]).toEqual(all);
    expect(s.ui.toasts.some((x) => x.action?.label === t("undo"))).toBe(true);
    expect(s.actions.lastUndo?.moved.length).toBe(1);
  });

  it("counts the letters of the conversations, not the rows", async () => {
    api.messages.mockResolvedValue(Array.from({ length: 6 }, (_, i) => row(i + 1, { thread_count: 2 })));
    api.thread.mockImplementation(async (id: number) => [row(id), row(id + 100)]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    const p = s.actions.remove(ids(s));
    await flush();
    expect(s.ui.confirmation?.title).toContain("12");
    s.ui.confirmation!.resolve(false);
    await p;
    expect(api.remove).not.toHaveBeenCalled();
  });
});

// The question names the action and does not promise an undo it cannot give (#196).
describe("the question about many letters (#196)", () => {
  it("names the folder a move of many letters goes to", async () => {
    const s = await many(BULK_LIMIT + 1);
    s.mailboxes.folders = [{ account_id: "a", name: "Archive", role: "archive", display_name: "Архив" }] as never;
    const p = s.actions.moveTo("Archive", ids(s));
    await flush();
    expect(s.ui.confirmation?.title).toContain("Архив");
    s.ui.confirmation!.resolve(false);
    await p;
    expect(api.move).not.toHaveBeenCalled();
  });

  it("names the action on the button that agrees", async () => {
    const s = await many(BULK_LIMIT + 1);
    const move = s.actions.moveTo("Archive", ids(s));
    await flush();
    expect(s.ui.confirmation?.okLabel).toBe(t("bulk.ok.move"));
    s.ui.confirmation!.resolve(false);
    await move;

    const archive = s.actions.archive(ids(s));
    await flush();
    expect(s.ui.confirmation?.okLabel).toBe(t("bulk.ok.archive"));
    s.ui.confirmation!.resolve(false);
    await archive;
  });

  it("is refused without taking the undo of the action before it", async () => {
    const s = await many(BULK_LIMIT + 2);
    await s.actions.archive([1]);
    const moved = s.actions.lastUndo?.moved;
    // Eleven letters are left: the question is put, and the refusal leaves the undo in place.
    const p = s.actions.remove(ids(s));
    await flush();
    s.ui.confirmation!.resolve(false);
    await p;
    await s.actions.undo();
    expect(api.undo).toHaveBeenCalledWith(moved);
  });

  it("shows the progress line only while the server works, not while it asks", async () => {
    const s = await many(BULK_LIMIT + 1);
    const all = ids(s);
    const answer = deferred<Moved[]>();
    api.remove.mockReturnValue(answer.promise);
    const p = s.actions.remove(all);
    await flush();
    expect(s.ui.confirmation).not.toBeNull();
    expect(s.ui.busy).toBe(0);
    s.ui.confirmation!.resolve(true);
    await flush();
    expect(s.ui.busy).toBe(1);
    answer.resolve([{ account_id: "a", from: "INBOX", to: "Trash", message_ids: ["1"], unseen: [], snoozed: [], waits: [] }]);
    await p;
    expect(s.ui.busy).toBe(0);
    expect(api.remove.mock.calls[0][0]).toEqual(all);
  });
});

// A delete in the trash, or in a mailbox without one, is final: the dialog must not offer an
// undo the backend cannot give (#196).
describe("a delete that cannot be taken back (#196)", () => {
  beforeEach(() => {
    i18n.lang = "ru";
  });
  afterEach(() => {
    i18n.lang = "en";
  });

  /** `n` letters of the trash, in a mailbox that has the folder. */
  async function trashed(n: number) {
    api.messages.mockResolvedValue(Array.from({ length: n }, (_, i) => row(i + 1, { folder: "Trash" })));
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "Trash" });
    s.mailboxes.folders = [{ account_id: "a", name: "Trash", role: "trash" }] as never;
    return s;
  }

  it("says in the trash that the letters go for good", async () => {
    const s = await trashed(BULK_LIMIT + 1);
    const p = s.actions.remove(ids(s));
    await flush();
    expect(s.ui.confirmation?.text).toContain("безвозвратно");
    expect(s.ui.confirmation?.text).not.toContain("отменить клавишей z");
    s.ui.confirmation!.resolve(false);
    await p;
  });

  it("promises the undo where the mailbox has a trash to put them in", async () => {
    const s = await many(BULK_LIMIT + 1);
    s.mailboxes.folders = [{ account_id: "a", name: "Trash", role: "trash" }] as never;
    const p = s.actions.remove(ids(s));
    await flush();
    expect(s.ui.confirmation?.text).toBe(t("bulk.note"));
    s.ui.confirmation!.resolve(false);
    await p;
  });
});

// Intl.PluralRules("ru") calls 21, 31 and 101 «one»: the number must be in that form too.
describe("the words of the question", () => {
  beforeEach(() => {
    i18n.lang = "ru";
  });
  afterEach(() => {
    i18n.lang = "en";
  });

  it("names the number in every Russian form", () => {
    expect(tn("bulk.delete", 21)).toContain("21");
    expect(tn("bulk.move", 21, { folder: "Архив" })).toContain("21");
    expect(tn("bulk.archive", 21)).toContain("21");
    expect(tn("bulk.spam", 21)).toContain("21");
  });

  it("leaves the number out of the English one, where it is always one letter", () => {
    i18n.lang = "en";
    expect(tn("bulk.delete", 1)).toBe("Delete the message?");
    expect(tn("bulk.delete", 21)).toContain("21");
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

describe("equal toasts in a row stand as one", () => {
  const moves = (ids: string[]): Moved[] => ids.map((id) => ({ account_id: "a", from: "INBOX", to: "Archive", message_ids: [id], unseen: [], snoozed: [], waits: [] }));

  it("four archives give one toast that counts four", async () => {
    const s = await inbox();
    api.archive.mockImplementation(async (all: number[]) => moves(all.map(String)));
    for (const id of [1, 2, 3, 4]) await s.actions.archive([id]);
    const toasts = s.ui.toasts.filter((x) => x.action?.label === t("undo"));
    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe(tn("done.archived", 4));
  });

  it("are all taken back by the button, the last first", async () => {
    const s = await inbox();
    api.thread.mockImplementation(async (id: number) => [row(id)]);
    api.archive.mockImplementation(async (all: number[]) => moves(all.map(String)));
    const done = [1, 2, 3, 4];
    for (const id of done) await s.actions.archive([id]);
    s.ui.toasts.find((x) => x.action)!.action!.run();
    await flush();
    expect(api.undo.mock.calls.map((c) => c[0][0].message_ids[0])).toEqual(["4", "3", "2", "1"]);
    expect(s.actions.lastUndo).toBeNull();
  });

  it("do not join an archive and a deletion", async () => {
    const s = await inbox();
    api.thread.mockImplementation(async (id: number) => [row(id)]);
    api.archive.mockImplementation(async (all: number[]) => moves(all.map(String)));
    api.remove.mockImplementation(async (all: number[]) => moves(all.map(String)));
    await s.actions.archive([1]);
    await s.actions.remove([2]);
    expect(s.ui.toasts.filter((x) => x.action).map((x) => x.text)).toEqual([tn("done.archived", 1), tn("done.deleted", 1)]);
  });

  it("run the time of the toast anew", async () => {
    const s = await inbox();
    api.thread.mockImplementation(async (id: number) => [row(id)]);
    api.archive.mockImplementation(async (all: number[]) => moves(all.map(String)));
    vi.useFakeTimers();
    try {
      await s.actions.archive([1]);
      vi.advanceTimersByTime(6000);
      await s.actions.archive([2]);
      vi.advanceTimersByTime(6000);
      expect(s.ui.toasts).toHaveLength(1);
      vi.advanceTimersByTime(2001);
      expect(s.ui.toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// «e» and the «Done» button call `archive()` and do not wait: the next press comes while the
// server still answers the one before, so the join cannot count on the last step being recorded.
describe("equal toasts of actions that overlap in time", () => {
  const moves = (ids: string[]): Moved[] => ids.map((id) => ({ account_id: "a", from: "INBOX", to: "Archive", message_ids: [id], unseen: [], snoozed: [], waits: [] }));

  async function pressed(settle: (answers: ReturnType<typeof deferred<Moved[]>>[]) => void) {
    const s = await inbox();
    api.thread.mockImplementation(async (id: number) => [row(id)]);
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    const answers: ReturnType<typeof deferred<Moved[]>>[] = [];
    api.archive.mockImplementation((all: number[]) => {
      const a = deferred<Moved[]>();
      answers.push(a);
      return a.promise.then(() => moves(all.map(String)));
    });
    await s.reader.open(1);
    await flush();
    for (let i = 0; i < 4; i++) {
      void s.actions.archive();
      await flush();
    }
    settle(answers);
    await flush();
    return s;
  }

  it("stand as one toast when the server answers each press in turn", async () => {
    const s = await pressed((a) => a.forEach((x) => x.resolve([])));
    const toasts = s.ui.toasts.filter((x) => x.action?.label === t("undo"));
    expect(toasts.map((x) => x.text)).toEqual([tn("done.archived", 4)]);
  });

  it("stand as one toast when the answers come after both presses, the later first", async () => {
    const s = await pressed((a) => [...a].reverse().forEach((x) => x.resolve([])));
    const toasts = s.ui.toasts.filter((x) => x.action?.label === t("undo"));
    expect(toasts.map((x) => x.text)).toEqual([tn("done.archived", 4)]);
  });
});
