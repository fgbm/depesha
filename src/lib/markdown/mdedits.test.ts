import { describe, expect, it } from "vitest";
import { codeEdit, headingEdit, pictureAltEdit, pictureEdit, pictureRemoveEdit, tableEdit } from "../markdown/mdedits";
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

  it("rewrites the description of a picture, keeping its address", () => {
    const text = "текст\n![План зала](data:image/png;base64,AA)\nхвост";
    const e = pictureAltEdit(text, 6, "План на 14-е")!;
    expect(apply(text, e)).toBe("текст\n![План на 14-е](data:image/png;base64,AA)\nхвост");
    // Nothing new typed: the same text, so the widget skips it and Ctrl+Z has nothing to undo.
    const same = pictureAltEdit(text, 6, "План зала")!;
    expect(apply(text, same)).toBe(text);
  });

  it("finds the picture on the caret's line", () => {
    const text = "![План](a.png)\n\nвторой абзац";
    // The caret anywhere on the picture's line finds it.
    expect(pictureAltEdit(text, 3, "Схема")).toBeTruthy();
    expect(pictureRemoveEdit(text, 3)).toBeTruthy();
    // A line with no picture is not touched.
    expect(pictureAltEdit(text, text.length, "Схема")).toBeNull();
    expect(pictureRemoveEdit(text, text.length)).toBeNull();
  });

  it("takes a picture out, its line and the blank line after it", () => {
    const text = "до\n![План](a.png)\nпосле";
    const e = pictureRemoveEdit(text, 5)!;
    expect(apply(text, e)).toBe("до\nпосле");
    const end = "до\n![План](a.png)";
    expect(apply(end, pictureRemoveEdit(end, 5)!)).toBe("до");
  });
});
