import { describe, expect, it } from "vitest";
import { CORE_KEYS } from "./keyCommands";
import { pressNames, resolve } from "./keymap";

const all = CORE_KEYS.map((c) => ({ ...c, owner: "core" }));

describe("the core's commands and their keys", () => {
  it("names each command once", () => {
    const ids = CORE_KEYS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no key twice where both commands work", () => {
    expect(resolve(all, {}).lost).toEqual([]);
  });

  it("keeps the keys there were before the registry", () => {
    const keys = Object.fromEntries(CORE_KEYS.map((c) => [c.id, c.keys]));
    expect(keys).toMatchObject({
      "core.next": ["j", "ArrowDown"],
      "core.prev": ["k", "ArrowUp"],
      "core.reply": ["r"],
      "core.reply-all": ["a"],
      "core.forward": ["f"],
      "core.compose": ["c"],
      "core.archive": ["e"],
      "core.spam": ["!"],
      "core.undo": ["z"],
      "core.unread": ["u"],
      "core.flag": ["s"],
      "core.labels": ["l"],
      "core.release": ["w"],
      "core.search": ["/"],
      "core.settings": ["Mod+,"],
      "core.quit": ["Mod+q"],
      "core.select-all": ["Mod+a"],
      "core.sync": [],
      "compose.send": ["Mod+Enter"],
      "compose.fold": ["Escape"],
      "compose.save": ["Mod+s"],
      "compose.bold": ["Mod+b"],
      "compose.italic": ["Mod+i"],
      "compose.underline": ["Mod+u"],
      "compose.link": ["Mod+l"],
      "compose.preview": ["Mod+Shift+p"],
      "compose.importance": ["Alt+p"],
    });
  });

  it("shows Delete first for «Delete»: the palette and the menus say the same", () => {
    expect(CORE_KEYS.find((c) => c.id === "core.delete")?.keys).toEqual(["Delete", "#"]);
  });

  it("runs «Clear» on Ctrl+Shift+Delete, apart from Delete that takes the letters (#74)", () => {
    expect(CORE_KEYS.find((c) => c.id === "core.empty-folder")?.keys).toEqual(["Mod+Shift+Delete"]);
    const press = { key: "Delete", code: "Delete", shiftKey: true, ctrlKey: true, metaKey: false, altKey: false };
    expect(pressNames(press)).toContain("Mod+Shift+Delete");
    const names = pressNames({ ...press, shiftKey: false, ctrlKey: false });
    expect(names).toContain("Delete");
    expect(names).not.toContain("Mod+Shift+Delete");
  });

  it("leaves Ctrl+K to the palette, and gives Ctrl+P to printing the open letter (#70)", () => {
    const keys = CORE_KEYS.flatMap((c) => c.keys);
    expect(keys).not.toContain("Mod+k");
    expect(CORE_KEYS.filter((c) => c.keys.includes("Mod+p")).map((c) => c.id)).toEqual(["core.print"]);
    // From text fields too: the browser's own Ctrl+P would print the whole interface.
    expect(CORE_KEYS.find((c) => c.id === "core.print")?.group).toBe("everywhere");
  });
});

describe("the keys of the letter's window (#103)", () => {
  it("gives the letter's window the Alt+letter keys (#103, 4.1 А, 4.3 А)", () => {
    const keys = Object.fromEntries(CORE_KEYS.filter((c) => c.id.startsWith("compose.")).map((c) => [c.id, c.keys]));
    expect(keys).toMatchObject({
      "compose.cc": ["Alt+c"],
      "compose.bcc": ["Alt+b"],
      "compose.from": ["Alt+m"],
      "compose.files": ["Alt+a"],
      "compose.quote": ["Alt+q"],
      "compose.format": ["Alt+f"],
      "compose.park": ["Alt+i"],
      "compose.remind": ["Alt+r"],
      "compose.more": ["Alt+."],
    });
  });
});
