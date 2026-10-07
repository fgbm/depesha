// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { TableView } from "./tableWidget";

const TABLE = "| Кто | Что |\n| --- | --- |\n| Иван | зал |\n| Ольга | транспорт |";

/** A stand-in for the editor the widget draws itself into: `toDOM` touches none of it while
 *  building the table. */
const viewOf = () => ({ dom: document.createElement("div") }) as unknown as EditorView;

describe("the grips of a Markdown table", () => {
  it("stands over every column and beside every row, with its own glyph", () => {
    const dom = new TableView(0, TABLE).toDOM(viewOf());
    const cols = [...dom.querySelectorAll<HTMLElement>(".md-table-grip-col .md-table-grip-btn")];
    const rows = [...dom.querySelectorAll<HTMLElement>(".md-table-grip-row .md-table-grip-btn")];
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
