// @vitest-environment jsdom
// A composition window answers the quit's "keep every draft" through the channel (#71, #139).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../lib/testing").then((m) => m.appModule));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../lib/testing")).api }));

import { flushSync, mount, tick, unmount } from "svelte";
import Compose from "./Compose.svelte";
import { app } from "../lib/store.svelte";
import { bus } from "../lib/bus";
import { emptyDraft } from "../lib/compose";
import { i18n } from "../lib/i18n.svelte";
import { api, settings } from "../lib/testing";

(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
// jsdom has no layout observers; the window watches its size and its editor.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let view: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  i18n.lang = "ru";
  for (const m of Object.values(api)) m.mockReset();
  api.draftSave.mockResolvedValue({ id: 7, message_id: "<m@x>" });
  app.settingsCtl.settings = settings();
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("the composition window on the channel", () => {
  it("keeps its draft when the quit asks every window, and answers no more once closed", async () => {
    const draft = emptyDraft({ name: "Me", email: "me@example.com" });
    draft.subject = "Не потерять";
    const id = app.compose.open({ account_id: "a", draft, draft_id: null, unsaved: true });
    const win = app.compose.windows.find((w) => w.id === id)!;
    const target = document.createElement("div");
    document.body.append(target);
    view = mount(Compose, { target, props: { c: win } });
    flushSync();
    await tick();
    expect(bus.count("compose.save-all")).toBe(1);

    await app.compose.saveAll(1000);
    expect(api.draftSave).toHaveBeenCalledTimes(1);
    expect(api.draftSave.mock.calls[0][1]).toMatchObject({ subject: "Не потерять" });

    unmount(view);
    view = null;
    expect(bus.count("compose.save-all")).toBe(0);
  });
});
