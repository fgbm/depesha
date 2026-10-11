import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The cursor row of the list is only a background (#165), so in the dark themes --selected has to
// stand out from --hover (the row under the mouse) and keep the text on it readable (#082-dark).

const css = readFileSync(fileURLToPath(new URL("../app.css", import.meta.url)), "utf8");

/** Token values of one rule: the block after `selector {`, up to the first closing brace. */
function tokens(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]] = m[2];
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const DARK = [":root:not([data-theme])", ':root[data-theme="night"]', ':root[data-theme="graphite"]'];

describe.each(DARK)("dark theme %s", (selector) => {
  const t = tokens(selector);

  it("shows the cursor row clearly against the row under the mouse", () => {
    expect(ratio(t["--selected"], t["--hover"])).toBeGreaterThanOrEqual(1.5);
    expect(ratio(t["--selected"], t["--hover"])).toBeGreaterThan(ratio(t["--hover"], t["--paper"]));
  });

  it("keeps the text readable on the cursor row", () => {
    expect(ratio(t["--ink"], t["--selected"])).toBeGreaterThanOrEqual(7);
    expect(ratio(t["--muted"], t["--selected"])).toBeGreaterThanOrEqual(4.5);
  });
});
