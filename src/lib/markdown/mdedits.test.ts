import { describe, expect, it } from "vitest";
import { codeEdit, headingEdit, pictureEdit, tableEdit } from "../markdown/mdedits";
import type { Edit } from "../mdedit";

function apply(text: string, e: Edit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to);
}

describe("heading, code, table and picture of a Markdown letter", () => {
  it("turns a line into a heading and back, keeping the level", () => {
    const text = "Пункт\nвторой";
    const h1 = headingEdit(text, 0, 0, 1);
    expect(apply(text, h1)).toBe("# Пункт\nвторой");
    const marked = apply(text, h1);
    const h2 = headingEdit(marked, 2, 2, 2);
    expect(apply(marked, h2)).toBe("## Пункт\nвторой");
    const back = headingEdit(apply(marked, h2), 3, 3, 2);
    expect(apply(apply(marked, h2), back)).toBe("Пункт\nвторой");
  });

  it("makes a code block of the lines and back", () => {
    const text = "текст\nselect 1\nещё";
    const fenced = codeEdit(text, 6, 6);
    expect(apply(text, fenced)).toBe("текст\n```\nselect 1\n```\nещё");
    const off = codeEdit("текст\n```\nselect 1\n```\nещё", 6, 6);
    expect(apply("текст\n```\nselect 1\n```\nещё", off)).toBe("текст\nselect 1\nещё");
  });

  it("makes inline code of a selection inside a line", () => {
    const e = codeEdit("слово тут", 0, 5);
    expect(apply("слово тут", e)).toBe("`слово` тут");
    expect(e.select).toEqual([1, 6]);
    const off = codeEdit("`слово` тут", 1, 6);
    expect(apply("`слово` тут", off)).toBe("слово тут");
  });

  it("puts a table of three columns where the caret is", () => {
    const e = tableEdit("", 0, 0);
    expect(apply("", e)).toBe("|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n");
    expect(e.select).toEqual([2, 2]);
  });

  it("puts a picture on its own line", () => {
    const e = pictureEdit("План:", 5, 5, "data:image/png;base64,AA", "План зала");
    expect(apply("План:", e)).toBe("План:\n![План зала](data:image/png;base64,AA)\n");
    expect(e.select).toEqual([apply("План:", e).length, apply("План:", e).length]);
  });
});
