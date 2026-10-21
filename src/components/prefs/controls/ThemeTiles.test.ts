import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The declarations of the first rule with this selector in a stylesheet. */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(selector);
  return css.slice(at, css.indexOf("}", at));
};

describe("a tile of a look (0.8.12, screen 8)", () => {
  it("has a frame of the window's line, so a dark look stands out on the dark page; the chosen one the accent's", () => {
    const css = readFileSync("src/components/prefs/controls/ThemeTiles.svelte", "utf8");
    expect(rule(css, ".tile")).toMatch(/border: 1px solid var\(--line\);/);
    expect(rule(css, '.tile[aria-checked="true"]')).toMatch(/border-color: var\(--accent-text\);/);
  });
});
