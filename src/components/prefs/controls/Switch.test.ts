import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The declarations of the first rule with this selector in a stylesheet. */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(selector);
  return css.slice(at, css.indexOf("}", at));
};

describe("a switch and a box that are on (А12)", () => {
  it("are of one colour, the accent's: the blue of a link marks a link alone", () => {
    const sw = rule(readFileSync("src/components/prefs/controls/Switch.svelte", "utf8"), '.sw[aria-checked="true"]');
    const box = rule(readFileSync("src/app.css", "utf8"), 'input[type="checkbox"]:checked');
    expect(sw).toMatch(/background: var\(--accent\);/);
    expect(box).toMatch(/background-color: var\(--accent\);/);
    expect(sw).not.toContain("--link");
  });
});
