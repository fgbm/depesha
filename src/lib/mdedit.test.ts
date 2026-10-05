import { describe, expect, it } from "vitest";
import { clearEdit, linesEdit, linkEdit, wrapEdit, type Edit } from "./mdedit";

function apply(text: string, e: Edit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to);
}

describe("Markdown buttons", () => {
  it("marks the selection and takes the marks off again", () => {
    const text = "в целом всё сходится";
    const e = wrapEdit(text, 8, 20, "**");
    expect(apply(text, e)).toBe("в целом **всё сходится**");
    const marked = apply(text, e);
    expect(apply(marked, wrapEdit(marked, e.select[0], e.select[1], "**"))).toBe(text);
  });

  it("puts the caret between the marks when nothing is selected", () => {
    const e = wrapEdit("ab", 1, 1, "*");
    expect(apply("ab", e)).toBe("a**b");
    expect(e.select).toEqual([2, 2]);
  });

  it("makes the selected lines a list and back", () => {
    const text = "Пункты:\nаренда\nтранспорт";
    const bullets = linesEdit(text, 9, 20, "bullets");
    expect(apply(text, bullets)).toBe("Пункты:\n- аренда\n- транспорт");
    const listed = apply(text, bullets);
    expect(apply(listed, linesEdit(listed, bullets.select[0], bullets.select[1], "bullets"))).toBe(text);
    expect(apply(text, linesEdit(text, 9, 20, "numbers"))).toBe("Пункты:\n1. аренда\n2. транспорт");
    expect(apply(text, linesEdit(text, 0, 0, "quote"))).toBe("> Пункты:\nаренда\nтранспорт");
  });

  it("writes a link around the selection", () => {
    expect(apply("в общей таблице", linkEdit("в общей таблице", 2, 15, "https://example.com/smeta"))).toBe(
      "в [общей таблице](https://example.com/smeta)",
    );
    expect(apply("", linkEdit("", 0, 0, "mailto:a@example.com"))).toBe("[a@example.com](mailto:a@example.com)");
  });

  it("clears the markup and keeps the words", () => {
    const text = "- **всё** *сходится*, см. [таблицу](https://example.com) <u>сейчас</u>";
    expect(apply(text, clearEdit(text, 0, text.length))).toBe("всё сходится, см. таблицу сейчас");
  });
});
