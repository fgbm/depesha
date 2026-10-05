import { describe, expect, it } from "vitest";
import * as strings from "./strings";

describe("the plugin's strings", () => {
  const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  /** Every pair of English and Russian: the same placeholders in each form. */
  function pairs(node: unknown, path: string, out: [string, string[], string[]][]) {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if ("en" in o && "ru" in o) {
      const forms = (x: unknown) => (typeof x === "string" ? [x] : Object.values(x as Record<string, string>));
      out.push([path, forms(o.en), forms(o.ru)]);
      return;
    }
    for (const [k, v] of Object.entries(o)) pairs(v, `${path}.${k}`, out);
  }

  it("have the same placeholders in both languages", () => {
    const out: [string, string[], string[]][] = [];
    pairs(strings, "strings", out);
    expect(out.length).toBeGreaterThan(50);
    for (const [path, en, ru] of out) {
      const want = new Set([...en, ...ru].map(holes));
      expect(want.size, `${path}: ${[...want].join(" | ")}`).toBe(1);
    }
  });
});
