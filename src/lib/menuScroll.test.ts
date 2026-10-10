import { describe, expect, it } from "vitest";
import { scrollToRow } from "./menuScroll";

describe("a menu's scroll that brings a row into view without moving the page", () => {
  it("leaves the scroll as it is when the row is already in view", () => {
    expect(scrollToRow({ top: 40, height: 30, scrollTop: 0, viewHeight: 300 })).toBe(0);
    expect(scrollToRow({ top: 500, height: 30, scrollTop: 400, viewHeight: 300 })).toBe(400);
  });

  it("scrolls a row below the edge to the middle of the list", () => {
    expect(scrollToRow({ top: 900, height: 30, scrollTop: 0, viewHeight: 300 })).toBe(765);
  });

  it("scrolls a row above the edge to the middle of the list, never below zero", () => {
    expect(scrollToRow({ top: 100, height: 30, scrollTop: 600, viewHeight: 300 })).toBe(0);
    expect(scrollToRow({ top: 700, height: 30, scrollTop: 800, viewHeight: 300 })).toBe(565);
  });
});
