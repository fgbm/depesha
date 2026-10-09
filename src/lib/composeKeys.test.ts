import { describe, expect, it } from "vitest";
import { composeAction, keyLabel } from "./composeKeys";

const press = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
});

describe("keys of the composition window", () => {
  it("knows its actions", () => {
    expect(composeAction(press("Enter", "Enter", { ctrl: true }))).toBe("send");
    expect(composeAction(press("Escape", "Escape"))).toBe("fold");
    expect(composeAction(press("l", "KeyL", { ctrl: true }))).toBe("link");
    expect(composeAction(press("l", "KeyL", { meta: true }))).toBe("link");
    expect(composeAction(press("P", "KeyP", { ctrl: true, shift: true }))).toBe("preview");
    expect(composeAction(press("b", "KeyB", { ctrl: true }))).toBe("bold");
    expect(composeAction(press("s", "KeyS", { ctrl: true }))).toBe("save");
    // The Markdown-only commands of #45 (decisions, frame 16 В).
    expect(composeAction(press("1", "Digit1", { ctrl: true }))).toBe("heading1");
    expect(composeAction(press("2", "Digit2", { ctrl: true }))).toBe("heading2");
    expect(composeAction(press("3", "Digit3", { ctrl: true }))).toBe("heading3");
    expect(composeAction(press("e", "KeyE", { ctrl: true }))).toBe("code");
  });

  it("switches «High importance» on Alt+P, on the Russian layout too, and not on P alone (#72)", () => {
    expect(composeAction(press("p", "KeyP", { alt: true }))).toBe("importance");
    expect(composeAction(press("з", "KeyP", { alt: true }))).toBe("importance");
    expect(composeAction(press("p", "KeyP"))).toBeNull();
    expect(keyLabel("importance")).toBe("Alt+P");
  });

  it("works on the Russian layout by the physical key", () => {
    expect(composeAction(press("д", "KeyL", { ctrl: true }))).toBe("link");
    expect(composeAction(press("З", "KeyP", { ctrl: true, shift: true }))).toBe("preview");
    expect(composeAction(press("ы", "KeyS", { ctrl: true }))).toBe("save");
  });

  it("leaves Ctrl+K to the command palette and other keys alone", () => {
    expect(composeAction(press("k", "KeyK", { ctrl: true }))).toBeNull();
    expect(composeAction(press("л", "KeyK", { ctrl: true }))).toBeNull();
    expect(composeAction(press("p", "KeyP", { ctrl: true }))).toBeNull();
    expect(composeAction(press("l", "KeyL"))).toBeNull();
    expect(composeAction(press("l", "KeyL", { ctrl: true, alt: true }))).toBeNull();
  });

  it("names the keys for tooltips", () => {
    expect(keyLabel("link")).toBe("Ctrl+L");
    expect(keyLabel("preview")).toBe("Ctrl+Shift+P");
    expect(keyLabel("send")).toBe("Ctrl+Enter");
    expect(keyLabel("save")).toBe("Ctrl+S");
    expect(keyLabel("heading1")).toBe("Ctrl+1");
    expect(keyLabel("code")).toBe("Ctrl+E");
  });
});
