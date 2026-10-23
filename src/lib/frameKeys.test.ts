import { afterEach, describe, expect, it } from "vitest";
import { frameTakes } from "./frameKeys";
import { layout } from "./layout.svelte";
import { shortcuts } from "./shortcuts.svelte";
import { app } from "./store.svelte";

const PRINT = { code: "KeyP", mod: true, alt: false, shift: false };
const SELECT_ALL = { code: "KeyA", mod: true, alt: false, shift: false };
const ROW_MENU = { key: "ContextMenu", mod: false, alt: false, shift: false };

afterEach(() => {
  app.windowOf = null;
  shortcuts.use(() => undefined);
  layout.width = 1280;
  app.selection.selected = new Set();
});

describe("the keys a letter's frame is told to stop", () => {
  it("are the main window's: print and the menu of a row, but never select all (#124)", () => {
    const keys = frameTakes();
    expect(keys).toContainEqual(PRINT);
    expect(keys).toContainEqual(ROW_MENU);
    // Ctrl+A in a letter takes the text of the letter, so the page keeps the key.
    expect(keys).not.toContainEqual(SELECT_ALL);
  });

  it("leave select all and the row menu to the letter's own window (#124)", () => {
    // There is no list in that window: Ctrl+A selects the text of the letter, and there is no row
    // to open a menu on (App.svelte, commands.ts MAIN_ONLY).
    app.windowOf = 7;
    const keys = frameTakes();
    expect(keys).toContainEqual(PRINT);
    expect(keys).not.toContainEqual(SELECT_ALL);
    expect(keys).not.toContainEqual(ROW_MENU);
  });

  it("take Enter only where the one column of a narrow window takes it", () => {
    const enter = { key: "Enter", mod: false, alt: false, shift: false };
    expect(frameTakes()).not.toContainEqual(enter);
    layout.width = 600;
    expect(frameTakes()).not.toContainEqual(enter);
    app.selection.selected = new Set([1]);
    expect(frameTakes()).toContainEqual(enter);
  });

  it("follow the keys the user gave the commands", () => {
    shortcuts.use(() => ({ custom: { "core.print": ["Mod+Alt+x"] }, dismissed: [] }));
    const keys = frameTakes();
    expect(keys).toContainEqual({ code: "KeyX", mod: true, alt: true, shift: false });
    expect(keys).not.toContainEqual(PRINT);
  });

  it("include what a viewer of the letter takes on top (VIEWER_TAKES)", () => {
    const keys = frameTakes(["ArrowLeft", "Mod+s"]);
    expect(keys).toContainEqual({ key: "ArrowLeft", mod: false, alt: false, shift: false });
    expect(keys).toContainEqual({ code: "KeyS", mod: true, alt: false, shift: false });
  });
});
