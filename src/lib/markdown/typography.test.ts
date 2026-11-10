// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { Replacement } from "@depesha/plugin-api";
import { TABLE } from "../../../plugins/typography/table";
import type { ReplacementKey } from "../compose/typography";
import { markdownSupport } from "./dialect";
import { createEditor, type EditorOptions } from "./markdownEditor";
import { typographySpec } from "./typography";

const EM_DASH = "\u2014";
const ELLIPSIS = "\u2026";
const CARET = "\u2038";

/** A letter with the caret where `‸` stands. */
function stateOf(marked: string): EditorState {
  const at = marked.indexOf(CARET);
  return EditorState.create({ doc: marked.replace(CARET, ""), selection: EditorSelection.single(at), extensions: [history(), markdownSupport()] });
}

function selected(doc: string, from: number, to: number): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: [history(), markdownSupport()] });
}

/** A key as the browser gives it, its default left to be prevented. */
function key(k: string, mods: Partial<ReplacementKey> = {}): ReplacementKey {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, preventDefault: vi.fn(), ...mods };
}

/** The state after `k`: the table's replacement where it has one, the browser's own character otherwise. */
function press(state: EditorState, k: string, table: Replacement[] = TABLE, mods: Partial<ReplacementKey> = {}): EditorState {
  const spec = typographySpec(state, key(k, mods), table);
  if (spec !== null) return state.update(spec).state;
  const at = state.selection.main.head;
  return state.update({ changes: { from: at, insert: k }, selection: { anchor: at + 1 }, userEvent: "input.type" }).state;
}

const typed = (marked: string, k: string, table: Replacement[] = TABLE): string => press(stateOf(marked), k, table).doc.toString();

describe("typing a Markdown letter", () => {
  it("turns the second hyphen into an em dash and the third dot into an ellipsis, the caret right after", () => {
    const dash = press(stateOf(`а-${CARET}`), "-");
    expect(dash.doc.toString()).toBe(`а${EM_DASH}`);
    expect(dash.selection.main.from).toBe(2);
    expect(dash.selection.main.to).toBe(2);

    const dots = press(stateOf(`а..${CARET}`), ".");
    expect(dots.doc.toString()).toBe(`а${ELLIPSIS}`);
    expect(dots.selection.main.from).toBe(2);
    expect(dots.selection.main.to).toBe(2);
  });

  it("replaces the prefix in one transaction, as a typed character", () => {
    const spec = typographySpec(stateOf(`а-${CARET}`), key("-"), TABLE)!;
    expect(spec.changes).toEqual({ from: 1, to: 2, insert: EM_DASH });
    expect(spec.selection).toEqual(EditorSelection.single(2));
    expect(spec.userEvent).toBe("input.type");
    expect(spec.scrollIntoView).toBe(true);
    expect((spec.annotations as unknown as { value: string }).value).toBe("before");
  });

  it("answers no key while the table is empty, the key is modified, or the key is of a composition", () => {
    expect(typographySpec(stateOf(`а-${CARET}`), key("-"), [])).toBeNull();
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(typographySpec(stateOf(`а-${CARET}`), key("-", mods), TABLE)).toBeNull();
    }
  });

  it("leaves a range of selected text alone", () => {
    expect(typographySpec(selected("а-", 0, 2), key("-"), TABLE)).toBeNull();
  });

  it("keeps the characters of code as typed", () => {
    expect(typed(`\`а-${CARET}\``, "-")).toBe("`а--`");
    expect(typed(`\`\`\`\nа-${CARET}\n\`\`\``, "-")).toBe("```\nа--\n```");
    expect(typed(`    а-${CARET}`, "-")).toBe("    а--");
    // The same key in prose is the table's.
    expect(typed(`просто а-${CARET}`, "-")).toBe(`просто а${EM_DASH}`);
  });
});

describe("the lines and the history of a Markdown letter", () => {
  it("leaves a rule and a heading's underline to Markdown", () => {
    expect(typed(`-${CARET}`, "-")).toBe("--");
    expect(typed(`Заголовок\n-${CARET}`, "-")).toBe("Заголовок\n--");
    expect(typed(`Заголовок\n  -${CARET}`, "-")).toBe("Заголовок\n  --");
    // Prose keeps its dash, however many hyphens stand before it.
    expect(typed(`Текст а-${CARET}`, "-")).toBe(`Текст а${EM_DASH}`);
  });

  it("turns four hyphens into two dashes, one pair at a time", () => {
    let state = stateOf(`а${CARET}`);
    for (let i = 0; i < 4; i++) state = press(state, "-");
    expect(state.doc.toString()).toBe(`а${EM_DASH}${EM_DASH}`);
  });

  it("undoes the replacement back to the character typed and redoes it", () => {
    let state = press(stateOf(`а${CARET}`), "-");
    state = press(state, "-");
    expect(state.doc.toString()).toBe(`а${EM_DASH}`);

    let undone: EditorState | null = null;
    undo({ state, dispatch: (tr: Transaction) => (undone = tr.state) });
    expect(undone!.doc.toString()).toBe("а-");

    let redone: EditorState | null = null;
    redo({ state: undone!, dispatch: (tr: Transaction) => (redone = tr.state) });
    expect(redone!.doc.toString()).toBe(`а${EM_DASH}`);
  });

  it("takes an entry longer than the text before it: the window is the table's own", () => {
    expect(typed(`а----${CARET}`, "-", [{ from: "-----", to: EM_DASH }])).toBe(`а${EM_DASH}`);
    const mixed: Replacement[] = [
      { from: "-----", to: EM_DASH },
      { from: "--", to: ELLIPSIS },
    ];
    expect(typed(`а-${CARET}`, "-", mixed)).toBe(`а${ELLIPSIS}`);
  });

  it("keeps the table of the plugins as it was given", () => {
    press(stateOf(`а-${CARET}`), "-");
    expect(TABLE).toEqual([
      { from: "--", to: EM_DASH },
      { from: "...", to: ELLIPSIS },
    ]);
  });
});

// jsdom has no layout of text ranges, which the editor reads while it draws.
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

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

const open: { destroy(): void }[] = [];
afterEach(() => {
  for (const e of open.splice(0)) e.destroy();
  document.body.replaceChildren();
});

/** An editor over `value` with the table its keys read. */
function editorOf(value: string, table: () => Replacement[]) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ ...OPTIONS, parent, value, replacements: table });
  open.push(editor);
  const view = EditorView.findFromDOM(parent.querySelector(".cm-editor") as HTMLElement) as EditorView;
  return { editor, view };
}

/** A key pressed in the editor, as the browser sends it. */
function pressKey(view: EditorView, k: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(e);
  return e;
}

describe("the keys of a Markdown letter", () => {
  it("takes the table through the editor's own focus", () => {
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { view } = editorOf("а-", () => TABLE);
    view.focus();
    view.dispatch({ selection: { anchor: 2 } });
    expect(view.hasFocus).toBe(true);

    const e = pressKey(view, "-");
    expect(e.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(`а${EM_DASH}`);
    expect(view.state.selection.main.head).toBe(2);
    focused.mockRestore();
  });

  it("changes nothing without the focus: a cell's own field keeps its key", () => {
    const blurred = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { view } = editorOf("а-", () => TABLE);
    view.dispatch({ selection: { anchor: 2 } });

    const e = pressKey(view, "-");
    expect(e.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe("а-");
    blurred.mockRestore();
  });

  it("reads the table on every key, so a plugin switched on mid-letter starts at once", () => {
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    let table: Replacement[] = [];
    const { view } = editorOf("а-", () => table);
    view.focus();
    view.dispatch({ selection: { anchor: 2 } });

    expect(pressKey(view, "-").defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe("а-");

    table = TABLE;
    expect(pressKey(view, "-").defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(`а${EM_DASH}`);
    focused.mockRestore();
  });
});
