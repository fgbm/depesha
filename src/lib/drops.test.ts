// A drop acts on the backend's `files-dropped` (#79), not on Tauri's own drop event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/webview", () => import("./testing").then((m) => m.webviewModule));

import { readFileSync } from "node:fs";
import { api } from "./api";
import { listenDrops, watchDrops, zoneAt } from "./drops";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { emit, eventModule, flush, webviewListen } from "./testing";
import type { AppStore } from "./store.svelte";

beforeEach(() => vi.stubGlobal("window", { devicePixelRatio: 1, innerWidth: 800, innerHeight: 600 }));
afterEach(() => vi.unstubAllGlobals());

describe("files dropped on the window", () => {
  it("are attached on the backend's event, with the zone under the pointer", async () => {
    const dropFiles = vi.fn(async () => {});
    const c = { draft: { attachments: [] } };
    const app = { compose: { active: () => c, dropFiles } } as unknown as AppStore;
    const zoneAt = vi.fn((_: unknown) => "attach" as const);
    await listenDrops(app, zoneAt);

    emit("files-dropped", { paths: ["/a/b.pdf"], position: { x: 10, y: 20 } });
    await flush();
    expect(dropFiles).toHaveBeenCalledWith(c, ["/a/b.pdf"], "attach");
    expect(zoneAt.mock.calls[0][0]).toMatchObject({ x: 10, y: 20 });
  });

  it("pictures into the text are counted apart and the zone is logged (#79)", async () => {
    const dropOutcome = vi.spyOn(api, "dropOutcome").mockResolvedValue(undefined);
    const dropFiles = vi.fn(async () => 2);
    const c = { draft: { attachments: [{}] } };
    const app = { compose: { active: () => c, dropFiles, dragging: { zones: true, zone: "inline" } } } as unknown as AppStore;
    await listenDrops(app, () => "inline");
    emit("files-dropped", { paths: ["/a/1.png", "/a/2.png"], position: { x: 30, y: 60 } });
    await flush();
    expect(dropOutcome).toHaveBeenCalledWith({ outcome: "attached", attached: 0, inline: 2, zone: "inline", x: 30, y: 60, width: 800, height: 600 });
    dropOutcome.mockRestore();
  });

  it("go nowhere without an open composition, and say so (#79)", async () => {
    const dropFiles = vi.fn(async () => {});
    const toast = vi.fn();
    const app = { compose: { active: () => null, dropFiles }, ui: { toast } } as unknown as AppStore;
    await listenDrops(app, () => null);
    emit("files-dropped", { paths: ["/a/b.pdf"], position: { x: 0, y: 0 } });
    await flush();
    expect(dropFiles).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatch(/откройте ответ|open a reply/);
  });

  it("a drop beside the zones still attaches the files and is logged as a miss", async () => {
    const dropFiles = vi.fn(async () => {});
    const toast = vi.fn();
    const app = { compose: { active: () => ({ draft: { attachments: [] } }), dropFiles, dragging: { zones: true, zone: null } }, ui: { toast } } as unknown as AppStore;
    await listenDrops(app, () => null);
    emit("files-dropped", { paths: ["/a/b.pdf"], position: { x: 0, y: 0 } });
    await flush();
    expect(dropFiles).toHaveBeenCalledWith(expect.anything(), ["/a/b.pdf"], null);
    expect(toast).not.toHaveBeenCalled();
  });

  it("listen on the current webview, not on every window", async () => {
    const app = { compose: { active: () => null } } as unknown as AppStore;
    await listenDrops(app, () => null);
    expect(webviewListen).toHaveBeenCalledWith("files-dropped", expect.any(Function));
    expect(eventModule.listen).not.toHaveBeenCalled();
  });
});

describe("every window that can hold a draft hears drops (#107)", () => {
  it("watchDrops attaches the dropped files to the window's own draft", async () => {
    const dropFiles = vi.fn(async () => {});
    const c = { draft: { attachments: [] } };
    const app = { compose: { active: () => c, dropFiles } } as unknown as AppStore;
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("document", { elementFromPoint: () => null });
    const stop = watchDrops(app);
    emit("files-dropped", { paths: ["/a/b.pdf"], position: { x: 1, y: 2 } });
    await flush();
    expect(dropFiles).toHaveBeenCalledWith(c, ["/a/b.pdf"], null);
    stop();
    await flush();
    // After stop() the drop reaches nobody (#115).
    expect(() => emit("files-dropped", { paths: ["/c/d.pdf"], position: { x: 1, y: 2 } })).toThrow(/nobody listens/);
    expect(dropFiles).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("the main window and the letter window both use it", () => {
    for (const f of ["App.svelte", "MessageWindow.svelte"]) {
      expect(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), f).toMatch(/watchDrops\(app\)/);
    }
  });
});

describe("the zone under a scaled pointer (#79)", () => {
  it("takes physical pixels at a scale of 1.5 to the logical point of the zone", () => {
    const zone = { dataset: { dropZone: "attach" } };
    const elementFromPoint = vi.fn((x: number, y: number) => (x === 200 && y === 100 ? { closest: () => zone } : null));
    vi.stubGlobal("document", { elementFromPoint });
    expect(zoneAt(new PhysicalPosition(300, 150), 1.5)).toBe("attach");
    expect(elementFromPoint).toHaveBeenCalledWith(200, 100);
    expect(zoneAt(new PhysicalPosition(200, 100), 1.5)).toBeNull();
    vi.unstubAllGlobals();
  });
});
