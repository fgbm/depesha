import { describe, expect, it, vi } from "vitest";
import { Abort, createStepRunner } from "./step.mjs";

function setup() {
  const results = [];
  const retried = [];
  const log = vi.fn();
  const screenshot = vi.fn(async () => {});
  const tidyUp = vi.fn(async () => {});
  const step = createStepRunner({ screenshot, tidyUp, log, results, retried });
  return { step, results, retried, log, screenshot, tidyUp };
}

describe("e2e step runner", () => {
  it("does not repeat a step without the retry mark", async () => {
    const { step, results, retried } = setup();
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await step("5.1", "отправка", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, error: "boom" });
    expect(results[0]).not.toHaveProperty("retried");
    expect(retried).toEqual([]);
  });

  it("repeats a marked step once and records it", async () => {
    const { step, results, retried } = setup();
    const fn = vi.fn().mockRejectedValueOnce(new Error("flaky")).mockResolvedValueOnce(undefined);
    await step("3.1", "папки", fn, { retry: true });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(results[0]).toMatchObject({ ok: true, retried: true, firstError: "flaky" });
    expect(retried).toEqual(["папки"]);
  });

  it("fails a marked step that fails twice, without a third try", async () => {
    const { step, results, retried } = setup();
    const fn = vi.fn(async () => {
      throw new Error("still");
    });
    await step("3.1", "папки", fn, { retry: true });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(results[0]).toMatchObject({ ok: false, error: "still", retried: true, firstError: "still" });
    expect(retried).toEqual([]);
  });

  it("does not mark a step that passes the first time", async () => {
    const { step, results } = setup();
    await step("3.1", "папки", async () => {}, { retry: true });
    expect(results[0].ok).toBe(true);
    expect(results[0]).not.toHaveProperty("retried");
  });

  it("aborts after a critical failure and after three failures in a row", async () => {
    const bad = async () => {
      throw new Error("x");
    };
    const a = setup();
    await expect(a.step("1.1", "мастер", bad, { critical: true })).rejects.toBeInstanceOf(Abort);
    const b = setup();
    await b.step("1", "a", bad);
    await b.step("1", "b", bad);
    await expect(b.step("1", "c", bad)).rejects.toBeInstanceOf(Abort);
  });
});
