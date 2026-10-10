// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "depesha.snooze.count";

/** The state as a launch reads it: the module is loaded anew, after what the last run left in the storage. */
async function launch(stored?: string) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(KEY, stored);
  vi.resetModules();
  return import("./state.svelte");
}

describe("the snoozed count at launch (#158)", () => {
  beforeEach(() => localStorage.clear());

  it("starts from the count of the last run, so the sidebar row is there at once", async () => {
    const { snooze } = await launch("3");
    expect(snooze.count).toBe(3);
  });

  it("starts from nothing without a stored count or with a broken one", async () => {
    expect((await launch()).snooze.count).toBe(0);
    expect((await launch("many")).snooze.count).toBe(0);
    expect((await launch("-2")).snooze.count).toBe(0);
  });

  it("keeps the count it is given for the next launch", async () => {
    const { snooze, setCount } = await launch("3");
    setCount(0);
    expect(snooze.count).toBe(0);
    expect(localStorage.getItem(KEY)).toBe("0");
  });
});
