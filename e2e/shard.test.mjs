import { describe, expect, it, vi } from "vitest";
import { SECTIONS, createSectionGate, selectSections, split } from "./shard.mjs";

describe("e2e parts", () => {
  it("runs everything without a spec", () => {
    expect(selectSections("")).toBeNull();
    expect(selectSections(undefined)).toBeNull();
  });

  it("splits the sections into parts in a row that cover them once", () => {
    for (const n of [1, 2, 3, 4]) {
      const parts = split(SECTIONS, n);
      expect(parts).toHaveLength(n);
      expect(parts.flat()).toEqual(SECTIONS.map((s) => s.name));
    }
  });

  it("makes the longest part as short as it can be", () => {
    const sections = [10, 10, 10, 30].map((weight, i) => ({ name: `s${i}`, weight }));
    expect(split(sections, 2)).toEqual([["s0", "s1", "s2"], ["s3"]]);
  });

  it("takes the k-th of n parts and named sections", () => {
    const all = [1, 2, 3].flatMap((k) => [...selectSections(`${k}/3`)]);
    expect(all).toEqual(SECTIONS.map((s) => s.name));
    expect([...selectSections("list, send")]).toEqual(["list", "send"]);
  });

  it("refuses a spec that names nothing real", () => {
    expect(() => selectSections("4/3")).toThrow(/part 4 of 3/);
    expect(() => selectSections("0/3")).toThrow();
    expect(() => selectSections("list,nope")).toThrow(/nope/);
  });

  it("skips the steps of other parts and always runs the setup", async () => {
    const gate = createSectionGate(new Set(["send"]), SECTIONS, vi.fn());
    const ran = [];
    const step = gate.gate(async (id) => void ran.push(id));
    await step("setup-step");
    gate.section("list");
    await step("list-step");
    gate.section("send");
    await step("send-step");
    gate.section("triage");
    await step("triage-step");
    expect(ran).toEqual(["setup-step", "send-step"]);
  });

  it("runs every step without a selection", async () => {
    const gate = createSectionGate(null, SECTIONS, vi.fn());
    const ran = [];
    const step = gate.gate(async (id) => void ran.push(id));
    gate.section("list");
    await step("a");
    gate.section("second");
    await step("b");
    expect(ran).toEqual(["a", "b"]);
  });

  it("refuses an unknown section", () => {
    expect(() => createSectionGate(null, SECTIONS, vi.fn()).section("nope")).toThrow();
  });
});
