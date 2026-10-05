import { describe, expect, it } from "vitest";
import { REACHED, currentSection } from "./toc";

describe("the section being read", () => {
  const tops = [0, 400, 700, 1100];

  it("is the first at the top of the page", () => {
    expect(currentSection(tops, 0, false)).toBe(0);
  });

  it("is the last one whose top has reached the view", () => {
    expect(currentSection(tops, 399, false)).toBe(1);
    expect(currentSection(tops, 400 - REACHED - 1, false)).toBe(0);
    expect(currentSection(tops, 650, false)).toBe(1);
    expect(currentSection(tops, 700, false)).toBe(2);
  });

  it("is the last at the bottom, even when its top cannot reach the view", () => {
    expect(currentSection(tops, 900, true)).toBe(3);
  });

  it("is none without sections", () => {
    expect(currentSection([], 0, false)).toBe(-1);
  });
});
