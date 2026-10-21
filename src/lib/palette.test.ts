import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOOKS } from "./theme";

// The looks of 0.8.12 (design/mockups/0.8.12/01-theme.html): every look in both lights, each
// readable by WCAG 2.1 — text 4.5:1, icons 3:1 (findings А5, А6, А31, А32 of the audit).

const css = readFileSync(fileURLToPath(new URL("../app.css", import.meta.url)), "utf8");

const TOKENS = [
  "--paper", "--paper-2", "--ink", "--muted", "--line", "--hover", "--selected", "--accent", "--accent-ink", "--accent-text",
  "--link", "--bad", "--ok", "--warn", "--imp", "--side", "--side-2", "--side-ink", "--side-muted", "--side-warn", "--side-alert",
];

/** The rule whose selector list names `[data-theme="<name>"]`: its colours and its scheme. */
function block(name: string): { vars: Record<string, string>; scheme: string } {
  const at = css.indexOf(`[data-theme="${name}"]`);
  expect(at, name).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) vars[m[1]] = m[2];
  return { vars, scheme: /color-scheme:\s*(\w+)/.exec(body)?.[1] ?? "" };
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

const PAIRS = LOOKS.flatMap((look) => (["light", "dark"] as const).map((scheme) => `${look}-${scheme}`));

describe.each(PAIRS)("the look %s", (name) => {
  const { vars: t, scheme } = block(name);

  it("has every colour and the scheme of its light", () => {
    for (const v of TOKENS) expect(t[v], v).toMatch(/^#[0-9a-f]{6}$/i);
    expect(scheme).toBe(name.endsWith("-dark") ? "dark" : "light");
  });

  it("keeps the text, the grey on the chosen row and the accent as text readable", () => {
    expect(ratio(t["--ink"], t["--paper"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["--muted"], t["--paper"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["--muted"], t["--paper-2"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["--muted"], t["--selected"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["--muted"], t["--hover"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["--accent-text"], t["--paper"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["--accent-ink"], t["--accent"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["--side-ink"], t["--side"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t["--side-muted"], t["--side"])).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the words of state readable: a link, an error, success, a warning, «important»", () => {
    for (const v of ["--link", "--bad", "--ok", "--warn", "--imp"]) expect(ratio(t[v], t["--paper"]), v).toBeGreaterThanOrEqual(4.5);
    for (const v of ["--side-warn", "--side-alert"]) expect(ratio(t[v], t["--side"]), v).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the icons of a chosen row visible: the flag, the tick, an error", () => {
    for (const v of ["--imp", "--accent-text", "--bad"]) expect(ratio(t[v], t["--selected"]), v).toBeGreaterThanOrEqual(3);
  });
});

// The cursor row of the list is only a background (#165), so in the dark themes --selected has to
// stand out from --hover (the row under the mouse) and keep the text on it readable (#082-dark).
describe.each(PAIRS.filter((n) => n.endsWith("-dark")))("dark theme %s", (name) => {
  const { vars: t } = block(name);

  it("shows the cursor row clearly against the row under the mouse", () => {
    expect(ratio(t["--selected"], t["--hover"])).toBeGreaterThanOrEqual(1.5);
    expect(ratio(t["--selected"], t["--hover"])).toBeGreaterThan(ratio(t["--hover"], t["--paper"]));
  });

  it("keeps the text readable on the cursor row", () => {
    expect(ratio(t["--ink"], t["--selected"])).toBeGreaterThanOrEqual(7);
  });
});

describe("the default", () => {
  it("is «Ink» in the light until the saved theme is applied", () => {
    expect(css).toMatch(/:root,\s*:root\[data-theme="ink-light"\]/);
  });

  it("has no themes of before 0.8.12 left", () => {
    for (const old of ["night", "snow", "graphite", "paper"]) expect(css).not.toContain(`[data-theme="${old}"]`);
  });
});
