import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FADE_MS, Favourites, neighbour, readFavourites, splitPath } from "./favourites.svelte";

const folder = (name: string, delimiter: string | null = ".") => ({ name, display: name, delimiter });

function make(saved: string | null = null) {
  const store = { value: saved };
  const favs = new Favourites({ get: () => store.value, set: (v) => (store.value = v) });
  return { favs, saved: () => readFavourites(store.value) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("favourite folders", () => {
  it("keeps the order of adding and no duplicates", () => {
    const { favs, saved } = make();
    for (let i = 1; i <= 9; i++) favs.add("a", folder(`F${i}`));
    favs.add("a", folder("Работа.Проекты.2026"));
    favs.add("a", folder("F3"));
    expect(favs.of("a")).toHaveLength(10);
    expect(favs.of("a").map((f) => f.name)).toEqual([...Array.from({ length: 9 }, (_, i) => `F${i + 1}`), "Работа.Проекты.2026"]);
    expect(saved().a).toHaveLength(10);
  });

  it("are kept apart by mailbox, the same names too", () => {
    const { favs } = make();
    favs.add("a", folder("Отчёты"));
    expect(favs.has("a", "Отчёты")).toBe(true);
    expect(favs.has("b", "Отчёты")).toBe(false);
    expect(favs.of("b")).toEqual([]);
  });

  it("are read back on the next launch, a damaged record ignored", () => {
    const { favs, saved } = make();
    favs.add("a", folder("INBOX"));
    favs.add("b", folder("Archive"));
    const again = make(JSON.stringify(saved())).favs;
    expect(again.of("a").map((f) => f.name)).toEqual(["INBOX"]);
    expect(again.has("b", "Archive")).toBe(true);
    expect(readFavourites("not json")).toEqual({});
    expect(readFavourites('{"a":[{"name":"X"},{"name":"X"},{"x":1}]}')).toEqual({ a: [{ name: "X", display: "X", delimiter: null }] });
  });

  it("toggle from the tree removes at once", () => {
    const { favs, saved } = make();
    favs.toggle("a", folder("INBOX"));
    expect(favs.has("a", "INBOX")).toBe(true);
    favs.toggle("a", folder("INBOX"));
    expect(favs.of("a")).toEqual([]);
    expect(saved()).toEqual({});
  });
});

describe("unstarring in the favourites block", () => {
  it("keeps the row in place while it fades, then removes it", () => {
    const { favs, saved } = make();
    favs.add("a", folder("A"));
    favs.add("a", folder("B"));
    favs.toggle("a", folder("A"), true);
    // The star is empty at once; the row and its place stay.
    expect(favs.has("a", "A")).toBe(false);
    expect(favs.isLeaving("a", "A")).toBe(true);
    expect(favs.of("a").map((f) => f.name)).toEqual(["A", "B"]);
    vi.advanceTimersByTime(FADE_MS - 1);
    expect(favs.of("a")).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(favs.of("a").map((f) => f.name)).toEqual(["B"]);
    expect(favs.isLeaving("a", "A")).toBe(false);
    expect(saved().a.map((f) => f.name)).toEqual(["B"]);
  });

  it("a second press while it fades cancels the removal entirely", () => {
    const { favs } = make();
    favs.add("a", folder("A"));
    favs.toggle("a", folder("A"), true);
    vi.advanceTimersByTime(FADE_MS / 2);
    favs.toggle("a", folder("A"), true);
    expect(favs.has("a", "A")).toBe(true);
    expect(favs.isLeaving("a", "A")).toBe(false);
    vi.advanceTimersByTime(FADE_MS * 3);
    expect(favs.of("a").map((f) => f.name)).toEqual(["A"]);
  });

  it("the star in the tree follows the block, and restores the fading row", () => {
    const { favs } = make();
    favs.add("a", folder("A"));
    favs.remove("a", "A", true);
    expect(favs.has("a", "A")).toBe(false);
    favs.toggle("a", folder("A"));
    expect(favs.has("a", "A")).toBe(true);
    vi.advanceTimersByTime(FADE_MS * 2);
    expect(favs.of("a")).toHaveLength(1);
  });

  it("several rows can go one after another", () => {
    const { favs } = make();
    for (const n of ["A", "B", "C"]) favs.add("a", folder(n));
    favs.toggle("a", folder("A"), true);
    vi.advanceTimersByTime(FADE_MS);
    favs.toggle("a", folder("B"), true);
    vi.advanceTimersByTime(FADE_MS);
    expect(favs.of("a").map((f) => f.name)).toEqual(["C"]);
  });

  it("tells the sidebar before the row leaves, to move the focus", () => {
    const { favs } = make();
    const left: string[] = [];
    favs.onleave = (_, name) => left.push(`${name}:${favs.of("a").length}`);
    favs.add("a", folder("A"));
    favs.add("a", folder("B"));
    favs.remove("a", "A", true);
    vi.advanceTimersByTime(FADE_MS);
    expect(left).toEqual(["A:2"]);
  });
});

describe("focus after a row leaves", () => {
  it("goes to the next row, else the one before, else nowhere in the block", () => {
    expect(neighbour(["a", "b", "c"], 1)).toBe("c");
    expect(neighbour(["a", "b", "c"], 2)).toBe("b");
    expect(neighbour(["a"], 0)).toBeNull();
  });
});

describe("the path of a favourite", () => {
  it("tells apart folders of the same name in different branches", () => {
    expect(splitPath("Работа/Отчёты", "/")).toEqual({ leaf: "Отчёты", path: "Работа" });
    expect(splitPath("Личное/2026/Отчёты", "/")).toEqual({ leaf: "Отчёты", path: "Личное / 2026" });
    expect(splitPath("INBOX.Проекты", ".")).toEqual({ leaf: "Проекты", path: "" });
    expect(splitPath("Archive", null)).toEqual({ leaf: "Archive", path: "" });
  });
});
