import { beforeEach, describe, expect, it, vi } from "vitest";

const { settings } = vi.hoisted(() => ({ settings: { disabled_plugins: [] as string[], enabled_plugins: [] as string[] } }));

vi.mock("../../plugins", () => ({
  BUILTIN: [
    { manifest: { id: "always-on", name: { en: "A", ru: "А" }, description: { en: "", ru: "" } }, activate: vi.fn() },
    { manifest: { id: "off-by-default", name: { en: "B", ru: "Б" }, description: { en: "", ru: "" }, defaultOff: true }, activate: vi.fn() },
  ],
}));

// The host reads and writes the settings through the store; here they are a plain object.
vi.mock("../lib/store.svelte", () => ({
  app: {
    settings,
    saveSettings: (next: { disabled_plugins: string[]; enabled_plugins: string[] }) => {
      settings.disabled_plugins = next.disabled_plugins;
      settings.enabled_plugins = next.enabled_plugins;
    },
  },
}));

vi.mock("./registry.svelte", () => ({ registry: { removeOwner: vi.fn(), add: vi.fn() } }));

import { host } from "./host.svelte";
import { registry } from "./registry.svelte";
import { BUILTIN } from "../../plugins";

const offByDefault = BUILTIN.find((p) => p.manifest.id === "off-by-default")!;

beforeEach(() => {
  settings.disabled_plugins = [];
  settings.enabled_plugins = [];
  vi.clearAllMocks();
});

describe("a plugin off until the user switches it on", () => {
  it("is off by default, with nothing in the settings", () => {
    expect(host.enabled("off-by-default")).toBe(false);
    expect(settings.enabled_plugins).toEqual([]);
    expect(settings.disabled_plugins).toEqual([]);
  });

  it("switches on, stays on, then switches off again", () => {
    host.setEnabled("off-by-default", true);
    expect(host.enabled("off-by-default")).toBe(true);
    // On a restart the host reads the same settings back.
    expect(settings.enabled_plugins).toEqual(["off-by-default"]);
    expect(settings.disabled_plugins).toEqual([]);

    host.setEnabled("off-by-default", false);
    expect(host.enabled("off-by-default")).toBe(false);
    expect(settings.enabled_plugins).toEqual([]);
  });
});

describe("a plugin on from the start", () => {
  it("is on until it is switched off", () => {
    expect(host.enabled("always-on")).toBe(true);
    expect(settings.disabled_plugins).toEqual([]);
  });

  it("switches off and back on, remembering the state", () => {
    host.setEnabled("always-on", false);
    expect(host.enabled("always-on")).toBe(false);
    expect(settings.disabled_plugins).toEqual(["always-on"]);
    expect(settings.enabled_plugins).toEqual([]);

    host.setEnabled("always-on", true);
    expect(host.enabled("always-on")).toBe(true);
    expect(settings.disabled_plugins).toEqual([]);
  });
});

describe("activation follows the settings", () => {
  it("starts a default-off plugin when it is switched on, and stops it when off", () => {
    host.setEnabled("off-by-default", true);
    host.sync();
    expect(offByDefault.activate).toHaveBeenCalledTimes(1);

    host.setEnabled("off-by-default", false);
    host.sync();
    expect(registry.removeOwner).toHaveBeenCalledWith("off-by-default");
  });
});

describe("keys of plugins", () => {
  it("are commands with an id and a title, shown on the «Keys» page", () => {
    const alwaysOn = BUILTIN.find((p) => p.manifest.id === "always-on")!;
    host.setEnabled("always-on", false);
    host.sync();
    host.setEnabled("always-on", true);
    host.sync();
    const ctx = vi.mocked(alwaysOn.activate).mock.calls.at(-1)![0];
    const run = () => {};
    ctx.ui.keybinding({ id: "always-on.go", title: () => "Go", key: "g", run });
    expect(registry.add).toHaveBeenCalledWith("keybindings", "always-on", { id: "always-on.go", title: expect.any(Function), key: "g", run });
  });

  it("without an id, as before, are named by the plugin and the key", () => {
    const alwaysOn = BUILTIN.find((p) => p.manifest.id === "always-on")!;
    host.setEnabled("always-on", false);
    host.sync();
    host.setEnabled("always-on", true);
    host.sync();
    const ctx = vi.mocked(alwaysOn.activate).mock.calls.at(-1)![0];
    const run = () => {};
    ctx.ui.keybinding("g", run);
    const item = vi.mocked(registry.add).mock.calls.at(-1)![2] as { id: string; title: () => string; key: string };
    expect(item.id).toBe("always-on.key.g");
    expect(item.key).toBe("g");
    expect(item.title()).toBe("A");
  });
});
