import { describe, expect, it } from "vitest";
import {
  alignMark,
  alignOf,
  cellOffset,
  deleteColumn,
  deleteRow,
  emptyTable,
  insertColumn,
  insertRow,
  moveCell,
  moveColumn,
  moveRow,
  parseTable,
  setAlign,
  tableSource,
  type Align,
} from "./table";

const TABLE = "| Кто | Что |\n| --- | --- |\n| Иван | зал |\n| Ольга | транспорт |\n";

describe("the table of a Markdown letter", () => {
  it("reads the header, the separator's alignment and the rows", () => {
    const t = parseTable(TABLE);
    expect(t).not.toBeNull();
    expect(t!.head).toEqual(["Кто", "Что"]);
    expect(t!.aligns).toEqual<Align[]>(["left", "left"]);
    expect(t!.rows).toEqual([
      ["Иван", "зал"],
      ["Ольга", "транспорт"],
    ]);
  });

  it("keeps the escaped bars inside a cell", () => {
    const t = parseTable("| a\\|b | c |\n| --- | --- |\n| x | y |\n");
    expect(t!.head).toEqual(["a|b", "c"]);
    expect(tableSource(t!)).toContain("a\\|b");
  });

  it("reads the colons of a separator as alignment", () => {
    expect(alignOf(":---")).toBe("left");
    expect(alignOf(":---:")).toBe("center");
    expect(alignOf("---:")).toBe("right");
    expect(alignOf("---")).toBe("left");
    expect(alignMark("left")).toBe("---");
    expect(alignMark("center")).toBe(":---:");
    expect(alignMark("right")).toBe("---:");
  });

  it("writes the table back, columns padded and alignment kept", () => {
    const t = parseTable("| a | bb |\n| :-: | ---: |\n| ccc | d |\n")!;
    expect(tableSource(t)).toBe("|  a  |  bb |\n| :-: | --: |\n| ccc |   d |\n");
  });

  it("gives the same text back for a table it just wrote", () => {
    const t = parseTable(TABLE)!;
    expect(parseTable(tableSource(t))).toEqual(t);
  });

  it("is null for lines that are not a table", () => {
    expect(parseTable("просто текст")).toBeNull();
    expect(parseTable("| a | b |")).toBeNull();
  });

  it("makes an empty 3 × 2 table", () => {
    const t = emptyTable();
    expect(t.head).toEqual(["", "", ""]);
    expect(t.rows).toEqual([["", "", ""]]);
    expect(tableSource(t)).toBe("|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n");
  });
});

describe("editing the table of a Markdown letter", () => {
  const t = () => parseTable(TABLE)!;

  it("inserts a column before and after the one it is named by", () => {
    const before = insertColumn(t(), 1, "before");
    expect(before.head).toEqual(["Кто", "", "Что"]);
    expect(before.rows[0]).toEqual(["Иван", "", "зал"]);
    const after = insertColumn(t(), 1, "after");
    expect(after.head).toEqual(["Кто", "Что", ""]);
    expect(after.rows[1]).toEqual(["Ольга", "транспорт", ""]);
  });

  it("inserts a row above and below", () => {
    const above = insertRow(t(), 0, "above");
    expect(above.rows).toEqual([["", ""], ["Иван", "зал"], ["Ольга", "транспорт"]]);
    const below = insertRow(t(), 1, "below");
    expect(below.rows).toEqual([["Иван", "зал"], ["Ольга", "транспорт"], ["", ""]]);
  });

  it("deletes a column and a row", () => {
    expect(deleteColumn(t(), 0).head).toEqual(["Что"]);
    expect(deleteColumn(t(), 0).rows).toEqual([["зал"], ["транспорт"]]);
    expect(deleteRow(t(), 0).rows).toEqual([["Ольга", "транспорт"]]);
  });

  it("keeps the last column and row: a table needs them", () => {
    const one = deleteColumn(t(), 0);
    expect(one.head).toEqual(["Что"]);
    expect(deleteColumn(one, 0).head).toEqual(["Что"]);
    const noRows = deleteRow(t(), 0);
    expect(deleteRow(noRows, 0).rows.length).toBe(1);
  });

  it("moves a row and a column", () => {
    expect(moveRow(t(), 0, 1).rows).toEqual([["Ольга", "транспорт"], ["Иван", "зал"]]);
    expect(moveColumn(t(), 0, 1).head).toEqual(["Что", "Кто"]);
    expect(moveColumn(t(), 1, 0).rows[0]).toEqual(["зал", "Иван"]);
  });

  it("sets the alignment of a column", () => {
    const a = setAlign(t(), 1, "center");
    expect(a.aligns).toEqual<Align[]>(["left", "center"]);
    expect(tableSource(a).split("\n")[1]).toBe("| ----- | :-------: |");
  });
});

describe("the cells of a table", () => {
  it("moves to the next and previous cell, wrapping between rows and columns", () => {
    const t = parseTable(TABLE)!;
    expect(moveCell(t, 0, 0, false)).toEqual({ row: 0, col: 1 });
    expect(moveCell(t, 0, 1, false)).toEqual({ row: 1, col: 0 });
    expect(moveCell(t, 1, 0, true)).toEqual({ row: 0, col: 1 });
    expect(moveCell(t, 1, 1, false)).toBeNull();
  });

  it("finds the offset of a cell in the written table", () => {
    const t = parseTable(TABLE)!;
    const source = tableSource(t);
    const at = cellOffset(t, 1, 0);
    expect(source.slice(at, at + "Ольга".length)).toBe("Ольга");
    expect(cellOffset(t, -1, 1)).toBeLessThan(cellOffset(t, 0, 0));
  });
});
