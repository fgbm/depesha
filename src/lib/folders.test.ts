import { describe, expect, it } from "vitest";
import { isUnder, unfolded, withChildren } from "./folders";

const f = (name: string, delimiter: string | null = ".") => ({ name, delimiter });
const tree = [f("INBOX"), f("Работа"), f("Работа.Проекты"), f("Работа.Проекты.2026"), f("Работа2"), f("Корзина")];

describe("folder tree", () => {
  it("goes by the delimiter, not by a common start of the name", () => {
    expect(isUnder(f("Работа.Проекты.2026"), f("Работа"))).toBe(true);
    expect(isUnder(f("Работа2"), f("Работа"))).toBe(false);
    expect(isUnder(f("Работа"), f("Работа"))).toBe(false);
    expect(isUnder(f("a/b", "/"), f("a", "/"))).toBe(true);
    expect(isUnder(f("a.b", null), f("a", null))).toBe(false);
  });

  it("knows which folders have subfolders", () => {
    expect([...withChildren(tree)]).toEqual(["Работа", "Работа.Проекты"]);
  });

  it("a folded folder hides its whole branch and nothing else", () => {
    const shown = (folded: string[]) => unfolded(tree, (n) => folded.includes(n)).map((x) => x.name);
    expect(shown(["Работа"])).toEqual(["INBOX", "Работа", "Работа2", "Корзина"]);
    expect(shown(["Работа.Проекты"])).toEqual(["INBOX", "Работа", "Работа.Проекты", "Работа2", "Корзина"]);
    expect(shown([])).toEqual(tree.map((x) => x.name));
  });
});
