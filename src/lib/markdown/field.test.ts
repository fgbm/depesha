import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { linesEdit, linkEdit, wrapEdit } from "../mdedit";
import { markdownSupport } from "./dialect";
import { editSpec, formatsAt } from "./field";

function stateOf(doc: string, from: number, to = from): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [history(), markdownSupport()] });
}

describe("the formatting row on the Markdown editor", () => {
  it("applies an edit of the buttons with its selection", () => {
    const s = stateOf("в целом всё сходится", 8, 20);
    const next = s.update(editSpec(wrapEdit(s.doc.toString(), 8, 20, "**"))).state;
    expect(next.doc.toString()).toBe("в целом **всё сходится**");
    expect([next.selection.main.from, next.selection.main.to]).toEqual([10, 22]);
  });

  it("undoes a button in one step, apart from the typing before it", () => {
    let s = stateOf("", 0);
    s = s.update({ changes: { from: 0, insert: "слово" }, selection: { anchor: 5 }, userEvent: "input.type" }).state;
    s = s.update(editSpec(linkEdit(s.doc.toString(), 0, 5, "https://example.com"))).state;
    expect(s.doc.toString()).toBe("[слово](https://example.com)");
    let after: EditorState | null = null;
    undo({ state: s, dispatch: (tr: Transaction) => (after = tr.state) });
    expect(after!.doc.toString()).toBe("слово");
  });

  it("works on the lines of a selection", () => {
    const s = stateOf("раз\nдва", 0, 7);
    expect(s.update(editSpec(linesEdit(s.doc.toString(), 0, 7, "numbers"))).state.doc.toString()).toBe("1. раз\n2. два");
  });

  it("presses the buttons of the formatting under the caret", () => {
    const at = (marked: string) => {
      const pos = marked.indexOf("|");
      return [...formatsAt(stateOf(marked.replace("|", ""), pos), pos)].sort();
    };
    expect(at("а **жир|ный** б")).toEqual(["bold"]);
    expect(at("а *кур|сив* б")).toEqual(["italic"]);
    expect(at("а ***о|ба*** б")).toEqual(["bold", "italic"]);
    expect(at("а <u>под|чёркнут</u> б")).toEqual(["underline"]);
    expect(at("а [ссы|лка](https://example.com) б")).toEqual(["link"]);
    expect(at("- пункт|")).toEqual(["bullets"]);
    expect(at("1. пункт **ж|**")).toEqual(["bold", "numbers"]);
    expect(at("> цитата\n> вторая| строка")).toEqual(["quote"]);
    expect(at("> - пункт| в цитате")).toEqual(["bullets", "quote"]);
    expect(at("простой| текст")).toEqual([]);
  });
});
