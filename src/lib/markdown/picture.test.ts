// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { deleteCharBackward, deleteCharForward, undo } from "@codemirror/commands";
import { createEditor, type EditorOptions } from "./markdownEditor";

/** A picture the letter carries in its text, as a paste puts it there. */
const PIC = "![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)";
const LETTER = `Добрый день!\n${PIC}\nДальше текст.`;

const OPTIONS: Omit<EditorOptions, "parent" | "value"> = {
  label: "",
  placeholder: "",
  readonly: false,
  markup: false,
  onchange: () => {},
  onselection: () => {},
  onfocus: () => {},
  onpictures: () => {},
};

// jsdom has no layout of text ranges, which the editor reads while it draws.
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

const open: { destroy(): void }[] = [];
afterEach(() => {
  for (const e of open.splice(0)) e.destroy();
  document.body.replaceChildren();
});

/** An editor over `value`, the view behind it and the last text it gave back. */
function editorOf(value: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  let text = value;
  const editor = createEditor({ ...OPTIONS, parent, value, onchange: (v) => (text = v) });
  open.push(editor);
  const view = EditorView.findFromDOM(parent.querySelector(".cm-editor") as HTMLElement) as EditorView;
  return { editor, view, text: () => text };
}

const caret = (view: EditorView, at: number) => view.dispatch({ selection: { anchor: at } });

describe("a picture in the text of a Markdown letter", () => {
  const start = LETTER.indexOf(PIC);
  const end = start + PIC.length;

  it("goes whole on Backspace after it, no base64 left in the text", () => {
    const { view, text } = editorOf(LETTER);
    caret(view, end);
    deleteCharBackward(view);
    expect(text()).toBe("Добрый день!\n\nДальше текст.");
    expect(view.contentDOM.textContent).not.toContain("base64");
  });

  it("goes whole on Delete before it", () => {
    const { view, text } = editorOf(LETTER);
    caret(view, start);
    deleteCharForward(view);
    expect(text()).toBe("Добрый день!\n\nДальше текст.");
  });

  it("goes whole with a selection over it", () => {
    const { view, text } = editorOf(LETTER);
    view.dispatch({ selection: { anchor: start - 3, head: end + 3 } });
    deleteCharBackward(view);
    expect(text()).toBe("Добрый денльше текст.");
  });

  it("comes back on Ctrl+Z", () => {
    const { view, text } = editorOf(LETTER);
    caret(view, end);
    deleteCharBackward(view);
    undo(view);
    expect(text()).toBe(LETTER);
    expect(view.contentDOM.querySelector(".md-picture img, .md-picture-data")).not.toBeNull();
  });

  it("opens again from a saved draft without its base64 in sight, and is saved whole", () => {
    // The draft as it comes back from the server: the picture in its text.
    const { editor, view, text } = editorOf(LETTER);
    expect(view.contentDOM.textContent).not.toContain("base64");
    expect(view.contentDOM.querySelector(".md-picture img")?.getAttribute("src")).toBe(PIC.slice(4, -1));
    // The caret beside it and the markup mode open its markup: still no base64.
    caret(view, end);
    expect(view.contentDOM.textContent).not.toContain("base64");
    editor.setMarkup(true);
    expect(view.contentDOM.textContent).not.toContain("base64");
    expect(view.contentDOM.textContent).toContain("![](");
    // What is typed is saved with the picture in it, for the backend to send.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
    expect(text()).toBe(LETTER + "!");
  });
});
