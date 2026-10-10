import { describe, expect, it } from "vitest";
import { en } from "./locales/en";
import { ru } from "./locales/ru";

describe("the toast that sends the user to pasting", () => {
  it("names no key: forms and toasts do not print them", () => {
    for (const dict of [ru, en] as Record<string, unknown>[]) {
      expect(dict["compose.picture.useCtrlV"]).not.toMatch(/Ctrl|⌘|\{key\}/);
    }
  });
});
