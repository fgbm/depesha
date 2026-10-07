import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COLUMN_MAX,
  MENU_WIDTH,
  PAGE_TRAITS,
  WIN_GAP,
  WIN_MAX,
  ownFooter,
  pageChanged,
  resolveLeave,
  traits,
  widePage,
} from "./settingsWindow";

// The settings window of 0.7 (#68): the size it shares with the expanded letter, the column a
// page keeps to, what a page says about itself and how leaving a page with unsaved changes is
// settled. The numbers agree with the CSS variables in src/app.css, which this checks.

describe("the size of the window", () => {
  it("is as big as the expanded letter: up to 1040 wide, the height minus the gap", () => {
    expect(WIN_MAX).toBe(1040);
    expect(WIN_GAP).toBe(32);
    expect(MENU_WIDTH).toBe(220);
    expect(COLUMN_MAX).toBe(680);
  });

  it("agrees with the CSS variables the window is drawn with", () => {
    const css = readFileSync(fileURLToPath(new URL("../app.css", import.meta.url)), "utf-8");
    const num = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(css)?.[1]);
    expect(num("win-max")).toBe(WIN_MAX);
    expect(num("win-gap")).toBe(WIN_GAP);
    expect(num("menu-width")).toBe(MENU_WIDTH);
    expect(num("column-max")).toBe(COLUMN_MAX);
  });
});

describe("what a page says about itself", () => {
  it("marks a page that saves at once so the shared line is hidden", () => {
    // «Keys» (#46) saves as it goes and draws a table.
    expect(traits("keys")).toEqual({ selfSaving: true, wide: true });
    expect(PAGE_TRAITS.keys.selfSaving).toBe(true);
    expect(ownFooter("keys")).toBe(true);
    // A page without a trait is ordinary: the shared line shows.
    expect(ownFooter("mail")).toBe(false);
    expect(traits("mail")).toEqual({});
  });

  it("hides the shared line on a mailbox's page, which has its own buttons", () => {
    expect(ownFooter("account:1")).toBe(true);
    expect(ownFooter("account:new")).toBe(true);
  });

  it("lets a page take the whole width only if it says so", () => {
    expect(widePage("keys")).toBe(true);
    expect(widePage("mail")).toBe(false);
  });
});

describe("unsaved changes on a page", () => {
  const saved = { theme: "paper", language: "auto", threads: true };
  const draft = { theme: "night", language: "auto", threads: true };

  it("notices a change in one of the page's own fields", () => {
    expect(pageChanged("general", draft, saved)).toBe(true);
    expect(pageChanged("general", { ...draft, theme: "paper" }, saved)).toBe(false);
  });

  it("ignores a change belonging to another page", () => {
    const other = { theme: "paper", language: "auto", threads: false };
    // Threads are the Mail page's; the General page does not look at them.
    expect(pageChanged("general", other, saved)).toBe(false);
    expect(pageChanged("mail", other, saved)).toBe(true);
  });

  it("treats a page that saves itself as never changed here", () => {
    expect(pageChanged("keys", draft, saved)).toBe(false);
    expect(pageChanged("account:1", draft, saved)).toBe(false);
    expect(pageChanged("plugin:0", draft, saved)).toBe(false);
  });
});

describe("leaving a page with unsaved changes", () => {
  it("reads the three answers: save, discard, stay", () => {
    expect(resolveLeave(true)).toBe("save");
    expect(resolveLeave(false)).toBe("discard");
    expect(resolveLeave(null)).toBe("stay");
  });
});
