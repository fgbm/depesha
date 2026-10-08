import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdownSupport } from "./dialect";
import { isOwnPicture, previewPieces, type Piece, type PreviewOptions } from "./preview";

/** A letter with the caret where `‸` stands (two of them: a selection). */
function stateOf(marked: string): EditorState {
  const at = [...marked.matchAll(/‸/g)].map((m) => m.index! - [...marked.slice(0, m.index)].filter((c) => c === "‸").length);
  const doc = marked.replace(/‸/g, "");
  return EditorState.create({ doc, selection: EditorSelection.single(at[0] ?? 0, at[1] ?? at[0] ?? 0), extensions: [markdownSupport()] });
}

/** The text as the editor shows it: hidden marks gone, widgets as their characters. */
function shown(marked: string, opts: Partial<PreviewOptions> = {}): string {
  const state = stateOf(marked);
  const doc = state.doc.toString();
  const replaced = previewPieces(state, { focused: true, markup: false, ...opts })
    .filter((p): p is Extract<Piece, { from: number; to: number }> => "to" in p && p.kind !== "style" && p.kind !== "token")
    .sort((a, b) => a.from - b.from);
  let out = "";
  let at = 0;
  for (const p of replaced) {
    if (p.from < at) continue; // inside a range already replaced
    out += doc.slice(at, p.from) + (p.kind === "bullet" ? "•" : p.kind === "task" ? (p.done ? "☑" : "☐") : p.kind === "table" ? "[таблица]" : p.kind === "image" ? "[картинка]" : "");
    at = p.to;
  }
  return out + doc.slice(at);
}

describe("Live Preview: what is hidden where the caret is", () => {
  const letter = "Текст **жирный**, *курсив*, ~~зачёрк~~, `код` и [ссылка](https://example.com/s).";

  it("hides the marks of every element away from the caret", () => {
    expect(shown(letter + "\n‸")).toBe("Текст жирный, курсив, зачёрк, код и ссылка.\n");
  });

  it("shows the marks of the element under the caret only", () => {
    expect(shown("Текст **жир‸ный**, *курсив*.")).toBe("Текст **жирный**, курсив.");
    expect(shown("Текст **жирный**, *кур‸сив*.")).toBe("Текст жирный, *курсив*.");
    expect(shown("Код `x‸y` и **ж**.")).toBe("Код `xy` и ж.");
  });

  it("counts the caret touching an element as in it", () => {
    expect(shown("а ‸**б** в")).toBe("а **б** в");
    expect(shown("а **б**‸ в")).toBe("а **б** в");
    expect(shown("а **б** ‸в")).toBe("а б в");
    expect(shown("и [ссылка](https://example.com)‸.")).toBe("и [ссылка](https://example.com).");
  });

  it("shows the elements a selection touches", () => {
    expect(shown("**а** ‸*б* `в`‸ **г**")).toBe("а *б* `в` г");
  });

  it("shows nothing when the field is not focused", () => {
    expect(shown("Текст **жир‸ный**.", { focused: false })).toBe("Текст жирный.");
  });

  it("shows all the markup at once in the markup mode", () => {
    const text = "# Заголовок\n- [ ] пункт\n> цитата\n" + letter;
    expect(shown(text + "‸", { markup: true })).toBe(text);
  });

});

describe("Live Preview: the blocks of a letter", () => {
  it("hides the mark of a heading unless the caret is at it", () => {
    expect(shown("# Заголовок\nтекст‸")).toBe("Заголовок\nтекст");
    expect(shown("# Заголовок‸\nтекст")).toBe("Заголовок\nтекст");
    expect(shown("# ‸Заголовок\nтекст")).toBe("# Заголовок\nтекст");
    expect(shown("‸# Заголовок\nтекст")).toBe("# Заголовок\nтекст");
  });

  it("draws bullets and boxes, keeps the numbers", () => {
    expect(shown("- раз\n- два\n\n1. три\n‸")).toBe("• раз\n• два\n\n1. три\n");
    expect(shown("- [ ] купить\n- [x] позвонить\n‸")).toBe("• ☐ купить\n• ☑ позвонить\n");
    expect(shown("- раз\n- ‸два")).toBe("• раз\n- два");
    expect(shown("- [‸x] позвонить")).toBe("• [x] позвонить");
  });

  it("hides the marks of a quote", () => {
    expect(shown("> цитата\n> ещё\nтекст‸")).toBe("цитата\nещё\nтекст");
    expect(shown("> ‸цитата\n> ещё")).toBe("> цитата\nещё");
  });

  it("opens a code block whole when the caret is in any of its lines", () => {
    const code = "```sql\nselect **1**\n```\n";
    expect(shown(code + "текст‸")).toBe("\nselect **1**\n\nтекст");
    expect(shown("```sql\nselect ‸**1**\n```\nтекст")).toBe(code + "текст");
    expect(shown("```sql‸\nselect **1**\n```\nтекст")).toBe(code + "текст");
  });

  it("draws a table always, its cells edited in place (not its source)", () => {
    const table = "| Кто | Что |\n|---|---|\n| Иван | зал |";
    expect(shown(table + "\n\nтекст‸")).toBe("[таблица]\n\nтекст");
    expect(shown("| Кто | Что |\n|---|---|\n| Иван | з‸ал |\n\nтекст")).toBe("[таблица]\n\nтекст");
    // Only the "markup" mode shows the bare source.
    expect(shown(table + "‸", { markup: true })).toBe(table);
  });

  it("shows an image in place, its markup under the caret", () => {
    const pic = "![План](data:image/png;base64,AA)";
    expect(shown(pic + "\n\nтекст‸")).toBe("[картинка]\n\nтекст");
    expect(shown("![План](data:image/png;base64,‸AA)")).toBe(pic);
    expect(shown(pic + "‸", { markup: true })).toBe(pic);
  });

  it("hides the underline tags and the escapes of a letter", () => {
    expect(shown("текст <u>подчёркнут</u> и \\*звёздочка\\*.‸")).toBe("текст подчёркнут и *звёздочка*.");
    expect(shown("текст <u>подч‸ёркнут</u>")).toBe("текст <u>подчёркнут</u>");
  });

  it("keeps the heading and quote lines styled wherever the caret is", () => {
    const lines = (marked: string, opts: Partial<PreviewOptions> = {}) =>
      previewPieces(stateOf(marked), { focused: true, markup: false, ...opts })
        .filter((p) => p.kind === "line")
        .map((p) => (p.kind === "line" ? p.class : ""));
    expect(lines("# А\n> б‸")).toEqual(["md-h1", "md-quote"]);
    expect(lines("# ‸А\n> б", { markup: true })).toEqual(["md-h1", "md-quote"]);
  });

  it("gives the ranges in document order", () => {
    const pieces = previewPieces(stateOf("# А **б**\n- [ ] *в*\n> `г`\n‸"), { focused: true, markup: false });
    const starts = pieces.map((p) => ("at" in p ? p.at : p.from));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe("what the editor draws in place of a picture", () => {
  it("draws a picture of the letter's own, not a remote one", () => {
    expect(isOwnPicture("data:image/png;base64,AA")).toBe(true);
    expect(isOwnPicture("cid:part1@example")).toBe(true);
    expect(isOwnPicture("blob:http://localhost/abc")).toBe(true);
    expect(isOwnPicture("https://tracker.example/p.gif")).toBe(false);
    expect(isOwnPicture("http://tracker.example/p.gif")).toBe(false);
    expect(isOwnPicture("//tracker.example/p.gif")).toBe(false);
    expect(isOwnPicture("p.gif")).toBe(false);
  });
});
