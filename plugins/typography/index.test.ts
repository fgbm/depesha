import { describe, expect, it } from "vitest";
import type { PluginContext, Replacement } from "@depesha/plugin-api";
import plugin from "./index";
import { TABLE } from "./table";

/** A context that keeps the replacement tables the plugin registers. */
function fakeContext() {
  const tables: Replacement[][] = [];
  const ctx = { id: "typography", ui: { composeReplacements: (t: Replacement[]) => tables.push(t) } } as unknown as PluginContext;
  return { ctx, tables };
}

describe("the typography plugin", () => {
  it("is off until the user switches it on", () => {
    expect(plugin.manifest.id).toBe("typography");
    expect(plugin.manifest.defaultOff).toBe(true);
  });

  it("gives the compose editor exactly its own table, once", () => {
    const { ctx, tables } = fakeContext();
    plugin.activate(ctx);
    expect(tables).toEqual([TABLE]);
  });
});
