// A plugin that throws, or that keeps its context after it is switched off, must not reach
// past itself: the palette, the keys, the list and the other plugins go on.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../plugin-api";

const { settings, failMock, listenMock, contexts, starts, manifest } = vi.hoisted(() => ({
  settings: { disabled_plugins: [] as string[], enabled_plugins: [] as string[] },
  failMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
  contexts: new Map<string, PluginContext>(),
  starts: { broken: 0 },
  manifest: (id: string) => ({ id, name: { en: id, ru: id }, description: { en: "", ru: "" } }),
}));

vi.mock("../lib/api", () => ({ call: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../lib/commands", () => ({ coreCommands: () => [] }));
vi.mock("../lib/store.svelte", () => ({
  app: {
    settingsCtl: {
      settings,
      pending: false,
      patchSettings: (patch: { disabled_plugins?: string[] }) => {
        if (patch.disabled_plugins) settings.disabled_plugins = patch.disabled_plugins;
      },
    },
    ui: { fail: failMock },
  },
}));

vi.mock("../../plugins", () => ({
  BUILTIN: [
    { manifest: manifest("good"), activate: (ctx: PluginContext) => void contexts.set("good", ctx) },
    { manifest: manifest("bad"), activate: (ctx: PluginContext) => void contexts.set("bad", ctx) },
    {
      manifest: manifest("broken"),
      activate: () => {
        starts.broken++;
        throw new Error("does not start");
      },
    },
  ],
}));

import { allCommands, host } from "./host.svelte";
import { registry } from "./registry.svelte";
import { action, answer } from "./guard";

const boom = () => {
  throw new Error("boom");
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  settings.disabled_plugins = [];
  for (const id of ["good", "bad", "broken"]) registry.removeOwner(id);
  host.setEnabled("good", false);
  host.setEnabled("bad", false);
  host.setEnabled("broken", false);
  host.sync();
  host.setEnabled("good", true);
  host.setEnabled("bad", true);
  host.sync();
  failMock.mockClear();
  listenMock.mockClear();
  starts.broken = 0;
});

describe("the guard of a plugin's functions", () => {
  it("gives the fallback for a function that throws, and logs it with the plugin's name", () => {
    expect(answer("p", "count", boom, 0)()).toBe(0);
    expect(console.error).toHaveBeenCalledWith("plugin p: count failed:", expect.any(Error));
    expect(answer("p", "count", (n: number) => n + 1, 0)(1)).toBe(2);
  });

  it("shows a failed action to the user, thrown or rejected", async () => {
    action("p", "run", boom, failMock)();
    expect(failMock).toHaveBeenCalledTimes(1);
    action("p", "run", () => Promise.reject(new Error("later")), failMock)();
    await Promise.resolve();
    await Promise.resolve();
    expect(failMock).toHaveBeenCalledTimes(2);
  });
});

describe("a plugin that throws", () => {
  it("loses its own command; the palette and the keys keep the others", () => {
    contexts.get("good")!.ui.command({ id: "good.go", title: () => "Go", run: () => {} });
    contexts.get("bad")!.ui.command({ id: "bad.go", title: boom, when: boom, run: () => {} });
    contexts.get("bad")!.ui.keybinding({ id: "bad.key", title: () => "Key", key: "q", when: boom, run: () => {} });
    expect(allCommands().map((c) => c.id)).toEqual(["good.go"]);
  });

  it("tells the user when its command fails, instead of doing nothing", () => {
    contexts.get("bad")!.ui.command({ id: "bad.run", title: () => "Run", run: boom });
    expect(() => allCommands().find((c) => c.id === "bad.run")!.run()).not.toThrow();
    expect(failMock).toHaveBeenCalledOnce();
  });

  it("shows no badge or entry for a view that throws, and a filter that throws narrows nothing", () => {
    contexts.get("bad")!.ui.view({ id: "bad.view", title: boom, icon: {} as never, count: boom, empty: boom, shown: boom, query: () => ({}) as never });
    contexts.get("bad")!.ui.listFilter({ title: boom, options: boom, current: boom, select: boom, query: boom });
    const view = registry.view("bad.view")!;
    expect([view.count(), view.shown!(), view.title()]).toEqual([0, false, "bad.view"]);
    const filter = registry.items("listFilters")[0];
    const list = { key: "unified:inbox", inbox: true };
    expect([filter.query(list), filter.options(), filter.current(list)]).toEqual([{}, [], ""]);
  });
});

describe("the context of a plugin that is switched off", () => {
  it("adds nothing and subscribes to nothing", () => {
    const ctx = contexts.get("bad")!;
    host.setEnabled("bad", false);
    host.sync();
    ctx.ui.command({ id: "bad.late", title: () => "Late", run: () => {} });
    ctx.onBackend("sync-done", () => {});
    expect(registry.items("commands").map((c) => c.id)).not.toContain("bad.late");
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("of a plugin switched on again is the new one only", () => {
    const old = contexts.get("bad")!;
    host.setEnabled("bad", false);
    host.sync();
    host.setEnabled("bad", true);
    host.sync();
    old.ui.command({ id: "bad.old", title: () => "Old", run: () => {} });
    contexts.get("bad")!.ui.command({ id: "bad.new", title: () => "New", run: () => {} });
    expect(registry.items("commands").map((c) => c.id)).toEqual(["bad.new"]);
  });
});

describe("a plugin that fails to start", () => {
  it("is not started again by an unrelated change, only when the user switches it off and on", () => {
    host.setEnabled("broken", true);
    host.sync();
    expect(starts.broken).toBe(1);
    // Another plugin switched: the broken one is left alone.
    host.setEnabled("good", false);
    host.sync();
    expect(starts.broken).toBe(1);
    host.setEnabled("broken", false);
    host.sync();
    host.setEnabled("broken", true);
    host.sync();
    expect(starts.broken).toBe(2);
  });
});
