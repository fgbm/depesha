// The table of a Markdown letter, edited in its cells (frame 1 of the 0.7 mockup): the
// source is read into cells, the cells are changed, and the text is written back with the
// columns padded. A pure model, so the tests need no browser; the editor (markdownEditor.ts)
// finds the table under the caret and replaces its lines. Covered by table.test.ts.

/** A column's alignment, as the separator's colons say it. */
export type Align = "left" | "center" | "right";

export interface Table {
  /** The header row; a Markdown table always has one and it cannot be dropped. */
  head: string[];
  aligns: Align[];
  rows: string[][];
}

/** The narrowest a column's dashes go: `---`. */
const MIN_WIDTH = 3;

/** The cells of a row: split at the bars not escaped, the outer ones dropped. */
function cellsOf(row: string): string[] {
  const body = row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** The alignment a separator cell writes: `:---` left, `:---:` center, `---:` right. */
export function alignOf(cell: string): Align {
  const s = cell.trim();
  if (s.startsWith(":") && s.endsWith(":")) return "center";
  if (s.endsWith(":")) return "right";
  return "left";
}

/** A separator cell of a given width: the dashes padded to it, its colons at the ends. */
function separator(align: Align, width: number): string {
  const n = Math.max(MIN_WIDTH, width);
  if (align === "center") return `:${"-".repeat(n - 2)}:`;
  if (align === "right") return `${"-".repeat(n - 1)}:`;
  return "-".repeat(n);
}

/** The bar a separator row has to be told from a text row: dashes, colons and spaces. */
const SEPARATOR = /^\|[\s:|-]+\|$/;

/**
 * The table a run of lines holds, or null when they are not one: a header row, a separator
 * row naming the alignment, then the rows. The lines are read as a letter's Markdown is.
 */
export function parseTable(lines: string): Table | null {
  const rows = lines.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  if (rows.length < 2 || !rows.every((l) => l.trim().startsWith("|")) || !SEPARATOR.test(rows[1].trim())) return null;
  const head = cellsOf(rows[0]);
  const sep = cellsOf(rows[1]);
  const width = Math.max(head.length, sep.length);
  const aligns: Align[] = [];
  for (let c = 0; c < width; c++) aligns.push(alignOf(sep[c] ?? "---"));
  const body = rows.slice(2).map(cellsOf);
  return { head: pad(head, width), aligns, rows: body.map((r) => pad(r, width)) };
}

/** A row brought to the table's width: short rows gain empty cells, long ones lose the tail. */
function pad(row: string[], width: number): string[] {
  const out = row.slice(0, width);
  while (out.length < width) out.push("");
  return out;
}

/** A fresh table of the mockup's shape: three columns, a header and one row. */
export function emptyTable(): Table {
  return { head: ["", "", ""], aligns: ["left", "left", "left"], rows: [["", "", ""]] };
}

/** The widths of the columns: their longest cell, never below `---`. */
function widths(t: Table): number[] {
  return t.head.map((_, c) => Math.max(MIN_WIDTH, t.head[c].length, ...t.rows.map((r) => r[c].length)));
}

/** The cell as it is written: padded to the column, its bars escaped, its alignment kept. */
function cell(value: string, align: Align, width: number): string {
  const s = value.replace(/\|/g, "\\|");
  const gap = Math.max(0, width - s.length);
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") return " ".repeat(gap >> 1) + s + " ".repeat(gap - (gap >> 1));
  return s + " ".repeat(gap);
}

/** The table's text, in the editor's own layout: cells padded, columns aligned, a newline
 *  at the end so it stands as its own block. */
export function tableSource(t: Table): string {
  const w = widths(t);
  const line = (row: string[]) => `|${row.map((v, c) => ` ${cell(v, t.aligns[c], w[c])} `).join("|")}|`;
  const sep = `|${t.aligns.map((a, c) => ` ${separator(a, w[c])} `).join("|")}|`;
  return [line(t.head), sep, ...t.rows.map(line)].join("\n") + "\n";
}

/** A copy with rows and aligns kept apart from the one given. */
function copy(t: Table): Table {
  return { head: [...t.head], aligns: [...t.aligns], rows: t.rows.map((r) => [...r]) };
}

/** A column added before or after column `at`; every row gains an empty cell. */
export function insertColumn(t: Table, at: number, where: "before" | "after"): Table {
  const next = copy(t);
  const i = where === "before" ? at : at + 1;
  next.head.splice(i, 0, "");
  next.aligns.splice(i, 0, "left");
  for (const r of next.rows) r.splice(i, 0, "");
  return next;
}

/** A row added above or below row `at` (0 is the first row under the header). */
export function insertRow(t: Table, at: number, where: "above" | "below"): Table {
  const next = copy(t);
  next.rows.splice(where === "above" ? at : at + 1, 0, t.head.map(() => ""));
  return next;
}

/** A column taken out; the last one stays, a table cannot have none. */
export function deleteColumn(t: Table, at: number): Table {
  if (t.head.length <= 1) return copy(t);
  const next = copy(t);
  next.head.splice(at, 1);
  next.aligns.splice(at, 1);
  for (const r of next.rows) r.splice(at, 1);
  return next;
}

/** A row taken out; the last one stays. */
export function deleteRow(t: Table, at: number): Table {
  if (t.rows.length <= 1) return copy(t);
  const next = copy(t);
  next.rows.splice(at, 1);
  return next;
}

/** A row moved to another place; the header never moves, so `at` and `to` are body rows. */
export function moveRow(t: Table, at: number, to: number): Table {
  const next = copy(t);
  const [row] = next.rows.splice(at, 1);
  next.rows.splice(to, 0, row);
  return next;
}

/** A column moved to another place, its alignment going with it. */
export function moveColumn(t: Table, at: number, to: number): Table {
  const next = copy(t);
  const [h] = next.head.splice(at, 1);
  next.head.splice(to, 0, h);
  const [a] = next.aligns.splice(at, 1);
  next.aligns.splice(to, 0, a);
  for (const r of next.rows) {
    const [v] = r.splice(at, 1);
    r.splice(to, 0, v);
  }
  return next;
}

/** The alignment of a column. */
export function setAlign(t: Table, at: number, align: Align): Table {
  const next = copy(t);
  next.aligns[at] = align;
  return next;
}

/** The cell Tab (forward) or Shift+Tab (back) moves to, or null at the end; the header is
 *  row -1 and comes first. */
export function moveCell(t: Table, row: number, col: number, back: boolean): { row: number; col: number } | null {
  const cols = t.head.length;
  const rows = t.rows.length + 1;
  const at = (row + 1) * cols + col + (back ? -1 : 1);
  if (at < 0 || at >= rows * cols) return null;
  return { row: Math.floor(at / cols) - 1, col: at % cols };
}

/** Where a cell's text starts in the table's own source: for the caret and replacements.
 *  Row -1 is the header; the separator row is not a cell row. */
export function cellOffset(t: Table, row: number, col: number): number {
  const lines = tableSource(t).split("\n");
  const line = row < 0 ? 0 : row + 2;
  let at = 0;
  for (let i = 0; i < line; i++) at += lines[i].length + 1;
  let p = at + 1; // past the leading bar
  for (let c = 0; c < col; c++) p = lines[line].indexOf("|", p) + 1;
  return p + 1; // past the space the cell opens with
}
