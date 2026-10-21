// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { TableView } from "./tableWidget";
import { createEditor, type EditorOptions } from "./markdownEditor";

const TABLE = "| Кто | Что |\n| --- | --- |\n| Иван | зал |\n| Ольга | транспорт |";

/** A stand-in for the editor the widget draws itself into: `toDOM` touches none of it while
 *  building the table. */
const viewOf = () => ({ dom: document.createElement("div") }) as unknown as EditorView;

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

describe("the grips of a Markdown table", () => {
  it("stands over every column and beside every row, with its own glyph", () => {
    const dom = new TableView(0, TABLE).toDOM(viewOf());
    const cols = [...dom.querySelectorAll<HTMLElement>(".md-table-grip-btn.md-table-grip-col")];
    const rows = [...dom.querySelectorAll<HTMLElement>(".md-table-grip-btn.md-table-grip-row")];
    // Two columns of the table, three rows: the header and its two rows.
    expect(cols.map((b) => b.textContent)).toEqual(["⋯", "⋯"]);
    expect(rows.map((b) => b.textContent)).toEqual(["⋮", "⋮", "⋮"]);
    // The grips carry where they lead, for the menu and the drag.
    expect(cols.map((b) => b.dataset.grip)).toEqual(["col:0", "col:1"]);
    expect(rows.map((b) => b.dataset.grip)).toEqual(["row:-1", "row:0", "row:1"]);
  });

  it("has both + handles, one to grow the columns and one the rows", () => {
    const dom = new TableView(0, TABLE).toDOM(viewOf());
    expect(dom.querySelector(".md-table-add-col")?.textContent).toBe("+");
    expect(dom.querySelector(".md-table-add-row")?.textContent).toBe("+");
  });

  it("keeps every grip quiet until the table is used: the reveal is the stylesheet's", () => {
    // The widget itself marks nothing as current before a cell is focused; the CSS shows the
    // grips on `:hover`/`has-cur` (frames 1–2 of the mockup).
    const dom = new TableView(0, TABLE).toDOM(viewOf());
    expect(dom.classList.contains("has-cur")).toBe(false);
    expect(dom.querySelectorAll(".md-table-grip-btn.cur")).toHaveLength(0);
  });
});

describe("the controls of a Markdown table in the layout", () => {
  it("adds no row and no column of their own to the drawn table", () => {
    // The grips stand over the cells' edges: the table has the letter's rows and columns only,
    // so its width is the letter's and no empty service row stands over the header.
    const dom = new TableView(0, TABLE).toDOM(viewOf());
    const rows = [...dom.querySelectorAll<HTMLTableRowElement>(".md-table tr")];
    expect(rows.map((tr) => tr.dataset.row)).toEqual(["-1", "0", "1"]);
    expect(rows.map((tr) => tr.children.length)).toEqual([2, 2, 2]);
    expect([...dom.querySelectorAll(".md-table th, .md-table td")].every((c) => c.classList.contains("md-table-cell"))).toBe(true);
  });

  it("lays every control over the table's box, never past its edge", () => {
    // A narrow table must not scroll: the inner box hugs the table, and no control stands
    // outside it, where it would widen what the scroller holds. jsdom lays nothing out, so
    // the editor's own stylesheet is what is read.
    const parent = document.createElement("div");
    const editor = createEditor({ ...OPTIONS, parent, value: TABLE });
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    const rule = (sel: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(",").some((s) => s.trim().endsWith(sel))).map((m) => m[2]);
    expect(rule(".md-table-in").join(";")).not.toMatch(/min-width:\s*100%/);
    for (const sel of [".md-table-grip-btn", ".md-table-add"]) expect(rule(sel).join(";")).toMatch(/position:\s*absolute/);
    for (const sel of [".md-table-grip-col", ".md-table-grip-row", ".md-table-add-col", ".md-table-add-row"]) {
      expect(rule(sel).join(";"), sel).not.toMatch(/(top|right|bottom|left):\s*-/);
    }
    editor.destroy();
  });
});

describe("a Markdown table written back from the editor", () => {
  it("keeps only the letter's rows and columns in the Markdown it writes", () => {
    // jsdom has no layout of text ranges, which the editor reads while it draws.
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    vi.useFakeTimers();
    const parent = document.createElement("div");
    document.body.append(parent);
    let value = "";
    const editor = createEditor({ ...OPTIONS, parent, value: `Текст\n\n${TABLE}\n`, onchange: (v) => (value = v) });
    const cell = parent.querySelector<HTMLElement>('[data-cell="0:1"]')!;
    cell.textContent = "сцена";
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    vi.runAllTimers();
    vi.useRealTimers();
    const lines = value.split("\n").filter((l) => l.startsWith("|"));
    // The header, the separator, the two rows: each with the two columns of the letter.
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.split("|").length === 4)).toBe(true);
    expect(lines.some((l) => /^\|(\s*\|)+$/.test(l))).toBe(false);
    expect(lines[2]).toContain("сцена");
    editor.destroy();
    parent.remove();
  });
});

describe("a cell of a Markdown table", () => {
  it("holds its column open to the longest word, breaking no word in half", () => {
    // A cell's text keeps its column as wide as the content (decision on #45, frame 4А of the
    // 0.7 mockup): a long word holds the column open and a wide table scrolls sideways instead
    // of the words breaking. jsdom lays nothing out, so the cell's own styles are what is read.
    const dom = new TableView(0, TABLE).toDOM(viewOf());
    const cell = dom.querySelector<HTMLElement>('[data-cell="0:1"]')!;
    expect(cell.style.minWidth).toBe("max-content");
    expect(cell.style.wordBreak).not.toBe("break-all");
    expect(cell.style.overflowWrap).not.toBe("anywhere");
  });
});
