import { describe, expect, it } from "vitest";
import { sidebarShape } from "./webdriver.mjs";

describe("sidebarShape", () => {
  it("does not change with a counter: only the name and the top go in", () => {
    expect(sidebarShape([["Входящие", 256, 7]])).toBe(sidebarShape([["Входящие", 256, 9]]));
  });

  it("changes when a row comes in and pushes the tree down", () => {
    const before = [["Входящие", 256]];
    const after = [["Отложенные", 256], ["Входящие", 282]];
    expect(sidebarShape(after)).not.toBe(sidebarShape(before));
  });

  it("changes when a row moves without a new one", () => {
    expect(sidebarShape([["Входящие", 256]])).not.toBe(sidebarShape([["Входящие", 282]]));
  });

  it("ignores a sub-pixel jitter", () => {
    expect(sidebarShape([["Входящие", 256.2]])).toBe(sidebarShape([["Входящие", 255.8]]));
  });
});
