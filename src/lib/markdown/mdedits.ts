// The formatting of a Markdown letter that only the editor knows how to place: a heading,
// a code block, a table and a picture. They return an edit of the text (mdedit.ts's `Edit`),
// which the field applies as typing, one step for Ctrl+Z. They live here, in the editor's
// own chunk, so the main chunk does not carry them (the formatting row reaches them through
// the field's own methods, `MarkdownField::heading/code/table/picture`). Covered by
// mdedits.test.ts.

import type { Edit } from "../mdedit";

/** The line range of the selection: the lines' start and end, without the newline after. */
function lineRange(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const stop = text.indexOf("\n", Math.max(start, end - (end > start && text[end - 1] === "\n" ? 1 : 0)));
  return [from, stop < 0 ? text.length : stop];
}

/**
 * A heading of `level` (1–3) on the line under the caret; the same level again takes it
 * back to plain text. The `#`s replace the ones already there, so the level only changes.
 */
export function headingEdit(text: string, start: number, end: number, level: number): Edit {
  const [from, to] = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const marks = lines.map((l) => /^(#{1,6}) /.exec(l)?.[1].length ?? 0);
  const off = marks.every((m) => m === level);
  const insert = lines
    .map((l, i) => {
      const bare = l.replace(/^#{1,6} /, "");
      if (off) return bare;
      // Only the first line carries the marks; the rest are the heading's text.
      return (i === 0 ? "#".repeat(level) + " " : "") + bare;
    })
    .join("\n");
  return { from, to, insert, select: [from, from + insert.length] };
}

/**
 * A code block around the selection or the caret's line. A selection inside one line becomes
 * inline code (`` `x` ``); a selection over several lines, or a caret on a line, becomes a
 * fenced block (``` ``` x ``` ```). The same again takes either off.
 */
export function codeEdit(text: string, start: number, end: number): Edit {
  const [from, to] = lineRange(text, start, end);
  const block = text.slice(from, to);
  const around = fencedAround(text, from, to);
  if (around) {
    // Already a fenced block (around the caret or the selection): the fences go.
    const lines = around.text.split("\n");
    const inner = lines.slice(1, -1).join("\n");
    return { from: around.from, to: around.to, insert: inner, select: [around.from, around.from + inner.length] };
  }
  if (start !== end && !text.slice(start, end).includes("\n")) {
    // A selection inside a line: inline code, off again when the backticks are already there.
    const inner = text.slice(start, end);
    if (text.slice(start - 1, start) === "`" && text.slice(end, end + 1) === "`") {
      return { from: start - 1, to: end + 1, insert: inner, select: [start - 1, end - 1] };
    }
    return { from: start, to: end, insert: "`" + inner + "`", select: [start + 1, end + 1] };
  }
  if (!block.trim()) {
    // A line of its own: an empty fenced block, the caret inside it.
    return { from, to, insert: "```\n\n```", select: [from + 4, from + 4] };
  }
  const insert = `\`\`\`\n${block}\n\`\`\``;
  return { from, to, insert, select: [from + 4, from + 4 + block.length] };
}

/** A fenced code block that holds these lines, with the fences; null when there is none. */
function fencedAround(text: string, from: number, to: number): { from: number; to: number; text: string } | null {
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (!/^```/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^```/.test(lines[j])) continue;
      const start = starts[i];
      const stop = starts[j] + lines[j].length;
      if (from >= start && to <= stop) return { from: start, to: stop, text: lines.slice(i, j + 1).join("\n") };
      i = j;
      break;
    }
  }
  return null;
}

/**
 * A table `columns` wide and two rows tall (a header and one row), where the caret is. On an
 * empty line the table takes its place; inside text it goes on a new line below. The header
 * cells stand empty and are drawn as placeholders (frame 3 of the 0.7 mockup).
 */
export function tableEdit(text: string, start: number, end: number, columns = 3): Edit {
  const wide = (cell: string) => "|" + Array.from({ length: columns }, () => cell).join("|") + "|";
  const header = wide("     ");
  const sep = wide(" --- ");
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", start);
  const to = lineEnd < 0 ? text.length : lineEnd;
  const own = !text.slice(from, to).trim();
  const insert = own ? `${header}\n${sep}\n${header}\n` : `\n${header}\n${sep}\n${header}`;
  // The caret goes into the first header cell.
  const caret = (own ? 0 : 1) + 2;
  return { from: own ? from : start, to: own ? to : end, insert, select: [from + caret, from + caret] };
}

/**
 * A picture in the letter: `![описание](адрес)` on a line of its own, the caret after the
 * markup so typing continues below it. The description is the alt (frame 9 of the mockup).
 */
export function pictureEdit(text: string, start: number, end: number, url: string, alt = ""): Edit {
  const line = text.lastIndexOf("\n", start - 1) + 1;
  const before = text.slice(line, start);
  const lead = before.trim() ? "\n" : "";
  const insert = `${lead}![${alt}](${url})\n`;
  const from = before.trim() ? start : line;
  const at = from + insert.length;
  return { from, to: before.trim() ? end : line, insert, select: [at, at] };
}
