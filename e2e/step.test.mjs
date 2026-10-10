import { describe, expect, it, vi } from "vitest";
import { Abort, ESCAPE_SCRIPT, createFailFirst, createStepRunner } from "./step.mjs";

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

describe("DEPESHA_E2E_FAIL_FIRST", () => {
  it("fails the first try of the named steps once and says which names were never reached", () => {
    const fail = createFailFirst("6.4, 7.21,,nope");
    expect(() => fail.inject("6.4")).toThrow("DEPESHA_E2E_FAIL_FIRST: 6.4");
    expect(() => fail.inject("6.4")).not.toThrow();
    expect(() => fail.inject("5.1")).not.toThrow();
    // 7.21 and nope were never reached: the run warns, a typo does not pass for a test of the retry.
    expect(fail.unused()).toEqual(["7.21", "nope"]);
    expect(createFailFirst(undefined).unused()).toEqual([]);
  });
});

describe("tidy up", () => {
  /** Runs the script against a stand-in for the page: who got the Escape. */
  function run(shielded) {
    const got = [];
    const target = { name: "target", dispatchEvent: (e) => (shielded ? true : got.push(["target", e.key])) };
    const window = { dispatchEvent: (e) => got.push(["window", e.key]) };
    const document = { querySelector: () => null, activeElement: target, body: target };
    class KeyboardEvent {
      constructor(type, init) {
        Object.assign(this, { type }, init);
      }
    }
    new Function("document", "window", "KeyboardEvent", ESCAPE_SCRIPT)(document, window, KeyboardEvent);
    return got;
  }

  it("sends the Escape to the window too, for a handler that stopped it on the way", () => {
    // The focused element's handler stops the event: only the window can still close the dialog.
    expect(run(true)).toEqual([["window", "Escape"]]);
    expect(run(false)).toEqual([
      ["target", "Escape"],
      ["window", "Escape"],
    ]);
  });
});
