// A quit that was called off (#71): the main window says again that it holds drafts, so the
// next quit asks it to save them once more.
import { describe, expect, it, vi } from "vitest";

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
