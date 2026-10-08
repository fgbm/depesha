import { describe, expect, it } from "vitest";
import { CORE_KEYS } from "./keyCommands";
import { resolve } from "./keymap";

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
    });
  });

  it("shows Delete first for «Delete»: the palette and the menus say the same", () => {
    expect(CORE_KEYS.find((c) => c.id === "core.delete")?.keys).toEqual(["Delete", "#"]);
  });

  it("leaves Ctrl+K to the palette and Ctrl+P to printing", () => {
    const keys = CORE_KEYS.flatMap((c) => c.keys);
    expect(keys).not.toContain("Mod+k");
    expect(keys).not.toContain("Mod+p");
  });
});
