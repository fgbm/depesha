import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce";

describe("debounce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once after a burst", () => {
    const fn = vi.fn();
    const d = debounce(fn, 250, 1000);
    for (let i = 0; i < 5; i++) {
      d();
      vi.advanceTimersByTime(100);
    }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not wait forever under a steady stream", () => {
    const fn = vi.fn();
    const d = debounce(fn, 250, 1000);
    for (let i = 0; i < 30; i++) {
      d();
      vi.advanceTimersByTime(100);
    }
    // Three seconds of calls every 100 ms: at least once a second.
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("cancel drops what waits", () => {
    const fn = vi.fn();
    const d = debounce(fn, 250, 1000);
    d();
    d.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });
});
