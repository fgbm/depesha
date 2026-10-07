// The Markdown editor of a letter: CodeMirror 6 with Live Preview (preview.ts). Loaded
// with import() when a Markdown letter opens, so the main chunk does not carry it
// (lazy.test.ts, scripts/frontend-bundle.sh). MarkdownEditor.svelte wraps it.

import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { markdownKeymap } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { composeAction } from "../composeKeys";
import { markdownSupport } from "./dialect";
import { editSpec, formatsAt } from "./field";
import { previewPieces, type PreviewOptions } from "./preview";
import type { MarkdownField } from "./types";

export interface EditorOptions {
  parent: HTMLElement;
  value: string;
  label: string;
  placeholder: string;
  readonly: boolean;
  markup: boolean;
  onchange: (value: string) => void;
  onselection: () => void;
  onfocus: () => void;
  /** Pictures pasted: the window decides where they go. */
  onpictures: (pictures: Blob[]) => void;
}

export interface MarkdownEditorHandle {
  field: MarkdownField;
  setValue(value: string): void;
  setReadonly(on: boolean): void;
  setMarkup(on: boolean): void;
  setPlaceholder(text: string): void;
  destroy(): void;
}

const setFocused = StateEffect.define<boolean>();
const setMarkup = StateEffect.define<boolean>();

/** Whether the caret shows its element and whether all the markup is out. */
const mode = StateField.define<PreviewOptions>({
  create: () => ({ focused: false, markup: false }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFocused)) value = { ...value, focused: e.value };
      if (e.is(setMarkup)) value = { ...value, markup: e.value };
    }
    return value;
  },
});

class Bullet extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "md-bullet";
    dot.textContent = "•";
    return dot;
  }
}

/** A task's box: a click ticks it in the text, as an edit that Ctrl+Z undoes. */
class TaskBox extends WidgetType {
  constructor(readonly done: boolean) {
    super();
  }
  eq(other: TaskBox) {
    return other.done === this.done;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "md-task";
    box.checked = this.done;
    box.tabIndex = -1;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const at = view.posAtDOM(box);
      view.dispatch({ changes: { from: at + 1, to: at + 2, insert: this.done ? " " : "x" }, userEvent: "input.task" });
      view.focus();
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** A table drawn as the recipient sees it; a click opens its source. */
class TableView extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableView) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    const table = document.createElement("table");
    table.className = "md-table-view";
    const rows = this.source.split("\n").filter((_, i) => i !== 1);
    rows.forEach((row, i) => {
      const tr = table.insertRow();
      for (const cell of cellsOf(row)) {
        const td = document.createElement(i === 0 ? "th" : "td");
        td.textContent = cell;
        tr.append(td);
      }
    });
    table.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(table) } });
      view.focus();
    });
    return table;
  }
  ignoreEvent() {
    return true;
  }
}

/** The cells of a table's row: split at the bars not escaped, the outer ones dropped. */
function cellsOf(row: string): string[] {
  const cells = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/);
  return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
}

const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Bullet() });

function decorate(state: EditorState): DecorationSet {
  const ranges = previewPieces(state, state.field(mode)).map((p) => {
    switch (p.kind) {
      case "hide":
        return hidden.range(p.from, p.to);
      case "bullet":
        return bullet.range(p.from, p.to);
      case "task":
        return Decoration.replace({ widget: new TaskBox(p.done) }).range(p.from, p.to);
      case "table":
        return Decoration.replace({ widget: new TableView(state.sliceDoc(p.from, p.to)), block: true }).range(p.from, p.to);
      case "line":
        return Decoration.line({ class: p.class }).range(p.at);
      case "style":
        return Decoration.mark({ class: p.class }).range(p.from, p.to);
    }
  });
  return Decoration.set(ranges, true);
}

/** In a field, not a view plugin: a table replaces whole lines, which only a field may. */
const livePreview = StateField.define<DecorationSet>({
  create: decorate,
  update(deco, tr) {
    const moved = tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocused) || e.is(setMarkup));
    return moved || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? decorate(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Up and down step over a drawn table, which is one block to the editor: the caret goes
 * into its first or last line instead, and the table opens as source.
 */
function intoTable(down: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const { main } = state.selection;
    const line = state.doc.lineAt(main.head);
    const n = line.number + (down ? 1 : -1);
    if (!main.empty || n < 1 || n > state.doc.lines) return false;
    const next = state.doc.line(n);
    let target = -1;
    state.field(livePreview).between(next.from, next.to, (from, to, deco) => {
      if (deco.spec.widget instanceof TableView) target = down ? from : to;
    });
    if (target < 0) return false;
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
    return true;
  };
}

/** The colours and sizes of the app's theme (src/app.css) and of the 0.7 mockup. */
const highlight = HighlightStyle.define([
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.heading, fontWeight: "bold" },
  { tag: tags.monospace, fontFamily: "var(--mono)", fontSize: "0.9em" },
  { tag: [tags.processingInstruction, tags.url, tags.labelName, tags.contentSeparator], color: "var(--muted)" },
]);

const theme = EditorView.theme({
  "&": { flex: "1", minHeight: "0", background: "var(--paper)", color: "var(--ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.55" },
  ".cm-content": { padding: "14px 18px", caretColor: "var(--ink)", userSelect: "text" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted)" },
  ".md-h1": { fontSize: "22px", lineHeight: "1.3" },
  ".md-h2": { fontSize: "17px", lineHeight: "1.35" },
  ".md-h3": { fontSize: "15px" },
  ".md-quote": { borderLeft: "3px solid var(--line)", paddingLeft: "12px", color: "var(--muted)" },
  ".md-code, .md-table": { fontFamily: "var(--mono)", fontSize: "12.5px", background: "var(--paper-2)" },
  ".md-code": { padding: "0 12px" },
  ".md-hr": { borderBottom: "1px solid var(--line)", height: "0.8em" },
  ".md-link": { color: "var(--link)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".md-u": { textDecoration: "underline" },
  ".md-bullet": { color: "var(--muted)" },
  ".md-task": { margin: "0 2px", verticalAlign: "-2px", cursor: "pointer" },
  ".md-table-view": { borderCollapse: "collapse", margin: "2px 0", cursor: "text" },
  ".md-table-view th, .md-table-view td": { border: "1px solid var(--line)", padding: "3px 10px", textAlign: "left" },
  ".md-table-view th": { background: "var(--paper-2)" },
});

/** Pictures on the clipboard, as files. */
function pictures(data: DataTransfer | null): Blob[] {
  return [...(data?.items ?? [])].filter((i) => i.kind === "file" && i.type.startsWith("image/")).flatMap((i) => i.getAsFile() ?? []);
}

/** The events the editor gives to the window: its keys, pasted pictures, dropped files. */
function windowEvents(o: EditorOptions): Extension {
  return EditorView.domEventHandlers({
    // The window's own keys (send, fold, bold, link…) are not the editor's: they go up to it.
    keydown: (e) => composeAction(e) !== null,
    paste: (e) => {
      const found = pictures(e.clipboardData);
      if (!found.length) return false;
      e.preventDefault();
      o.onpictures(found);
      return true;
    },
    // Files dropped go to the window as files, never into the text as their contents.
    drop: (e) => {
      if (!e.dataTransfer?.files.length) return false;
      e.preventDefault();
      return true;
    },
    focus: () => o.onfocus(),
  });
}

/** The editor as the text field the window and the formatting row know. */
function fieldOf(view: EditorView): MarkdownField {
  return {
    get value() {
      return view.state.doc.toString();
    },
    get selectionStart() {
      return view.state.selection.main.from;
    },
    get selectionEnd() {
      return view.state.selection.main.to;
    },
    get scrollTop() {
      return view.scrollDOM.scrollTop;
    },
    set scrollTop(v: number) {
      view.scrollDOM.scrollTop = v;
    },
    focus: () => view.focus(),
    setSelectionRange(from, to) {
      const max = view.state.doc.length;
      view.dispatch({ selection: EditorSelection.single(Math.min(from, max), Math.min(to, max)), scrollIntoView: true });
    },
    apply(edit) {
      view.dispatch(editSpec(edit));
      view.focus();
    },
    formats: () => formatsAt(view.state, view.state.selection.main.head),
  };
}

/** A text set from outside (a plugin, a template): only what differs is replaced, so the
 * caret and the history keep their place. */
function setValue(view: EditorView, value: string) {
  const now = view.state.doc.toString();
  if (value === now) return;
  let start = 0;
  while (start < now.length && start < value.length && now[start] === value[start]) start++;
  let end = 0;
  while (end < now.length - start && end < value.length - start && now[now.length - 1 - end] === value[value.length - 1 - end]) end++;
  view.dispatch({ changes: { from: start, to: now.length - end, insert: value.slice(start, value.length - end) } });
}

const readonlyOf = (on: boolean): Extension => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];

export function createEditor(o: EditorOptions): MarkdownEditorHandle {
  const editable = new Compartment();
  const hint = new Compartment();
  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.value,
      extensions: [
        mode.init(() => ({ focused: false, markup: o.markup })),
        livePreview,
        Prec.highest(windowEvents(o)),
        history(),
        markdownSupport(),
        Prec.high(keymap.of([...markdownKeymap, { key: "ArrowDown", run: intoTable(true) }, { key: "ArrowUp", run: intoTable(false) }])),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        syntaxHighlighting(highlight),
        theme,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", "aria-label": o.label, "aria-multiline": "true" }),
        EditorView.focusChangeEffect.of((_, focusing) => setFocused.of(focusing)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) o.onchange(u.state.doc.toString());
          if (u.selectionSet || u.focusChanged) o.onselection();
        }),
        editable.of(readonlyOf(o.readonly)),
        hint.of(placeholder(o.placeholder)),
      ],
    }),
  });
  return {
    field: fieldOf(view),
    setValue: (value) => setValue(view, value),
    setReadonly: (on) => view.dispatch({ effects: editable.reconfigure(readonlyOf(on)) }),
    setMarkup: (on) => {
      if (view.state.field(mode).markup !== on) view.dispatch({ effects: setMarkup.of(on) });
    },
    setPlaceholder: (text) => view.dispatch({ effects: hint.reconfigure(placeholder(text)) }),
    destroy: () => view.destroy(),
  };
}
