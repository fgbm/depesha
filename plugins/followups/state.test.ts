// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "depesha.followups.counts";

/** The state as a launch reads it: the module is loaded anew, after what the last run left in the storage. */
async function launch(stored?: string) {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(KEY, stored);
  vi.resetModules();
  return import("./state.svelte");
}

describe("the waits' counts at launch (#158)", () => {
  beforeEach(() => localStorage.clear());

  it("start from the counts of the last run, so the sidebar row is there at once", async () => {
    const { followups } = await launch(JSON.stringify({ count: 2, closed: 5 }));
    expect([followups.count, followups.closed]).toEqual([2, 5]);
  });

  it("start from nothing without stored counts or with broken ones", async () => {
    expect((await launch()).followups.count).toBe(0);
    expect((await launch("{")).followups.count).toBe(0);
    expect((await launch(JSON.stringify({ count: "x", closed: -1 }))).followups).toMatchObject({ count: 0, closed: 0 });
  });

  it("keep the counts they are given for the next launch", async () => {
    const { followups, setCounts } = await launch();
    setCounts(1, 4);
    expect([followups.count, followups.closed]).toEqual([1, 4]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ count: 1, closed: 4 });
  });
});
