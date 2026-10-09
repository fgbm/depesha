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

  it("does not undo the move a second time after «z», nor twice from the toast", async () => {
    emit("archived-after-send", { subject: "x", moved });
    await flush();
    const action = toast.mock.calls[0][2];
    app.actions.lastUndo = null; // «z» has taken the move back
    action.run();
    await flush();
    expect(api.undo).not.toHaveBeenCalled();

    emit("archived-after-send", { subject: "y", moved });
    await flush();
    const again = toast.mock.calls[1][2];
    again.run();
    again.run();
    await flush();
    expect(api.undo).toHaveBeenCalledTimes(1);
  });

  it("the «parked» toast keeps the letter in the inbox once only", async () => {
    emit("parked", { account_id: "a", key: "k", subject: "x" });
    await flush();
    const action = toast.mock.calls[0][2];
    app.actions.lastUndo = null;
    action.run();
    await flush();
    expect(api.followupUnpark).not.toHaveBeenCalled();
  });
});
