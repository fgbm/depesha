import { describe, expect, it } from "vitest";
import { keyNames, shortcutKeys, type KeyPress } from "./keys";

function press(key: string, code: string, mods: Partial<KeyPress> = {}): KeyPress {
  return { key, code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}

describe("shortcut keys", () => {
  it("keeps Latin letters and named keys", () => {
    expect(shortcutKeys(press("j", "KeyJ"))).toEqual(["j"]);
    expect(shortcutKeys(press("J", "KeyJ", { shiftKey: true }))).toEqual(["j"]);
    expect(shortcutKeys(press("ArrowDown", "ArrowDown"))).toEqual(["ArrowDown"]);
    expect(shortcutKeys(press("Delete", "Delete"))).toEqual(["Delete"]);
  });

  it("finds the US key on the Russian layout", () => {
    expect(shortcutKeys(press("о", "KeyJ"))).toEqual(["о", "j"]);
    expect(shortcutKeys(press("у", "KeyE"))).toEqual(["у", "e"]);
    expect(shortcutKeys(press("№", "Digit3", { shiftKey: true }))).toEqual(["№", "#"]);
    // "/" types "." there; Shift+1 types "!" on both layouts.
    expect(shortcutKeys(press(".", "Slash"))).toEqual([".", "/"]);
    expect(shortcutKeys(press("!", "Digit1", { shiftKey: true }))).toEqual(["!"]);
  });

  it("keeps a key that types the shortcut's character elsewhere", () => {
    // The German layout has "#" on its own key.
    expect(shortcutKeys(press("#", "Backslash"))[0]).toBe("#");
  });

  it("names keys with modifiers as plugins do", () => {
    expect(keyNames(press("л", "KeyK", { ctrlKey: true }))).toEqual(["Mod+л", "Mod+k"]);
    expect(keyNames(press("k", "KeyK", { metaKey: true, altKey: true }))).toEqual(["Mod+Alt+k"]);
  });
});
