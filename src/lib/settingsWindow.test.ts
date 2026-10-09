import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLUMN_MAX, MENU_WIDTH, PREFS_MAX, WIN_GAP, WIN_MAX, isRowPage, widePage } from "./settingsWindow";

// The settings window (#68, #102): its own size (wider than the expanded letter since 0.7.1),
// the column a page keeps to and what a page says about itself. The numbers agree with the
// CSS variables in src/app.css, which this checks.

describe("the size of the window", () => {
  it("is 1280 wide since 0.7.1, the letter staying at 1040, the height minus the gap", () => {
    expect(PREFS_MAX).toBe(1280);
    expect(WIN_MAX).toBe(1040);
    expect(WIN_GAP).toBe(32);
    expect(MENU_WIDTH).toBe(220);
    expect(COLUMN_MAX).toBe(680);
  });

  it("agrees with the CSS variables the window is drawn with", () => {
    const css = readFileSync(fileURLToPath(new URL("../app.css", import.meta.url)), "utf-8");
    const num = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(css)?.[1]);
    expect(num("prefs-max")).toBe(PREFS_MAX);
    expect(num("win-max")).toBe(WIN_MAX);
    expect(num("win-gap")).toBe(WIN_GAP);
    expect(num("menu-width")).toBe(MENU_WIDTH);
    expect(num("column-max")).toBe(COLUMN_MAX);
  });
});

describe("what a page says about itself", () => {
  it("lets a page take the whole width only if it is a table", () => {
    expect(widePage("keys")).toBe(true);
    expect(widePage("people")).toBe(true);
    expect(widePage("reading")).toBe(false);
  });

  it("draws the line «changes apply at once» only on the pages made of rows", () => {
    expect(isRowPage("reading")).toBe(true);
    expect(isRowPage("start")).toBe(true);
    for (const own of ["keys", "people", "accounts", "plugins", "account:1", "account:new"]) expect(isRowPage(own)).toBe(false);
  });
});
