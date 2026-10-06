import { describe, expect, it } from "vitest";
import type { PluginContext } from "@depesha/plugin-api";
import plugin from "./index";

/** A context that keeps the compose controls the plugin registers. */
function fakeContext() {
  const controls: { slot?: string }[] = [];
  const ctx = { ui: { composeControl: (c: { slot?: string }) => controls.push(c) } } as unknown as PluginContext;
  return { ctx, controls };
}

describe("the mailbox colour of the From field", () => {
  it("is off until the user switches it on", () => {
    expect(plugin.manifest.id).toBe("account-color");
    expect(plugin.manifest.defaultOff).toBe(true);
  });

  it("adds exactly one control to the From row", () => {
    const { ctx, controls } = fakeContext();
    plugin.activate(ctx);
    expect(controls).toHaveLength(1);
    expect(controls[0].slot).toBe("from");
  });
});
