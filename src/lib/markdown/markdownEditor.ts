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
import { t } from "../i18n.svelte";
import { markdownSupport } from "./dialect";
import { editSpec, formatsAt, inTableAt } from "./field";
import { previewPieces, type PreviewOptions } from "./preview";
import { TableView } from "./tableWidget";
import { codeEdit, headingEdit, imageAt, pictureAltEdit, pictureEdit, pictureRemoveEdit, tableEdit } from "./mdedits";
import { tableSource } from "./table";
import type { Edit } from "../mdedit";
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

/** An image in a Markdown letter: shown in place (decision on #45); its markup `![alt](url)`
 *  appears on the line with the caret, drawn by the Live Preview like any other element. A
 *  click opens the picture's panel (frame 10 Б) instead of putting the caret in the line. */
class Picture extends WidgetType {
  constructor(
    readonly from: number,
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: Picture) {
    return other.from === this.from && other.url === this.url && other.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "md-picture";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    box.append(img);
    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      openPicturePanel(view, this.from);
    });
    return box;
  }
  ignoreEvent() {
    // The widget keeps its own events: a click opens the panel, it never moves the caret in.
    return true;
  }
}

/** The panel a picture opens on click: "Описание" reveals the alt field, "Удалить" takes the
 *  picture out. It floats over the window (document.body), anchored to the picture's place,
 *  so a rewritten description does not tear it down with the widget. */
let panel: { root: HTMLElement; frame: HTMLElement; view: EditorView; from: number } | null = null;

/** The drawn picture standing for the markup at `from`, or null once it is gone. */
function pictureAt(view: EditorView, from: number): HTMLElement | null {
  for (const box of view.dom.querySelectorAll<HTMLElement>(".md-picture")) {
    if (view.posAtDOM(box) === from) return box;
  }
  return null;
}

function placePicturePanel() {
  if (!panel) return;
  const box = pictureAt(panel.view, panel.from);
  if (!box) return closePicturePanel();
  const r = box.getBoundingClientRect();
  Object.assign(panel.frame.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const width = panel.root.offsetWidth || 220;
  panel.root.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  panel.root.style.top = `${r.bottom + 6}px`;
}

function closePicturePanel() {
  if (!panel) return;
  panel.root.remove();
  panel.frame.remove();
  document.removeEventListener("mousedown", outsidePicture, true);
  document.removeEventListener("keydown", escapePicture, true);
  window.removeEventListener("resize", placePicturePanel);
  panel.view.scrollDOM.removeEventListener("scroll", placePicturePanel);
  panel = null;
}

function outsidePicture(e: MouseEvent) {
  const target = e.target as Element | null;
  if (panel?.root.contains(target as Node) || target?.closest?.(".md-picture")) return;
  closePicturePanel();
}

function escapePicture(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    closePicturePanel();
  }
}

/** A plain button of the picture's bar. */
function panelAction(label: string, cls: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `md-picture-act${cls}`;
  b.textContent = label;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", run);
  return b;
}

/** The description field of the picture's panel (frame 10 Б): hidden until "Описание" is
 *  pressed, its change written back to the markup one step at a time. */
function altField(view: EditorView, from: number): { row: HTMLDivElement; commit: () => void } {
  const row = document.createElement("div");
  row.className = "md-picture-alt";
  row.hidden = true;
  const title = document.createElement("b");
  title.textContent = t("compose.picture.altTitle");
  const input = document.createElement("input");
  input.className = "input";
  input.value = imageAt(view.state.doc.toString(), from)?.alt ?? "";
  input.setAttribute("aria-label", t("compose.picture.altTitle"));
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = t("compose.picture.altHint");
  row.append(title, input, hint);

  const commit = () => {
    const doc = view.state.doc.toString();
    const edit = pictureAltEdit(doc, from, input.value);
    if (!edit || doc.slice(edit.from, edit.to) === input.value) return;
    view.dispatch(editSpec(edit));
    requestAnimationFrame(placePicturePanel);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commit();
  });
  return { row, commit };
}

/** The bar of the picture's panel: "Описание" and "Delete". */
function pictureBar(view: EditorView, from: number, row: HTMLDivElement, onClose: () => void): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "md-picture-bar";
  const toggle = panelAction(t("compose.picture.describe"), "", () => {
    row.hidden = !row.hidden;
    toggle.classList.toggle("on", !row.hidden);
    if (!row.hidden) {
      (row.querySelector("input") as HTMLInputElement | null)?.focus();
      placePicturePanel();
    }
  });
  const remove = panelAction(t("act.delete"), " danger", () => {
    const edit = pictureRemoveEdit(view.state.doc.toString(), from);
    if (!edit) return onClose();
    onClose();
    view.dispatch(editSpec(edit));
    view.focus();
  });
  bar.append(toggle, document.createElement("i"), remove);
  return bar;
}

/** Opens the picture's panel under it (frame 10 Б): description, delete. */
function openPicturePanel(view: EditorView, from: number) {
  closePicturePanel();
  const root = document.createElement("div");
  root.className = "md-picture-panel";
  root.addEventListener("mousedown", (e) => e.stopPropagation());

  const frame = document.createElement("div");
  frame.className = "md-picture-frame";
  document.body.append(frame);

  const field = altField(view, from);
  root.append(pictureBar(view, from, field.row, closePicturePanel), field.row);
  document.body.append(root);

  panel = { root, frame, view, from };
  placePicturePanel();
  setTimeout(() => document.addEventListener("mousedown", outsidePicture, true));
  document.addEventListener("keydown", escapePicture, true);
  window.addEventListener("resize", placePicturePanel);
  view.scrollDOM.addEventListener("scroll", placePicturePanel);
}

const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Bullet() });

function decorate(state: EditorState): DecorationSet {
  const opts = state.field(mode);
  const ranges = previewPieces(state, opts).map((p) => {
    switch (p.kind) {
      case "hide":
        return hidden.range(p.from, p.to);
      case "bullet":
        return bullet.range(p.from, p.to);
      case "task":
        return Decoration.replace({ widget: new TaskBox(p.done) }).range(p.from, p.to);
      case "table":
        return Decoration.replace({ widget: new TableView(p.from, state.sliceDoc(p.from, p.to), state.readOnly), block: true }).range(p.from, p.to);
      case "image":
        return Decoration.replace({ widget: picture(state, p.from, p.to), block: true }).range(p.from, p.to);      case "token":
        return Decoration.mark({ class: `md-${p.class}` }).range(p.from, p.to);
      case "line":
        return Decoration.line({ class: p.class }).range(p.at);
      case "style":
        return Decoration.mark({ class: p.class }).range(p.from, p.to);
    }
  });
  return Decoration.set(ranges, true);
}

/** The picture an `![alt](url)` refers to, read off the document. */
function picture(state: EditorState, from: number, to: number): Picture {
  const text = state.sliceDoc(from, to);
  const m = /^!\[([^\]]*)\]\((.*)\)$/.exec(text);
  return new Picture(from, m?.[2] ?? "", m?.[1] ?? "");
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

/** A row typed as `| … |` becomes a table on Enter: a separator and one empty row are added
 *  under it and the caret goes to the first cell of the empty row (frame 3 А of the 0.7 mockup). */
function typedTable(view: EditorView): boolean {
  const { state } = view;
  const { main } = state.selection;
  if (!main.empty) return false;
  const line = state.doc.lineAt(main.head);
  if (!/^\s*\|.*\|\s*$/.test(line.text) || main.head !== line.to) return false;
  const cells = line.text.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
  if (cells.length < 2) return false;
  const table = { head: cells, aligns: cells.map(() => "left" as const), rows: [cells.map(() => "")] };
  const rest = tableSource(table).split("\n").slice(1).join("\n").replace(/\n$/, "");
  // The separator and the empty row go under the header; the caret sits in its first cell.
  const at = line.to + rest.indexOf("\n") + 2 + 1; // past the newline, the bar and the space
  view.dispatch({
    changes: { from: line.to, to: line.to, insert: "\n" + rest },
    selection: { anchor: Math.min(at, line.to + rest.length) },
    scrollIntoView: true,
    userEvent: "input.table",
  });
  return true;
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
  // Code tokens: the same colours the reader's frame uses on a letter (syntax.ts, HL_CSS).
  ".md-hl-kw": { color: "#a626a4" },
  ".md-hl-str": { color: "#50a14f" },
  ".md-hl-cm": { color: "var(--muted)", fontStyle: "italic" },
  ".md-hl-num": { color: "#986801" },
  ".md-hl-tag": { color: "#e45649" },
  ".md-hl-attr": { color: "#986801" },
  ".md-hl-prop": { color: "#4078f2" },
  // An image in the letter: shown in place, no wider than the text.
  ".md-picture": { display: "block", margin: "4px 0", cursor: "pointer" },
  ".md-picture img": { maxWidth: "100%", height: "auto", borderRadius: "4px", border: "1px solid var(--line)" },
  // The table: drawn as the recipient sees it, edited in its cells.
  ".md-table-view": { margin: "2px 0" },
  ".md-table-scroll": { overflowX: "auto", overflowY: "hidden", paddingBottom: "2px" },
  ".md-table-in": { position: "relative", display: "inline-block", minWidth: "100%" },
  ".md-table": { borderCollapse: "collapse", width: "max-content", maxWidth: "none" },
  ".md-table th, .md-table td": { border: "1px solid var(--line)", padding: "0", verticalAlign: "top" },
  ".md-table th": { background: "var(--paper-2)" },
  ".md-table-cell-text": { minWidth: "40px", padding: "3px 10px", outline: "none", cursor: "text" },
  ".md-table-cell-text:focus": { boxShadow: "inset 0 0 0 2px var(--link)" },
  ".md-table-corner, .md-table-grip": { border: "none", padding: "0", background: "none", width: "18px" },
  ".md-table-grip-btn": { width: "18px", padding: "0", border: "none", background: "none", color: "var(--muted)", cursor: "pointer", lineHeight: "1", font: "inherit" },
  ".md-table-grip-btn:hover": { color: "var(--ink)" },
  ".md-table-add": { position: "absolute", border: "1px dashed var(--line)", background: "none", color: "var(--muted)", cursor: "pointer", padding: "0", lineHeight: "1" },
  ".md-table-add-col": { top: "0", right: "-22px", width: "18px", height: "100%" },
  ".md-table-add-row": { left: "0", bottom: "-22px", width: "100%", height: "18px" },
  ".md-table-drop": { position: "absolute", background: "var(--accent)", pointerEvents: "none", zIndex: "3" },
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
    heading: (level) => applyOf(view, (t, s, e) => headingEdit(t, s, e, level)),
    code: () => applyOf(view, codeEdit),
    table: () => applyOf(view, (t, s, e) => tableEdit(t, s, e, 3)),
    picture: (url, alt) => applyOf(view, (t, s, e) => pictureEdit(t, s, e, url, alt)),
    inTable: () => inTableAt(view.state, view.state.selection.main.head),
  };
}

/** An edit of the Markdown, one step for Ctrl+Z, with the caret it leaves. */
function applyOf(view: EditorView, make: (text: string, start: number, end: number) => Edit) {
  const { from, to } = view.state.selection.main;
  view.dispatch(editSpec(make(view.state.doc.toString(), from, to)));
  view.focus();
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
        Prec.high(keymap.of([...markdownKeymap, { key: "ArrowDown", run: intoTable(true) }, { key: "ArrowUp", run: intoTable(false) }, { key: "Enter", run: typedTable }])),
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
    destroy: () => {
      closePicturePanel();
      view.destroy();
    },
  };
}
