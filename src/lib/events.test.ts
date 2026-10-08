// A quit that was called off (#71): the main window says again that it holds drafts, so the
// next quit asks it to save them once more.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { listenMain } from "./events";
import { api, emit, flush } from "./testing";
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
