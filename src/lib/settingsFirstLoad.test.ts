import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: { settings: vi.fn() } }));
vi.mock("./api", () => ({ api }));
vi.mock("./theme", () => ({ applyTheme: vi.fn() }));

import { SettingsController } from "./settings.svelte";

function controller() {
  const fail = vi.fn();
  const ctl = new SettingsController({ ui: { fail, toast: vi.fn() }, selection: { reload: vi.fn() } } as never);
  return { ctl, fail };
}

describe("the first read of the settings (#158)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("holds the plugins back until the settings are in, and lets them go after", async () => {
    api.settings.mockResolvedValue({ theme: "night", disabled_plugins: ["snooze"] });
    const { ctl } = controller();
    ctl.pending = true;
    const read = ctl.loadFirst();
    expect(ctl.pending).toBe(true);
    await read;
    expect(ctl.pending).toBe(false);
    expect(ctl.settings.disabled_plugins).toEqual(["snooze"]);
  });

  it("lets them go when the read fails: the defaults are all there is", async () => {
    api.settings.mockRejectedValue(new Error("no settings"));
    const { ctl, fail } = controller();
    ctl.pending = true;
    await ctl.loadFirst();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(ctl.pending).toBe(false);
  });
});
