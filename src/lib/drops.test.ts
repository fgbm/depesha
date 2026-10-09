// A drop acts on the backend's `files-dropped` (#79), not on Tauri's own drop event.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));

import { listenDrops } from "./drops";
import { emit, flush } from "./testing";
import type { AppStore } from "./store.svelte";

describe("files dropped on the window", () => {
  it("are attached on the backend's event, with the zone under the pointer", async () => {
    const dropFiles = vi.fn(async () => {});
    const c = {};
    const app = { activeCompose: () => c, compose: { dropFiles } } as unknown as AppStore;
    const zoneAt = vi.fn((_: unknown) => "attach" as const);
    await listenDrops(app, zoneAt);

    emit("files-dropped", { paths: ["/a/b.pdf"], position: { x: 10, y: 20 } });
    await flush();
    expect(dropFiles).toHaveBeenCalledWith(c, ["/a/b.pdf"], "attach");
    expect(zoneAt.mock.calls[0][0]).toMatchObject({ x: 10, y: 20 });
  });

  it("go nowhere without an open composition", async () => {
    const dropFiles = vi.fn(async () => {});
    const app = { activeCompose: () => null, compose: { dropFiles } } as unknown as AppStore;
    await listenDrops(app, () => null);
    emit("files-dropped", { paths: ["/a/b.pdf"], position: { x: 0, y: 0 } });
    await flush();
    expect(dropFiles).not.toHaveBeenCalled();
  });
});
