import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registry } from "../plugin-host/registry.svelte";
import { composeAction, keyLabel } from "./composeKeys";
import { i18n } from "./i18n.svelte";
import type { KeyPress } from "./keymap";
import { shortcuts } from "./shortcuts.svelte";
import type { KeySettings } from "./types";

function press(key: string, code = "", mods: Partial<KeyPress> = {}): KeyPress {
  return { key, code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}

let saved: KeySettings = { custom: {}, dismissed: [] };

beforeEach(() => {
  saved = { custom: {}, dismissed: [] };
  shortcuts.use(() => saved);
  i18n.lang = "ru";
});

afterEach(() => {
  registry.removeOwner("snooze");
  registry.removeOwner("command-palette");
});

describe("keys as the app shows them", () => {
  it("shows the first key of a command, with its Russian letter", () => {
    expect(shortcuts.key("core.delete")).toBe("Delete");
    expect(shortcuts.hint("core.archive")).toBe("e/у");
    expect(shortcuts.titled("Ответить", "core.reply")).toBe("Ответить (r/к)");
    i18n.lang = "en";
    expect(shortcuts.titled("Reply", "core.reply")).toBe("Reply (r)");
  });

  it("follows the user's keys, and drops the hint of a command without one", () => {
    saved = { custom: { "core.reply-all": ["Shift+r"], "core.archive": [] }, dismissed: [] };
    expect(shortcuts.hint("core.reply-all")).toBe("Shift+R/К");
    expect(shortcuts.titled("Готово", "core.archive")).toBe("Готово");
  });

  it("finds the command of a press on any layout", () => {
    expect(shortcuts.find(press("у", "KeyE"), "main")).toBe("core.archive");
    expect(shortcuts.find(press("Delete", "Delete"), "main")).toBe("core.delete");
    expect(shortcuts.find(press("№", "Digit3", { shiftKey: true }), "main")).toBe("core.delete");
    expect(shortcuts.find(press("R", "KeyR", { shiftKey: true }), "main")).toBeUndefined();
    saved = { custom: { "core.reply-all": ["Shift+r"] }, dismissed: [] };
    expect(shortcuts.find(press("К", "KeyR", { shiftKey: true }), "main")).toBe("core.reply-all");
    // The main window's keys do not reach the composition window.
    expect(shortcuts.find(press("e", "KeyE"), "compose")).toBeUndefined();
  });

  it("opens the labels picker with l, on any layout (#42)", () => {
    expect(shortcuts.find(press("l", "KeyL"), "main")).toBe("core.labels");
    expect(shortcuts.find(press("д", "KeyL"), "main")).toBe("core.labels");
  });
});

describe("plugins' keys", () => {
  const snooze = () =>
    registry.add("keybindings", "snooze", { id: "snooze.open", title: () => "Отложить", key: "h", run: () => {} });

  it("are listed with the core's and found by their key", () => {
    snooze();
    expect(shortcuts.commands().find((c) => c.id === "snooze.open")).toMatchObject({ owner: "snooze", keys: ["h"] });
    expect(shortcuts.find(press("р", "KeyH"), "main")).toBe("snooze.open");
  });

  it("give way to a key taken first, and say so once", () => {
    saved = { custom: { "core.sync": ["h"] }, dismissed: [] };
    snooze();
    expect(shortcuts.keys("snooze.open")).toEqual([]);
    expect(shortcuts.find(press("h", "KeyH"), "main")).toBe("core.sync");
    expect(shortcuts.lost()).toEqual([{ id: "snooze.open", key: "h", holder: "core.sync" }]);
    saved = { ...saved, dismissed: ["snooze.open:h"] };
    expect(shortcuts.lost()).toEqual([]);
  });

  it("keep Ctrl+K for the palette, in the composition window too", () => {
    registry.add("keybindings", "command-palette", { id: "command-palette.open", title: () => "Палитра", key: "Mod+k", run: () => {} });
    expect(shortcuts.commands().find((c) => c.id === "command-palette.open")).toMatchObject({ scope: "all", locked: true });
    expect(shortcuts.find(press("л", "KeyK", { ctrlKey: true }), "compose")).toBe("command-palette.open");
  });
});

describe("keys of the composition window", () => {
  it("follow the user's keys", () => {
    saved = { custom: { "compose.link": ["Mod+Shift+l"] }, dismissed: [] };
    expect(composeAction(press("l", "KeyL", { ctrlKey: true }))).toBeNull();
    expect(composeAction(press("Д", "KeyL", { ctrlKey: true, shiftKey: true }))).toBe("link");
    expect(keyLabel("link")).toBe("Ctrl+Shift+L");
  });

  it("have no label for an action without a key", () => {
    saved = { custom: { "compose.save": [] }, dismissed: [] };
    expect(keyLabel("save")).toBe("");
  });
});
