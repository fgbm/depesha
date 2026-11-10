import { afterEach, describe, expect, it } from "vitest";
import type { PluginContext, Replacement } from "@depesha/plugin-api";
import typography from "../../plugins/typography";
import { registry } from "./registry.svelte";

/** The context as the host gives it: what a plugin registers lands in this registry. */
function contextOf(id: string): PluginContext {
  return { id, ui: { composeReplacements: (table: Replacement[]) => registry.add("composeReplacements", id, table) } } as unknown as PluginContext;
}

afterEach(() => {
  registry.removeOwner("typography");
  registry.removeOwner("another");
});

describe("the replacement table of the typography plugin", () => {
  it("reaches the compose editor whole, both entries in the order the plugin gave them", () => {
    typography.activate(contextOf("typography"));
    expect(registry.composeReplacements()).toEqual([
      { from: "--", to: "\u2014" },
      { from: "...", to: "\u2026" },
    ]);
  });

  it("is the whole of what an enabled plugin adds", () => {
    typography.activate(contextOf("typography"));
    expect(registry.lists.composeReplacements).toHaveLength(1);
    expect(registry.lists.composeReplacements[0].owner).toBe("typography");
  });

  it("goes when the plugin is switched off", () => {
    typography.activate(contextOf("typography"));
    registry.removeOwner("typography");
    expect(registry.composeReplacements()).toEqual([]);
  });

  it("stands before the table of a plugin that registered later", () => {
    typography.activate(contextOf("typography"));
    registry.add("composeReplacements", "another", [{ from: "->", to: "\u2192" }]);
    expect(registry.composeReplacements().map((r) => r.from)).toEqual(["--", "...", "->"]);
  });
});

describe("a plugin with no replacement table", () => {
  it("adds nothing to the compose editor", () => {
    typography.activate(contextOf("typography"));
    expect(registry.composeReplacements()).toHaveLength(2);
  });
});
