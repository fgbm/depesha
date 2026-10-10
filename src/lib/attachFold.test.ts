import { describe, expect, it } from "vitest";
import { CHIP_GAP_PX, MORE_RESERVE_PX, STRIP_ROWS, foldChips } from "./attachFold";

const chips = (n: number, w = 200) => Array.from({ length: n }, () => w);

describe("the fold of many attachments (two rows and «+N more»)", () => {
  it("keeps the strip to two rows", () => {
    expect(STRIP_ROWS).toBe(2);
  });

  it("folds nothing when everything fits two rows together with «Save all»", () => {
    expect(foldChips(chips(3), 700)).toBe(3);
    expect(foldChips(chips(0), 700)).toBe(0);
  });

  it("does not fold while the width is not known yet", () => {
    expect(foldChips(chips(29), 0)).toBe(29);
  });

  it("folds 29 files of a wide pane to what two rows hold, with room for «+N more»", () => {
    const k = foldChips(chips(29), 760);
    expect(k).toBeLessThan(29);
    // Three 200 px chips go on a row of 760 px: two rows give six, and «+N more» still fits after the sixth.
    expect(k).toBe(6);
    const row = 3 * 200 + 2 * CHIP_GAP_PX;
    expect(row + CHIP_GAP_PX + MORE_RESERVE_PX).toBeLessThanOrEqual(760);
  });

  it("shows fewer files in a narrower pane and recounts when it widens", () => {
    const narrow = foldChips(chips(29), 420);
    const wide = foldChips(chips(29), 1200);
    expect(narrow).toBeLessThan(wide);
    expect(narrow).toBe(3);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("leaves «+N more» room: a file that would push it to a third row is folded too", () => {
    // Two rows of two chips fit 4 × 200 exactly; «+N more» has no place after them.
    const avail = 2 * 200 + CHIP_GAP_PX;
    expect(foldChips(chips(5), avail)).toBe(3);
    expect(MORE_RESERVE_PX).toBeLessThan(avail - 200);
  });

  it("counts every chip by its own width", () => {
    const k = foldChips([300, 100, 100, 300, 300, 100, 100, 100], 560);
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThan(8);
  });

  it("clamps a chip wider than the pane to the pane", () => {
    expect(foldChips([900, 900, 900], 400)).toBe(1);
  });

  it("shows one file in sight however narrow the pane", () => {
    expect(foldChips(chips(5), 60)).toBe(1);
  });
});
