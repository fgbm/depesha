// A quit that was called off (#71): the main window says again that it holds drafts, so the
// next quit asks it to save them once more.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { listenMain } from "./events";
import { api, emit, flush, resetFakes, settings } from "./testing";
import type { AppStore } from "./store.svelte";

describe("quit, cancel, quit", () => {
  it("saves the drafts both times and reports them again after the cancel", async () => {
    const saveComposes = vi.fn(async () => {});
    const app = { composes: [{}], saveComposes, settings: {}, accounts: [] } as unknown as AppStore;
    await listenMain(app);

    emit("save-drafts");
    await flush();
    emit("quit-cancelled");
    await flush();
    // Saving told the backend this window is through; the cancel puts it back on the list.
    expect(api.composeUnsaved).toHaveBeenCalledWith(true);
    emit("save-drafts");
    await flush();
    expect(saveComposes).toHaveBeenCalledTimes(2);
  });
});

describe("a quit while a text is typed in a mailbox's page (#120, 3)", () => {
  it("writes the text with the drafts before it says the window is through", async () => {
    const order: string[] = [];
    const saveComposes = vi.fn(async () => void order.push("drafts"));
    const settingsSettle = vi.fn(async () => void order.push("settings"));
    const app = { composes: [], saveComposes, settingsSettle, settingsTyping: true, settings: {}, accounts: [] } as unknown as AppStore;
    api.composeSaved.mockReset();
    api.composeSaved.mockImplementation(async () => void order.push("through"));
    await listenMain(app);

    emit("save-drafts");
    await flush();
    expect(order.at(-1)).toBe("through");
    expect(order).toContain("settings");
  });

  it("is still reported as unsaved after a cancel while the text is not left", async () => {
    const app = { composes: [], saveComposes: vi.fn(async () => {}), settingsTyping: true, settings: {}, accounts: [] } as unknown as AppStore;
    api.composeUnsaved.mockReset();
    await listenMain(app);
    emit("quit-cancelled");
    await flush();
    expect(api.composeUnsaved).toHaveBeenCalledWith(true);
  });
});

describe("a quit called off while the drafts are being saved (#91)", () => {
  it("does not report the window as through after the cancel", async () => {
    let finish = () => {};
    const saveComposes = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const app = { composes: [{}], saveComposes, settings: {}, accounts: [] } as unknown as AppStore;
    api.composeSaved.mockReset();
    api.composeUnsaved.mockReset();
    await listenMain(app);

    emit("save-drafts");
    await flush();
    emit("quit-cancelled");
    await flush();
    finish();
    await flush();
    expect(api.composeUnsaved).toHaveBeenCalledWith(true);
    expect(api.composeSaved).not.toHaveBeenCalled();
  });
});

describe("settings read again after a save made here (#91)", () => {
  it("does not roll the memory back with an answer asked before the save", async () => {
    resetFakes();
    const { SettingsController } = await import("./settings.svelte");
    const store = new SettingsController({ fail: () => {}, reload: () => {}, toast: () => {} } as never);
    const old = settings();
    let answer: (s: typeof old) => void = () => {};
    api.settings.mockReturnValueOnce(new Promise((r) => (answer = r)));
    api.settingsPatch.mockResolvedValue(undefined);
    api.language.mockResolvedValue("en");
    const reading = store.loadSettings();
    await store.patchSettings({ threads: !old.threads });
    answer(old);
    await reading;
    expect(store.settings.threads).toBe(!old.threads);
  });
});

describe("toasts after an answer that archives its letter (#106)", () => {
  const moved = { account_id: "a", from: "INBOX", to: "Archive", message_ids: ["m"] };
  let app: { actions: { lastUndo: unknown } };
  let toast: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    resetFakes();
    api.undo.mockClear();
    toast = vi.fn();
    app = { composes: [], settings: {}, accounts: [], actions: { lastUndo: null }, toast, reload: vi.fn(), fail: vi.fn() } as never;
    await listenMain(app as unknown as AppStore);
  });

  it("says «sent» at once, and the move adds a toast of its own with «Undo»", async () => {
    emit("sent", { id: 1, subject: "Привет", parking: false });
    await flush();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain("Привет");
    emit("archived-after-send", { subject: "Привет", moved });
    await flush();
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[1][0]).toContain("archive");
    expect(toast.mock.calls[1][2].label).toBeTruthy();
  });

  it("stays silent on a parking «sent»: the move says it", async () => {
    emit("sent", { id: 1, subject: "x", parking: true });
    await flush();
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not undo the move a second time after «z»", async () => {
    emit("archived-after-send", { subject: "x", moved });
    await flush();
    const action = toast.mock.calls[0][2];
    const mine = app.actions.lastUndo as { undone?: boolean };
    mine.undone = true; // «z» has taken the move back
    app.actions.lastUndo = null;
    action.run();
    await flush();
    expect(api.undo).not.toHaveBeenCalled();
  });

  it("undoes once from the toast, however many times it is pressed", async () => {
    emit("archived-after-send", { subject: "y", moved });
    await flush();
    const action = toast.mock.calls[0][2];
    action.run();
    action.run();
    await flush();
    expect(api.undo).toHaveBeenCalledTimes(1);
    expect(api.undo).toHaveBeenCalledWith([moved]);
    expect(app.actions.lastUndo).toBeNull();
  });

  it("undoes its own move even when another action has come since, and leaves that one alone", async () => {
    emit("archived-after-send", { subject: "y", moved });
    await flush();
    const other = { moved: [], text: "другое" };
    app.actions.lastUndo = other;
    toast.mock.calls[0][2].run();
    await flush();
    expect(api.undo).toHaveBeenCalledTimes(1);
    expect(app.actions.lastUndo).toBe(other);
  });
});

describe("toasts after an answer that parks its letter (#106)", () => {
  let app: { actions: { lastUndo: unknown } };
  let toast: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    resetFakes();
    api.undo.mockClear();
    toast = vi.fn();
    app = { composes: [], settings: {}, accounts: [], actions: { lastUndo: null }, toast, reload: vi.fn(), fail: vi.fn() } as never;
    await listenMain(app as unknown as AppStore);
  });

  it("the «parked» toast keeps the letter in the inbox once only", async () => {
    emit("parked", { account_id: "a", key: "k", subject: "x" });
    await flush();
    const action = toast.mock.calls[0][2];
    action.run();
    action.run();
    await flush();
    expect(api.followupUnpark).toHaveBeenCalledTimes(1);
  });

  it("the «parked» toast does not repeat «z», and works after another action", async () => {
    emit("parked", { account_id: "a", key: "k", subject: "x" });
    emit("parked", { account_id: "a", key: "k2", subject: "y" });
    await flush();
    const first = toast.mock.calls[0][2];
    first.run(); // another action (the second park) came since
    await flush();
    expect(api.followupUnpark).toHaveBeenCalledWith("a", "k");
    const second = app.actions.lastUndo as { undone?: boolean };
    second.undone = true; // «z»
    toast.mock.calls[1][2].run();
    await flush();
    expect(api.followupUnpark).toHaveBeenCalledTimes(1);
  });
});

describe("snoozed letters that did not all come back (#101)", () => {
  it("warns that some stayed in Snoozed", async () => {
    const toast = vi.fn();
    const app = { composes: [], settings: {}, accounts: [], toast } as unknown as AppStore;
    await listenMain(app);

    emit("unsnooze-partial");
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Snoozed"), true);
  });
});

describe("a quit while a text is being written (#120, ревью 1 и 2)", () => {
  const typing = (settle: () => Promise<void>) =>
    ({ composes: [], saveComposes: vi.fn(async () => {}), settingsSettle: settle, settingsTyping: true, settings: {}, accounts: [] }) as unknown as AppStore;

  it("does not say the window is free while the write is under way", async () => {
    let done = () => {};
    const app = typing(() => new Promise<void>((r) => (done = r)));
    api.composeSaved.mockReset();
    api.composeUnsaved.mockReset();
    await listenMain(app);
    emit("save-drafts");
    await flush();
    expect(api.composeUnsaved).not.toHaveBeenCalledWith(false);
    expect(api.composeSaved).not.toHaveBeenCalled();
    done();
    await flush();
    expect(api.composeSaved).toHaveBeenCalledTimes(1);
  });

  it("still lets the quit go when the write is refused", async () => {
    const app = typing(async () => {
      throw new Error("refused");
    });
    api.composeSaved.mockReset();
    await listenMain(app);
    emit("save-drafts");
    await flush();
    expect(api.composeSaved).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a write longer than four seconds", async () => {
    vi.useFakeTimers();
    try {
      const app = typing(() => new Promise<void>(() => {}));
      api.composeSaved.mockReset();
      await listenMain(app);
      emit("save-drafts");
      await vi.advanceTimersByTimeAsync(3900);
      expect(api.composeSaved).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(api.composeSaved).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
