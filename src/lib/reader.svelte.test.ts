// Marking a letter read (#71): a letter counts as read only once it was shown a while;
// letters flitted through with the keys are left unread.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { AppStore } from "./store.svelte";
import { boxName, unverifiedKey, unverifiedTip } from "./reader.svelte";
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

describe("opening a conversation reads it whole (#71, 0.8.4, #180)", () => {
  it("marks the whole conversation read once the opened letter stayed on screen", async () => {
    api.messages.mockResolvedValue(rows(1, 5));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    // A conversation of three unread letters; the letter 3 is the one opened.
    api.thread.mockImplementation(async (id: number) => (id === 3 ? [row(1), row(2), row(3)] : []));
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    vi.useFakeTimers();
    void s.reader.open(3);
    await flush();
    expect(s.reader.conversation.map((m) => m.id).sort()).toEqual([1, 2, 3]);
    vi.advanceTimersByTime(1200);
    await flush();
    // Opening the thread reads all of it, as it did before the branch (#71): the opened letter
    // first, then the letters of the conversation that were still unread, oldest first.
    expect(markedSeen()).toEqual([3, 2, 1]);
  });
});

describe("the read mark of a conversation read letter by letter (0.8.4, #180)", () => {
  it("keeps the row in the view it was read from, as opening it does (#71)", async () => {
    api.messages.mockResolvedValue(rows(1, 3));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });
    const mark = vi.spyOn(s.list, "mark");

    // A letter unfolded in the thread is read at once (Conversation.svelte calls `saw`).
    s.reader.saw([1]);
    // Its row holds its place: a letter read does not vanish from «Непрочитанные» by itself.
    expect(mark).toHaveBeenCalledWith(1, expect.objectContaining({ id: 1 }));
  });

  it("a read flag on another letter does not cancel the mark the open letter waits for", async () => {
    api.messages.mockResolvedValue(rows(1, 3));
    api.open.mockImplementation(async (id: number) => opened(row(id)));
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    vi.useFakeTimers();
    void s.reader.open(1);
    await flush();
    vi.advanceTimersByTime(200);
    // The user marks another letter read while the open one waits for its own mark.
    await s.selection.flag("seen", true, [2]);
    vi.advanceTimersByTime(1200);
    await flush();
    // The open letter is marked all the same: only its own read state is the last word (#71).
    expect(markedSeen()).toEqual([2, 1]);
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
    await s.actions.archive([1]);
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

describe("the line about a sender who is not confirmed (0.8.13)", () => {
  it("names the mailbox so that the verb agrees with it whatever it is called", () => {
    // The name is the user's own: it goes in quotes, and the word in front of it is in the
    // locale. A mailbox named «Работа» is not a word the verb could agree with.
    expect(boxName("Работа", "anna@example.org")).toBe("«Работа»");
    expect(boxName("  Работа  ", "anna@example.org")).toBe("«Работа»");
    // Without a name of its own the mailbox is the domain of the address.
    expect(boxName("", "anna@example.org")).toBe("example.org");
    expect(boxName(undefined, "anna@example.org")).toBe("example.org");
    expect(boxName("", "anna")).toBe("anna");
  });

  it("names the reason and the mailbox, and keeps the detail in the tip", () => {
    // The line says who did not confirm the sender; the tip says what the server said.
    expect(unverifiedKey("server")).toBe("reader.serverNo");
    expect(unverifiedKey("unsigned")).toBe("reader.serverUnsigned");
    expect(unverifiedKey("signature")).toBe("reader.serverBadSignature");
    expect(unverifiedKey("unchecked")).toBe("reader.serverUnchecked");
    expect(unverifiedKey("replay")).toBe("reader.serverReplay");
    expect(unverifiedKey("address_only")).toBe("reader.addressNotChecked");
    expect(unverifiedKey("address_only_unchecked")).toBe("reader.addressNotCheckedNoKey");
    expect(unverifiedKey("no_check")).toBe("reader.cannotCheck");
    // The detail is under the line, not in it.
    expect(unverifiedTip("unsigned")).toBe("reader.tipUnsigned");
    expect(unverifiedTip("signature")).toBe("reader.tipBadSignature");
    expect(unverifiedTip("unchecked")).toBe("reader.tipUnchecked");
    expect(unverifiedTip("no_check")).toBe("reader.tipCannotCheck");
    expect(unverifiedTip("server")).toBeNull();
  });

  it("does not tell the user that a server that checks senders does not check them", () => {
    // 0.8.13, 5.1 Б: Gmail, Yandex, Mail.ru and Exchange Online check senders themselves, and the
    // old tip («the mailbox's server does not check senders») was untrue there.
    expect(unverifiedTip("unsigned", true)).toBeNull();
    expect(unverifiedTip("unsigned", false)).toBe("reader.tipUnsigned");
  });
});

describe("the mailbox trusts the sender by address (0.8.13, 6.1 Б)", () => {
  it("the pictures are shown and the line says the address is not checked", async () => {
    api.messages.mockResolvedValue(rows(1, 1));
    const byAddress = () => ({ ...opened(row(1)), trusted_sender: true, why_unverified: "address_only" as const });
    api.open.mockResolvedValue(byAddress());
    api.thread.mockResolvedValue([]);
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    await s.reader.open(1);
    await flush();
    // The sender is confirmed (the address was trusted), and the reason is carried along: the
    // line over the letter says the address is not checked.
    expect(s.reader.opened?.trusted_sender).toBe(true);
    expect(s.reader.opened?.why_unverified).toBe("address_only");
  });
});

describe("a trusted sender the mailbox's server said nothing about (#167)", () => {
  it("checks the signature in the background and shows the answer without opening again", async () => {
    api.messages.mockResolvedValue(rows(1, 1));
    const unconfirmed = () => ({ ...opened(row(1)), sender_unverified: true, why_unverified: "checking" as const });
    api.open.mockResolvedValueOnce(unconfirmed()).mockResolvedValueOnce({ ...opened(row(1)), trusted_sender: true });
    api.thread.mockResolvedValue([]);
    let confirm!: (v: boolean) => void;
    api.checkSender.mockReturnValue(new Promise<boolean>((r) => (confirm = r)));
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    await s.reader.open(1);
    // The letter is shown at once; the line says the check is under way.
    expect(s.reader.opened?.why_unverified).toBe("checking");
    expect(api.checkSender).toHaveBeenCalledWith(1);
    confirm(true);
    await flush();
    expect(s.reader.opened?.trusted_sender).toBe(true);
    expect(s.reader.opened?.why_unverified).toBeNull();
    // Only the view is read again: the read mark and the conversation are not repeated.
    expect(api.thread).toHaveBeenCalledTimes(1);
  });

  it("a check without an answer never stays «checking»", async () => {
    api.messages.mockResolvedValue(rows(1, 1));
    const unconfirmed = () => ({ ...opened(row(1)), sender_unverified: true, why_unverified: "checking" as const });
    api.open.mockResolvedValue(unconfirmed());
    api.thread.mockResolvedValue([]);
    api.checkSender.mockRejectedValue(new Error("offline"));
    const s = new AppStore();
    await s.selection.setView({ kind: "folder", account_id: "a", folder: "INBOX" });

    await s.reader.open(1);
    await flush();
    expect(s.reader.opened?.trusted_sender).toBe(false);
    expect(s.reader.opened?.why_unverified).toBe("unchecked");
  });
});
