import { describe, expect, it } from "vitest";
import palette from "./index";

describe("the palette plugin's description in the settings", () => {
  it("prints no key: it is a form, and the key is on the Keys page", () => {
    const d = palette.manifest.description as { en: string; ru: string };
    expect(d.en).not.toMatch(/Ctrl|⌘/);
    expect(d.ru).not.toMatch(/Ctrl|⌘/);
  });
});
