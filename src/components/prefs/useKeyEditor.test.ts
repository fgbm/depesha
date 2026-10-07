import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", () => ({ applyTheme: () => {} }));
// The palette's own commands are not what this test is about.
vi.mock("../../plugin-host/host.svelte", () => ({ allCommands: () => [] }));

import { app } from "../../lib/store.svelte";
import { api, flush, resetFakes, settings } from "../../lib/testing";
import type { Settings } from "../../lib/types";
import { KeyEditor } from "./useKeyEditor.svelte";

beforeEach(() => {
  resetFakes();
  app.settings = settings();
});

/** The draft a settings window edits: a copy of the saved settings. */
const draftOf = (saved: Settings): Settings => structuredClone(saved);
const sent = (): Settings => api.saveSettings.mock.calls.at(-1)?.[0] as Settings;

describe("a key changed on the «Keys» page", () => {
  it("is saved at once, without the shared «Save» button", async () => {
    app.settings = { ...settings(), keybindings: { custom: { "core.reply": ["q"] }, dismissed: [] } };
    const draft = draftOf(app.settings);
    const k = new KeyEditor(() => draft);

    k.reset("core.reply");
    await flush();

    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(sent().keybindings.custom).toEqual({});
    // The page's own state follows the save, and the app's saved settings too.
    expect(draft.keybindings.custom).toEqual({});
    expect(app.settings.keybindings.custom).toEqual({});
  });

  it("does not carry unsaved changes of other pages along", async () => {
    app.settings = { ...settings(), keybindings: { custom: { "core.reply": ["q"] }, dismissed: [] } };
    const draft = draftOf(app.settings);
    // Another page was edited but not saved: its change stays in the draft, out of the save.
    draft.language = "ru";
    draft.notify = "none";
    const k = new KeyEditor(() => draft);

    k.reset("core.reply");
    await flush();

    expect(sent().language).toBe(app.settings.language);
    expect(sent().notify).toBe(app.settings.notify);
    expect(draft.language).toBe("ru");
  });

  it("applies «Reset all» at once and can be brought back at once", async () => {
    app.settings = { ...settings(), keybindings: { custom: { "core.reply-all": ["Shift+r"] }, dismissed: [] } };
    const draft = draftOf(app.settings);
    const k = new KeyEditor(() => draft);

    k.resetAll();
    await flush();
    expect(app.settings.keybindings.custom).toEqual({});

    k.undoReset();
    await flush();
    expect(app.settings.keybindings.custom).toEqual({ "core.reply-all": ["Shift+r"] });
  });
});
