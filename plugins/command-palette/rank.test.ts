import { describe, expect, it } from "vitest";
import type { Command } from "@depesha/plugin-api";
import { Recency, matchQuality, rank } from "./rank";

const cmd = (id: string, title: string): Command => ({ id, title: () => title, run: () => {} });
const commands = [
  cmd("compose", "Compose"),
  cmd("archive", "Archive"),
  cmd("move.archive", "Move to: Archive"),
  cmd("large", "Find: large (over 25 MB)"),
  cmd("large.old", "Find: large, older than a year"),
  cmd("sort.size", "Sort: largest first"),
];

function memory() {
  let saved: string | null = null;
  return { get: () => saved, set: (v: string) => (saved = v) };
}

describe("palette order", () => {
  it("rates a match at the first word above one further in", () => {
    expect(matchQuality("Archive", "arch")).toBe(2);
    expect(matchQuality("Move to: Archive", "arch")).toBe(1);
    expect(matchQuality("Compose", "arch")).toBe(-1);
  });

  it("puts the commands used last first in an empty query, then the rest in their order", () => {
    const r = new Recency(memory());
    r.touch("sort.size", 1000);
    r.touch("large", 2000);
    expect(rank(commands, "", r).map((c) => c.id)).toEqual(["large", "sort.size", "compose", "archive", "move.archive", "large.old"]);
  });

  it("orders equal matches by last use, better matches first", () => {
    const r = new Recency(memory());
    r.touch("large.old", 5000);
    r.touch("move.archive", 6000);
    expect(rank(commands, "lar", r).map((c) => c.id)).toEqual(["large.old", "large", "sort.size"]);
    // "Archive" matches at its first word: recency does not lift "Move to: Archive" over it.
    expect(rank(commands, "arch", r).map((c) => c.id)).toEqual(["archive", "move.archive"]);
  });

  it("remembers across restarts and forgets what it cannot read", () => {
    const storage = memory();
    new Recency(storage).touch("archive", 42);
    expect(new Recency(storage).at("archive")).toBe(42);
    expect(new Recency({ get: () => "[", set: () => {} }).at("archive")).toBe(0);
  });
});
