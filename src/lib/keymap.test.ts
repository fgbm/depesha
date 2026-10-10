import { describe, expect, it } from "vitest";
import type { KeyPress } from "./keymap";
import {
  canSwap,
  caps,
  changed,
  findCommand,
  heldMods,
  keyText,
  modName,
  matches,
  pressName,
  pressNames,
  problem,
  removeKey,
  replace,
  resetOne,
  resolve,
  setKeys,
  swap,
  take,
  type KeyCommand,
} from "./keymap";

function press(key: string, code = "", mods: Partial<KeyPress> = {}): KeyPress {
  return { key, code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}

const cmd = (id: string, keys: string[], scope: KeyCommand["scope"] = "main", owner = "core", locked = false): KeyCommand => ({
  id,
  keys,
  scope,
  group: scope === "compose" ? "compose" : "list",
  owner,
  locked,
});

const COMMANDS: KeyCommand[] = [
  cmd("palette", ["Mod+k"], "all", "command-palette", true),
  cmd("core.reply", ["r"]),
  cmd("core.reply-all", ["a"]),
  cmd("core.forward", ["f"]),
  cmd("core.archive", ["e"]),
  cmd("core.delete", ["Delete", "#"]),
  cmd("core.next", ["j", "ArrowDown"]),
  cmd("core.sync", []),
  cmd("compose.link", ["Mod+l"], "compose"),
  cmd("compose.fold", ["Escape"], "compose"),
  cmd("snooze.open", ["h"], "main", "snooze"),
];

describe("a press as a key name", () => {
  it("names letters by their Latin letter, whatever the layout", () => {
    expect(pressName(press("e", "KeyE"))).toBe("e");
    // The Russian "у" sits where the Latin "e" does: it is saved as e.
    expect(pressName(press("у", "KeyE"))).toBe("e");
    expect(pressName(press("о", "KeyJ"))).toBe("j");
    // A layout that types a Latin letter keeps it: the German "z" is z.
    expect(pressName(press("z", "KeyY"))).toBe("z");
  });

  it("puts the modifiers in one order and Shift only where it is not in the character", () => {
    expect(pressName(press("R", "KeyR", { shiftKey: true }))).toBe("Shift+r");
    expect(pressName(press("К", "KeyR", { shiftKey: true }))).toBe("Shift+r");
    expect(pressName(press("Д", "KeyL", { ctrlKey: true, shiftKey: true }))).toBe("Mod+Shift+l");
    expect(pressName(press("l", "KeyL", { metaKey: true, altKey: true }))).toBe("Mod+Alt+l");
    // "#" is Shift+3: the character holds the Shift; on the Russian layout it types "№".
    expect(pressName(press("#", "Digit3", { shiftKey: true }))).toBe("#");
    expect(pressName(press("№", "Digit3", { shiftKey: true }))).toBe("#");
    expect(pressName(press("!", "Digit1", { shiftKey: true }))).toBe("!");
    // The Russian "." sits on the US "/".
    expect(pressName(press(".", "Slash"))).toBe("/");
  });

  it("names the other keys by name", () => {
    expect(pressName(press("Delete", "Delete"))).toBe("Delete");
    expect(pressName(press("ArrowDown", "ArrowDown", { shiftKey: true }))).toBe("Shift+ArrowDown");
    expect(pressName(press("Enter", "Enter", { ctrlKey: true }))).toBe("Mod+Enter");
    expect(pressName(press(" ", "Space"))).toBe("Space");
    expect(pressName(press("F5", "F5"))).toBe("F5");
  });

  it("waits while only modifiers are held", () => {
    expect(pressName(press("Control", "ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(pressName(press("Shift", "ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(heldMods(press("Shift", "ShiftLeft", { ctrlKey: true, shiftKey: true }))).toEqual(["Mod", "Shift"]);
  });

  it("works for synthetic presses without a code", () => {
    expect(pressName(press("e"))).toBe("e");
    expect(pressName(press(",", "", { ctrlKey: true }))).toBe("Mod+,");
    expect(pressNames(press("k", "", { ctrlKey: true }))).toEqual(["Mod+k"]);
  });

  it("offers what the key types, then the US key in its place", () => {
    expect(pressNames(press("о", "KeyJ"))).toEqual(["j"]);
    expect(pressNames(press(".", "Slash"))).toEqual([".", "/"]);
    // The German "#" key: the character it types, then the US one in its place.
    expect(pressNames(press("#", "Backslash"))).toEqual(["#", "\\"]);
    expect(pressNames(press("л", "KeyK", { ctrlKey: true }))).toEqual(["Mod+k"]);
    expect(pressNames(press("z", "KeyY"))).toEqual(["z", "y"]);
  });
});

describe("labels", () => {
  it("shows the Russian letter of the same key under a single key", () => {
    expect(caps("e", "ru")).toEqual([{ main: "e", legend: "у" }]);
    expect(caps("#", "ru")).toEqual([{ main: "#", legend: "№" }]);
    expect(caps("/", "ru")).toEqual([{ main: "/", legend: "." }]);
    expect(caps("Shift+r", "ru")).toEqual([{ main: "Shift" }, { main: "R", legend: "К" }]);
    expect(caps("!", "ru")).toEqual([{ main: "!" }]);
  });

  it("leaves Ctrl and Alt combinations with one label", () => {
    expect(caps("Mod+l", "ru")).toEqual([{ main: "Ctrl" }, { main: "L" }]);
    expect(caps("Mod+Shift+p", "ru")).toEqual([{ main: "Ctrl" }, { main: "Shift" }, { main: "P" }]);
  });

  it("names Mod as Cmd on macOS and as Ctrl elsewhere", () => {
    expect(caps("Mod+l", "ru", true)).toEqual([{ main: "⌘" }, { main: "L" }]);
    expect(caps("Mod+Shift+p", "en", false)).toEqual([{ main: "Ctrl" }, { main: "Shift" }, { main: "P" }]);
    expect(keyText("Mod+k", "ru", true)).toBe("⌘+K");
    expect(keyText("Mod+k", "ru", false)).toBe("Ctrl+K");
    expect(modName(true)).toBe("⌘");
    expect(modName(false)).toBe("Ctrl");
  });

  it("names special keys readably", () => {
    expect(caps("ArrowDown", "ru")).toEqual([{ main: "↓" }]);
    expect(caps("Escape", "en")).toEqual([{ main: "Esc" }]);
    expect(caps("Space", "ru")).toEqual([{ main: "Пробел" }]);
    expect(caps("Space", "en")).toEqual([{ main: "Space" }]);
  });

  it("has no Russian label in English", () => {
    expect(caps("e", "en")).toEqual([{ main: "e" }]);
  });

  it("writes a key as text for tooltips and menus", () => {
    expect(keyText("e", "ru")).toBe("e/у");
    expect(keyText("e", "en")).toBe("e");
    expect(keyText("Mod+Shift+p", "ru")).toBe("Ctrl+Shift+P");
    expect(keyText("Shift+r", "ru")).toBe("Shift+R/К");
    expect(keyText("Delete", "ru")).toBe("Delete");
    expect(keyText("Mod+,", "en")).toBe("Ctrl+,");
  });
});

describe("what may not be assigned", () => {
  it("keeps Ctrl+C, Ctrl+V and Ctrl+X to the system", () => {
    for (const k of ["Mod+c", "Mod+v", "Mod+x"]) expect(problem(k, "main")).toEqual({ kind: "system" });
    expect(problem("Mod+z", "main")).toBeNull();
    expect(problem("Tab", "main")).toBeNull();
    expect(problem("Mod+a", "main")).toBeNull();
  });

  it("keeps Ctrl+K to the palette", () => {
    expect(problem("Mod+k", "main")).toEqual({ kind: "palette" });
    expect(problem("Mod+k", "compose")).toEqual({ kind: "palette" });
  });

  it("does not let a single key into the composition window, where it types", () => {
    expect(problem("b", "compose")).toEqual({ kind: "letter" });
    expect(problem("Shift+b", "compose")).toEqual({ kind: "letter" });
    expect(problem("Mod+Shift+b", "compose")).toBeNull();
    expect(problem("Alt+b", "compose")).toBeNull();
    expect(problem("Escape", "compose")).toBeNull();
    expect(problem("F2", "compose")).toBeNull();
    // In the main window single keys are the usual ones.
    expect(problem("b", "main")).toBeNull();
    expect(problem("Shift+r", "main")).toBeNull();
  });
});

describe("resolving the keys", () => {
  it("gives every command its default keys", () => {
    const r = resolve(COMMANDS, {});
    expect(r.keys["core.reply"]).toEqual(["r"]);
    expect(r.keys["core.delete"]).toEqual(["Delete", "#"]);
    expect(r.keys["core.sync"]).toEqual([]);
    expect(r.lost).toEqual([]);
  });

  it("puts the user's keys over the defaults", () => {
    const r = resolve(COMMANDS, { "core.reply-all": ["Shift+r"], "core.delete": ["d"] });
    expect(r.keys["core.reply-all"]).toEqual(["Shift+r"]);
    expect(r.keys["core.delete"]).toEqual(["d"]);
  });

  it("keeps a key with whoever had it first: a plugin gets its command without it", () => {
    // The user gave "h" to Sync; the snooze plugin wanted it too.
    const r = resolve(COMMANDS, { "core.sync": ["h"] });
    expect(r.keys["core.sync"]).toEqual(["h"]);
    expect(r.keys["snooze.open"]).toEqual([]);
    expect(r.lost).toEqual([{ id: "snooze.open", key: "h", holder: "core.sync" }]);
  });

  it("keeps the core's default keys from a plugin", () => {
    const r = resolve([...COMMANDS, cmd("templates.insert", ["e"], "main", "templates")], {});
    expect(r.keys["core.archive"]).toEqual(["e"]);
    expect(r.keys["templates.insert"]).toEqual([]);
    expect(r.lost).toEqual([{ id: "templates.insert", key: "e", holder: "core.archive" }]);
  });

  it("lets the plugin registered first keep a key two plugins want", () => {
    const r = resolve([...COMMANDS, cmd("a.x", ["x"], "main", "a"), cmd("b.x", ["x"], "main", "b")], {});
    expect(r.keys["a.x"]).toEqual(["x"]);
    expect(r.keys["b.x"]).toEqual([]);
  });

  it("lets the same key work in different windows", () => {
    const r = resolve(COMMANDS, { "core.sync": ["Mod+l"] });
    expect(r.keys["core.sync"]).toEqual(["Mod+l"]);
    expect(r.keys["compose.link"]).toEqual(["Mod+l"]);
    expect(r.lost).toEqual([]);
  });

  it("finds the command of a press, in the window it is pressed in", () => {
    const r = resolve(COMMANDS, { "core.sync": ["Mod+l"] });
    expect(findCommand(r, COMMANDS, ["Mod+l"], ["main", "all"])).toBe("core.sync");
    expect(findCommand(r, COMMANDS, ["Mod+l"], ["compose", "all"])).toBe("compose.link");
    expect(findCommand(r, COMMANDS, ["Mod+k"], ["all"])).toBe("palette");
    expect(findCommand(r, COMMANDS, ["ArrowDown"], ["main", "all"])).toBe("core.next");
    expect(findCommand(r, COMMANDS, ["Mod+p"], ["main", "all"])).toBeUndefined();
    // A key taken from a plugin does not run it.
    const lost = resolve(COMMANDS, { "core.sync": ["h"] });
    expect(findCommand(lost, COMMANDS, ["h"], ["main", "all"])).toBe("core.sync");
  });

  it("tries the names of a press best first", () => {
    const r = resolve(COMMANDS, {});
    expect(findCommand(r, COMMANDS, [".", "/"], ["main", "all"])).toBeUndefined();
    expect(findCommand(r, COMMANDS, ["№", "#"], ["main", "all"])).toBe("core.delete");
  });
});

describe("assigning a key", () => {
  it("takes a free key at once", () => {
    const res = take(COMMANDS, {}, "core.sync", 0, "y");
    expect(res).toEqual({ ok: { "core.sync": ["y"] } });
  });

  it("adds one more key to a command", () => {
    expect(take(COMMANDS, {}, "core.reply", 1, "Shift+r")).toEqual({ ok: { "core.reply": ["r", "Shift+r"] } });
  });

  it("refuses what may not be assigned", () => {
    expect(take(COMMANDS, {}, "core.sync", 0, "Mod+c")).toEqual({ problem: { kind: "system" } });
    expect(take(COMMANDS, {}, "compose.link", 0, "l")).toEqual({ problem: { kind: "letter" } });
    expect(take(COMMANDS, {}, "core.sync", 0, "Mod+k")).toEqual({ problem: { kind: "palette" } });
  });

  it("says when the command has the key already", () => {
    expect(take(COMMANDS, {}, "core.next", 0, "ArrowDown")).toEqual({ same: true });
    // Pressing the same key again in its own place changes nothing and is fine.
    expect(take(COMMANDS, {}, "core.reply", 0, "r")).toEqual({ ok: {} });
  });

  it("shows a conflict with the command holding the key, in the same window only", () => {
    expect(take(COMMANDS, {}, "core.forward", 0, "e")).toEqual({ conflict: { other: "core.archive" } });
    expect(take(COMMANDS, {}, "core.sync", 0, "Mod+l")).toEqual({ ok: { "core.sync": ["Mod+l"] } });
  });

  it("replaces: the other command loses the key", () => {
    const custom = replace(COMMANDS, {}, "core.forward", 0, "e", "core.archive");
    expect(custom).toEqual({ "core.forward": ["e"], "core.archive": [] });
    expect(resolve(COMMANDS, custom).keys["core.archive"]).toEqual([]);
  });

  it("replaces one of several keys of the other command", () => {
    const custom = replace(COMMANDS, {}, "core.sync", 0, "#", "core.delete");
    expect(custom).toEqual({ "core.sync": ["#"], "core.delete": ["Delete"] });
  });

  it("swaps: the other command gets the old key", () => {
    expect(canSwap(COMMANDS, {}, "core.forward", 0, "core.archive")).toBe(true);
    const custom = swap(COMMANDS, {}, "core.forward", 0, "e", "core.archive");
    expect(custom).toEqual({ "core.forward": ["e"], "core.archive": ["f"] });
  });

  it("does not swap a key the command did not have, or one the other cannot take", () => {
    // A new, second key for Reply: nothing to give back.
    expect(canSwap(COMMANDS, {}, "core.reply", 1, "core.archive")).toBe(false);
    // A command of both windows cannot take a single letter: it would type in a letter.
    const all: KeyCommand[] = [...COMMANDS, cmd("core.both", ["Mod+j"], "all")];
    expect(take(all, {}, "core.reply", 0, "Mod+j")).toEqual({ conflict: { other: "core.both" } });
    expect(canSwap(all, {}, "core.reply", 0, "core.both")).toBe(false);
    expect(canSwap(all, { "core.reply": ["Mod+Shift+j"] }, "core.reply", 0, "core.both")).toBe(true);
  });

  it("removes one key and resets one command", () => {
    const custom = removeKey(COMMANDS, {}, "core.delete", 1);
    expect(custom).toEqual({ "core.delete": ["Delete"] });
    expect(changed(COMMANDS, custom, "core.delete")).toBe(true);
    expect(resetOne(custom, "core.delete")).toEqual({});
  });

  it("keeps only what differs from the defaults", () => {
    expect(setKeys(COMMANDS, { "core.reply": ["x"] }, "core.reply", ["r"])).toEqual({});
    expect(changed(COMMANDS, {}, "core.reply")).toBe(false);
    // A plugin that lost its key to the user is not "changed": nobody changed it.
    expect(changed(COMMANDS, { "core.sync": ["h"] }, "snooze.open")).toBe(false);
  });

  it("does not touch a locked command", () => {
    expect(take(COMMANDS, {}, "palette", 0, "Mod+p")).toEqual({ problem: { kind: "palette" } });
  });
});

describe("search", () => {
  it("finds a command by a letter of its key, Russian or Latin", () => {
    expect(matches("у", "Готово: убрать в архив", ["e"])).toBe(true);
    expect(matches("e", "Готово: убрать в архив", ["e"])).toBe(true);
    // One letter is a key: "у" does not find every title with "у" in it.
    expect(matches("у", "Удалить", ["Delete", "#"])).toBe(false);
    expect(matches("№", "Удалить", ["Delete", "#"])).toBe(true);
  });

  it("finds by two letters and more in titles and key names", () => {
    expect(matches("удал", "Удалить", ["Delete", "#"])).toBe(true);
    expect(matches("ctrl", "Ссылка", ["Mod+l"])).toBe(true);
    expect(matches("ctrl", "Ответить", ["r"])).toBe(false);
    expect(matches("", "Ответить", ["r"])).toBe(true);
  });
});
