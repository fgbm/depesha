// The table of a Markdown letter drawn as the recipient sees it, edited in its cells
// (frames 1–5 of the 0.7 mockup): the cells are editable in place, grips over the columns
// and beside the rows open a menu and drag, "+" grows the table; a wide table scrolls
// sideways. Loaded with the editor's own chunk (markdownEditor.ts); the pure model, which
// the tests cover without a browser, is table.ts.
//
// Editing in the cells cannot go through the document on every keystroke — that would rebuild
// the widget under the caret — so the drawn cells hold the text while they have focus and the
// table is written back to the document when the focus leaves it or a grip is used. Undo takes
// such a write as one step.

import { EditorView, WidgetType } from "@codemirror/view";
import { t } from "../i18n.svelte";
import type { Table } from "./table";
import { deleteColumn, deleteRow, insertColumn, insertRow, moveColumn, moveRow, parseTable, setAlign, tableSource } from "./table";

/** The menu a grip opens, floating over the window. */
function openMenu(anchor: HTMLElement, items: MenuItem[]) {
  document.querySelectorAll(".md-table-menu").forEach((m) => m.remove());
  const box = document.createElement("div");
  box.className = "md-table-menu";
  const rect = anchor.getBoundingClientRect();
  box.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
  box.style.top = `${rect.bottom + 2}px`;
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mi";
    if (it.checked) b.classList.add("on");
    if (it.disabled) b.disabled = true;
    b.textContent = (it.checked ? "✓ " : "") + it.label;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      it.run();
    });
    box.append(b);
  }
  document.body.append(box);
  const away = (e: MouseEvent) => {
    if (!box.contains(e.target as Node)) close();
  };
  const close = () => {
    box.remove();
    document.removeEventListener("mousedown", away, true);
    window.removeEventListener("blur", close);
  };
  setTimeout(() => document.addEventListener("mousedown", away, true));
  window.addEventListener("blur", close);
}

interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
  checked?: boolean;
}

/** The cell a place of the DOM holds: its row (-1 the header) and column, or null. */
function cellOf(node: Element | null): { row: number; col: number } | null {
  const cell = node?.closest?.("[data-cell]") as HTMLElement | null;
  const spec = cell?.dataset.cell;
  if (!spec) return null;
  const [row, col] = spec.split(":").map(Number);
  return { row, col };
}

/** Where the caret goes once a structural change has rebuilt the table. The widget is made
 *  anew from the changed source, so the place cannot travel on the instance; it waits here. */
let pendingFocus: { row: number; col: number } | null = null;

export class TableView extends WidgetType {
  private readonly parsed: Table;

  constructor(
    readonly from: number,
    readonly source: string,
    readonly readonly: boolean = false,
  ) {
    super();
    this.parsed = parseTable(source) ?? { head: [""], aligns: ["left"], rows: [[""]] };
  }

  eq(other: TableView) {
    return other.source === this.source && other.readonly === this.readonly;
  }

  toDOM(view: EditorView) {
    const root = document.createElement("div");
    root.className = "md-table-view";
    root.spellcheck = false;

    const scroller = document.createElement("div");
    scroller.className = "md-table-scroll";
    const inner = document.createElement("div");
    inner.className = "md-table-in";
    const table = document.createElement("table");
    table.className = "md-table";

    const headRow = document.createElement("tr");
    headRow.append(corner());
    this.parsed.head.forEach((_, c) => headRow.append(this.grip(view, root, "col", c)));
    table.append(headRow);
    table.append(this.row(view, root, -1));
    this.parsed.rows.forEach((_, r) => table.append(this.row(view, root, r)));
    inner.append(table);
    inner.append(this.add(view, root, "col"));
    inner.append(this.add(view, root, "row"));
    scroller.append(inner);
    root.append(scroller);

    if (!this.readonly) {
      // A click on a table cell puts the caret in it: the editor's own caret stays out of
      // the widget, so the keys reach the cell.
      root.addEventListener("mousedown", (e) => {
        if ((e.target as Element).closest(".md-table-grip")) e.stopPropagation();
      });
    }

    if (pendingFocus) {
      const { row, col } = pendingFocus;
      pendingFocus = null;
      requestAnimationFrame(() => this.focusCell(root, view, row, col));
    }

    // A click outside while a cell has focus loses nothing: the write happens on blur.
    root.addEventListener("focusout", () => {
      // Wait a tick: the focus may move to another cell or to a grip of this same table.
      setTimeout(() => {
        if (!root.contains(document.activeElement)) this.commit(view, root);
      }, 0);
    });
    return root;
  }

  /** Every event on the table is the table's own: the editor's caret never enters the widget. */
  ignoreEvent() {
    return true;
  }

  private grip(view: EditorView, root: HTMLElement, kind: "col" | "row", index: number): HTMLTableCellElement {
    const td = document.createElement("td");
    td.className = `md-table-grip md-table-grip-${kind}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-table-grip-btn";
    btn.textContent = kind === "col" ? "⋯" : "⋮";
    btn.tabIndex = -1;
    btn.title = kind === "col" ? t("markdown.table.colGrip") : t("markdown.table.rowGrip");
    td.append(btn);
    if (!this.readonly) {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.startDrag(view, root, e, kind, index, btn);
      });
    }
    return td;
  }

  private row(view: EditorView, root: HTMLElement, r: number): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.dataset.row = String(r);
    tr.append(this.grip(view, root, "row", r));
    const cells = r < 0 ? this.parsed.head : this.parsed.rows[r];
    cells.forEach((value, c) => {
      const td = document.createElement(r < 0 ? "th" : "td");
      td.className = "md-table-cell";
      td.style.textAlign = this.parsed.aligns[c];
      const span = document.createElement("div");
      span.className = "md-table-cell-text";
      span.dataset.cell = `${r}:${c}`;
      span.textContent = value;
      if (!this.readonly) {
        span.contentEditable = "plaintext-only";
        span.tabIndex = 0;
        span.addEventListener("keydown", (e) => this.cellKey(view, root, e, r, c));
      }
      td.append(span);
      tr.append(td);
    });
    return tr;
  }

  private add(view: EditorView, root: HTMLElement, kind: "col" | "row"): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `md-table-add md-table-add-${kind}`;
    btn.textContent = "+";
    btn.tabIndex = -1;
    btn.title = kind === "col" ? t("markdown.table.addColumn") : t("markdown.table.addRow");
    if (this.readonly) {
      btn.disabled = true;
      return btn;
    }
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const t0 = this.sync(root);
      if (kind === "col") {
        const next = insertColumn(t0, t0.head.length - 1, "after");
        this.write(view, root, next, { row: -1, col: next.head.length - 1 });
      } else {
        const next = insertRow(t0, t0.rows.length - 1, "below");
        this.write(view, root, next, { row: next.rows.length - 1, col: 0 });
      }
    });
    return btn;
  }

  /** The table read off the drawn cells, so nothing typed without a blur is lost. */
  private sync(root: HTMLElement): Table {
    const next: Table = { head: [...this.parsed.head], aligns: [...this.parsed.aligns], rows: this.parsed.rows.map((r) => [...r]) };
    root.querySelectorAll<HTMLElement>("[data-cell]").forEach((span) => {
      const spec = span.dataset.cell;
      if (!spec) return;
      const [row, col] = spec.split(":").map(Number);
      const value = (span.textContent ?? "").replace(/\s*\n\s*/g, " ");
      if (row < 0) next.head[col] = value;
      else next.rows[row][col] = value;
    });
    return next;
  }

  /** Writes the table back into the document, one step for Ctrl+Z, and says where the caret goes. */
  private write(view: EditorView, root: HTMLElement, next: Table, restore: { row: number; col: number } | null = null) {
    const { from, to } = this.range(view, root);
    pendingFocus = restore;
    view.dispatch({
      changes: { from, to, insert: tableSource(next).replace(/\n$/, "") },
      userEvent: "input.table",
      scrollIntoView: true,
    });
  }

  private commit(view: EditorView, root: HTMLElement) {
    const next = this.sync(root);
    if (this.same(this.parsed, next)) return;
    const focused = cellOf(document.activeElement);
    this.write(view, root, next, focused);
  }

  private same(a: Table, b: Table): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /** The table's own lines in the document, found by the widget's place. */
  private range(view: EditorView, root: HTMLElement): { from: number; to: number } {
    const pos = view.posAtDOM(root);
    const first = view.state.doc.lineAt(pos).number;
    let last = first;
    while (last < view.state.doc.lines && view.state.doc.line(last + 1).text.trim().startsWith("|")) last++;
    return { from: view.state.doc.line(first).from, to: view.state.doc.line(last).to };
  }

  private focusCell(root: HTMLElement, _view: EditorView, row: number, col: number) {
    const cell = root.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`);
    if (!cell) return;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private cellKey(view: EditorView, root: HTMLElement, e: KeyboardEvent, r: number, c: number) {
    const cols = this.parsed.head.length;
    const rows = this.parsed.rows.length;
    const step = (row: number, col: number) => this.focusCell(root, view, row, col);
    if (e.key === "Tab") {
      // Shift+Tab and Tab step through the cells; the last cell grows a row.
      e.preventDefault();
      const forward = !e.shiftKey;
      if (forward && r === rows - 1 && c === cols - 1) {
        const next = insertRow(this.sync(root), rows - 1, "below");
        return this.write(view, root, next, { row: next.rows.length - 1, col: 0 });
      }
      const at = (r + 1) * cols + c + (forward ? 1 : -1);
      if (at < 0 || at >= (rows + 1) * cols) return;
      step(Math.floor(at / cols) - 1, at % cols);
    } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Enter goes to the cell below, growing the table at its last row.
      e.preventDefault();
      if (r >= rows - 1) {
        const next = insertRow(this.sync(root), rows - 1, "below");
        return this.write(view, root, next, { row: next.rows.length - 1, col: c });
      }
      step(r + 1, c);
    } else if (e.key === "ArrowDown" && r < rows - 1) {
      e.preventDefault();
      step(r + 1, c);
    } else if (e.key === "ArrowUp" && r > -1) {
      e.preventDefault();
      step(r - 1, c);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const next = this.sync(root);
      const { to } = this.range(view, root);
      if (!this.same(this.parsed, next)) {
        this.write(view, root, next);
        requestAnimationFrame(() => view.dispatch({ selection: { anchor: to }, scrollIntoView: true }));
      } else {
        view.dispatch({ selection: { anchor: to }, scrollIntoView: true });
      }
      view.focus();
    }
  }

  private startDrag(view: EditorView, root: HTMLElement, down: MouseEvent, kind: "col" | "row", index: number, button: HTMLElement) {
    const movable = !(kind === "row" && index < 0);
    const startX = down.clientX;
    const startY = down.clientY;
    let moving = false;
    let target = index;
    let line: HTMLDivElement | null = null;
    const inner = root.querySelector(".md-table-in") as HTMLElement;

    const drop = (e: MouseEvent) => {
      if (!moving && Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
      if (!moving) {
        if (!movable) return;
        moving = true;
        line = document.createElement("div");
        line.className = "md-table-drop";
        inner.append(line);
        root.classList.add("dragging");
      }
      const rect = inner.getBoundingClientRect();
      if (kind === "col") {
        const ths = [...root.querySelectorAll<HTMLElement>("tr:first-child th")];
        let k = ths.findIndex((th) => e.clientX < mid(th).left);
        if (k < 0) k = ths.length;
        target = k;
        const ref = ths[Math.min(k, ths.length - 1)].getBoundingClientRect();
        const x = k < ths.length ? ref.left : ref.right;
        Object.assign(line!.style, { left: `${x - rect.left - 1.5}px`, top: "0", bottom: "0", width: "3px", height: "auto" });
      } else {
        const trs = [...root.querySelectorAll<HTMLElement>("tr[data-row]")];
        let k = trs.findIndex((tr) => e.clientY < mid(tr).top);
        if (k < 0) k = trs.length;
        target = k;
        const ref = trs[Math.min(k, trs.length - 1)].getBoundingClientRect();
        const y = k < trs.length ? ref.top : ref.bottom;
        Object.assign(line!.style, { left: "0", right: "0", top: `${y - rect.top - 1.5}px`, height: "3px", width: "auto" });
      }
    };
    const up = () => {
      document.removeEventListener("mousemove", drop);
      document.removeEventListener("mouseup", up);
      root.classList.remove("dragging");
      line?.remove();
      if (!moving) {
        this.gripMenu(view, root, button, kind, index);
        return;
      }
      if (target === index || target === index + 1) return;
      const to = target > index ? target - 1 : target;
      const t0 = this.sync(root);
      const next = kind === "col" ? moveColumn(t0, index, to) : moveRow(t0, index, to);
      this.write(view, root, next, kind === "col" ? { row: -1, col: to } : { row: to, col: 0 });
    };
    document.addEventListener("mousemove", drop);
    document.addEventListener("mouseup", up);
  }

  private gripMenu(view: EditorView, root: HTMLElement, button: HTMLElement, kind: "col" | "row", index: number) {
    const items: MenuItem[] = [];
    if (kind === "col") {
      const align = this.parsed.aligns[index];
      items.push(
        { label: t("markdown.table.insertLeft"), run: () => this.change(view, root, (x) => insertColumn(x, index, "before"), -1, index) },
        { label: t("markdown.table.insertRight"), run: () => this.change(view, root, (x) => insertColumn(x, index, "after"), -1, index + 1) },
        { label: t("markdown.table.alignLeft"), checked: align === "left", run: () => this.change(view, root, (x) => setAlign(x, index, "left")) },
        { label: t("markdown.table.alignCenter"), checked: align === "center", run: () => this.change(view, root, (x) => setAlign(x, index, "center")) },
        { label: t("markdown.table.alignRight"), checked: align === "right", run: () => this.change(view, root, (x) => setAlign(x, index, "right")) },
        { label: t("markdown.table.deleteColumn"), disabled: this.parsed.head.length <= 1, run: () => this.change(view, root, (x) => deleteColumn(x, index)) },
      );
    } else if (index < 0) {
      items.push({ label: t("markdown.table.insertBelow"), run: () => this.change(view, root, (x) => insertRow(x, 0, "above"), 0, 0) });
    } else {
      items.push(
        { label: t("markdown.table.insertAbove"), run: () => this.change(view, root, (x) => insertRow(x, index, "above"), index, 0) },
        { label: t("markdown.table.insertBelow"), run: () => this.change(view, root, (x) => insertRow(x, index, "below"), index + 1, 0) },
        { label: t("markdown.table.deleteRow"), disabled: this.parsed.rows.length <= 1, run: () => this.change(view, root, (x) => deleteRow(x, index)) },
      );
    }
    items.push({ label: t("markdown.table.deleteTable"), run: () => this.removeTable(view, root) });
    openMenu(button, items);
  }

  private change(view: EditorView, root: HTMLElement, change: (t: Table) => Table, row?: number, col?: number) {
    const next = change(this.sync(root));
    this.write(view, root, next, row !== undefined && col !== undefined ? { row, col } : null);
  }

  private removeTable(view: EditorView, root: HTMLElement) {
    const { from, to } = this.range(view, root);
    const line = view.state.doc.lineAt(to);
    const end = line.to < view.state.doc.length ? line.to + 1 : line.to;
    view.dispatch({ changes: { from, to: end, insert: "" }, userEvent: "delete.table" });
    view.focus();
  }
}

function corner(): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "md-table-corner";
  return td;
}

function mid(el: Element): { left: number; top: number } {
  const r = el.getBoundingClientRect();
  return { left: r.left + r.width / 2, top: r.top + r.height / 2 };
}
