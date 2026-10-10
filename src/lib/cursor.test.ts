import { describe, expect, it } from "vitest";
import { cursorId } from "./cursor";

describe("the row with the cursor (#108)", () => {
  it("is the one selected row at once, before the letter has come", () => {
    // j on the next row: selected={B}, nothing opened yet, the old letter still open.
    expect(cursorId(new Set([2]), null, 1)).toBe(2);
    expect(cursorId(new Set([2]), 2, 1)).toBe(2);
  });

  it("is the row a Shift click left alone, though no letter is opened for it", () => {
    expect(cursorId(new Set([5]), undefined, undefined)).toBe(5);
  });

  it("stays on the chosen row when the open failed", () => {
    expect(cursorId(new Set([3]), null, null)).toBe(3);
  });

  it("follows the letter being opened, then the open one, when several are chosen", () => {
    expect(cursorId(new Set([1, 2]), 2, 1)).toBe(2);
    expect(cursorId(new Set([1, 2]), null, 1)).toBe(1);
    expect(cursorId(new Set([1, 2]), undefined, undefined)).toBeNull();
    expect(cursorId(new Set(), null, null)).toBeNull();
  });
});
