// The formatting buttons of a Markdown letter: they type the markup around the selection.
// Each returns an edit of the text; the field applies it as typing, so Ctrl+Z undoes it.
// Covered by mdedit.test.ts.

import { markdownUrl } from "./richtext";

export interface Edit {
  /** The part of the text replaced… */
  from: number;
  to: number;
  /** …by this. */
  insert: string;
  /** The selection after the edit, in the new text. */
  select: [number, number];
}

/** `**word**`: the markers around the selection, or the caret between them when nothing is selected. */
export function wrapEdit(text: string, start: number, end: number, open: string, close = open): Edit {
  const inner = text.slice(start, end);
  // Already marked: the markers go.
  if (text.slice(start - open.length, start) === open && text.slice(end, end + close.length) === close) {
    return { from: start - open.length, to: end + close.length, insert: inner, select: [start - open.length, end - open.length] };
  }
  return { from: start, to: end, insert: open + inner + close, select: [start + open.length, end + open.length] };
}

export type LineKind = "bullets" | "numbers" | "quote";

const PREFIX: Record<LineKind, RegExp> = {
  bullets: /^[-*+] /,
  numbers: /^\d+[.)] /,
  quote: /^> ?/,
};

function lineRange(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const stop = text.indexOf("\n", Math.max(start, end - (end > start && text[end - 1] === "\n" ? 1 : 0)));
  return [from, stop < 0 ? text.length : stop];
}

/** A list or a quote on the lines of the selection; off again when they all have it. */
export function linesEdit(text: string, start: number, end: number, kind: LineKind): Edit {
  const [from, to] = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const on = lines.every((l) => PREFIX[kind].test(l) || !l.trim());
  const insert = lines
    .map((l, i) => {
      if (on) return l.replace(PREFIX[kind], "");
      if (!l.trim() && lines.length > 1) return l;
      const bare = l.replace(PREFIX.bullets, "").replace(PREFIX.numbers, "");
      return (kind === "bullets" ? "- " : kind === "numbers" ? `${i + 1}. ` : "> ") + (kind === "quote" ? l : bare);
    })
    .join("\n");
  return { from, to, insert, select: [from, from + insert.length] };
}

/** `[text](address)`; with nothing selected the address is the text. */
export function linkEdit(text: string, start: number, end: number, url: string): Edit {
  // A bracket in the text would close the link's text early.
  const shown = (text.slice(start, end) || url.replace(/^mailto:/i, "")).replace(/[[\]]/g, "\\$&");
  const insert = `[${shown}](${markdownUrl(url)})`;
  return { from: start, to: end, insert, select: [start + insert.length, start + insert.length] };
}

/** The markup of the selected lines goes: emphasis, links (their text stays), lists, quotes. */
export function clearEdit(text: string, start: number, end: number): Edit {
  const [from, to] = start === end ? lineRange(text, start, end) : [start, end];
  const insert = text
    .slice(from, to)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?u>/g, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\s][^*_]*?)[*_](?=[^*\w]|$)/g, "$1$2")
    .split("\n")
    .map((l) => l.replace(PREFIX.bullets, "").replace(PREFIX.numbers, "").replace(PREFIX.quote, ""))
    .join("\n");
  return { from, to, insert, select: [from, from + insert.length] };
}
