// Live Preview of a Markdown letter: what the editor hides and draws in place of the
// markup. Only the element under the caret shows its marks (Typora's way, frame 4 B
// of the 0.7 mockup); a code block and a table open whole. A pure function of the
// editor's state, so the tests need no browser. Covered by preview.test.ts.

import type { EditorState, Text } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { canonicalLang, highlightTokens } from "../syntax";

export interface PreviewOptions {
  /** The caret shows only while the field has focus; away from it the letter is all drawn. */
  focused: boolean;
  /** "Markup": every mark shown at once, the formatting kept. */
  markup: boolean;
}

export type Piece =
  /** Marks taken out of sight. */
  | { kind: "hide"; from: number; to: number }
  /** A list's "-" drawn as a dot. */
  | { kind: "bullet"; from: number; to: number }
  /** A task's "[ ]" drawn as a box to tick. */
  | { kind: "task"; from: number; to: number; done: boolean }
  /** A table drawn whole, its source hidden. */
  | { kind: "table"; from: number; to: number }
  /** A class on the line starting here: headings, quotes, code. */
  | { kind: "line"; at: number; class: string }
  /** A class on text the highlighting does not know: underline, a link's words. */
  | { kind: "style"; from: number; to: number; class: string }
  /** A token of a code block, coloured by the client's own scanner (syntax.ts). */
  | { kind: "token"; from: number; to: number; class: string }
  /** An image in the letter, shown in place with the markup hidden. */
  | { kind: "image"; from: number; to: number };

/** Elements whose marks show only with the caret in them. */
const INLINE = new Set(["Emphasis", "StrongEmphasis", "Strikethrough", "InlineCode", "Link", "Autolink", "Escape"]);
const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark", "LinkMark"]);

/** The parse may still be under way when the letter is long; a letter is short. */
const PARSE_MS = 50;

/** One pass over the letter: where the caret is and what is drawn so far. */
class Pass {
  readonly out: Piece[] = [];

  constructor(
    readonly doc: Text,
    private readonly state: EditorState,
    readonly opts: PreviewOptions,
  ) {}

  /** The caret or the selection is at this range, its ends included. */
  touches(from: number, to: number): boolean {
    return this.opts.focused && this.state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  }

  hide(from: number, to: number) {
    if (to > from) this.out.push({ kind: "hide", from, to });
  }

  lines(from: number, to: number, cls: string) {
    for (let n = this.doc.lineAt(from).number, last = this.doc.lineAt(to).number; n <= last; n++) {
      this.out.push({ kind: "line", at: this.doc.line(n).from, class: cls });
    }
  }

  /** A block mark with the space after it, shown with the caret at it. */
  blockMark(from: number, to: number) {
    const end = this.doc.sliceString(to, to + 1) === " " ? to + 1 : to;
    if (!this.touches(from, end)) this.hide(from, end);
  }
}

export function previewPieces(state: EditorState, opts: PreviewOptions): Piece[] {
  const pass = new Pass(state.doc, state, opts);
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_MS) ?? syntaxTree(state);
  tree.iterate({
    enter(ref) {
      const node = ref.node;
      if (block(pass, node) === false) return false;
      if (node.name === "HTMLTag") underline(pass, node);
      if (node.name === "Link") linkWords(pass, node);
      if (!opts.markup) mark(pass, node);
    },
  });
  return pass.out.sort((a, b) => ("at" in a ? a.at : a.from) - ("at" in b ? b.at : b.from));
}

/** The lines of a block; false for a block drawn whole, whose insides are not looked into. */
function block(pass: Pass, node: SyntaxNode): boolean | void {
  const { name, from, to } = node;
  const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
  if (heading) pass.lines(from, heading[1] === "ATX" ? from : to, `md-h${heading[2]}`);
  else if (name === "Blockquote") pass.lines(from, to, "md-quote");
  else if (name === "FencedCode" || name === "CodeBlock") {
    pass.lines(from, to, "md-code");
    if (!pass.opts.markup && name === "FencedCode") codeFences(pass, node);
    tokens(pass, node);
    return false;
  } else if (name === "Table") {
    // A table is always drawn, its cells edited in place (frame 1 of the 0.7 mockup);
    // the "markup" mode is the one place its bare source shows.
    if (!pass.opts.markup) pass.out.push({ kind: "table", from, to });
    else pass.lines(from, to, "md-table");
    return false;
  } else if (name === "HTMLBlock") return false;
  else if (name === "Image") {
    // An image is shown whole; under the caret its markup stands instead (frame 10 B).
    if (pass.opts.markup || pass.touches(from, to)) return false;
    if (node.getChild("URL")) pass.out.push({ kind: "image", from, to });
    return false;
  }
}

/** The marks of headings, quotes, lists, tasks and rules; inline elements. */
function mark(pass: Pass, node: SyntaxNode) {
  const { name, from, to } = node;
  if (name === "HeaderMark" && node.parent?.name.startsWith("ATX")) {
    if (from === node.parent.from) pass.blockMark(pass.doc.lineAt(from).from, to);
    else if (!pass.touches(from, to)) pass.hide(from - (pass.doc.sliceString(from - 1, from) === " " ? 1 : 0), to); // closing #'s
  } else if (name === "QuoteMark") pass.blockMark(from, to);
  else if (name === "ListMark") {
    if (node.parent?.parent?.name === "BulletList" && !pass.touches(from, to + 1)) pass.out.push({ kind: "bullet", from, to });
  } else if (name === "TaskMarker") {
    if (!pass.touches(from, to)) pass.out.push({ kind: "task", from, to, done: /x/i.test(pass.doc.sliceString(from, to)) });
  } else if (name === "HorizontalRule") {
    if (!pass.touches(from, to)) {
      pass.hide(from, to);
      pass.lines(from, from, "md-hr");
    }
  } else if (INLINE.has(name)) inline(pass, node);
}

/** The words of a link look like one, its marks shown or not. */
function linkWords(pass: Pass, node: SyntaxNode) {
  const marks = node.getChildren("LinkMark");
  if (marks.length >= 2) pass.out.push({ kind: "style", from: marks[0].to, to: marks[1].from, class: "md-link" });
}

/** The marks of an inline element, out of sight unless the caret is in it. */
function inline(pass: Pass, node: SyntaxNode) {
  const links = node.name === "Link" ? node.getChildren("LinkMark") : [];
  if (pass.touches(node.from, node.to)) return;
  if (node.name === "Escape") return pass.hide(node.from, node.from + 1);
  if (links.length >= 2) {
    // "[" and everything from "]" on: the address, its title, the brackets.
    pass.hide(links[0].from, links[0].to);
    pass.hide(links[1].from, node.to);
    return;
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (INLINE_MARKS.has(child.name)) pass.hide(child.from, child.to);
  }
}

/** The fences of a code block hidden, unless the caret is anywhere in the block. */
function codeFences(pass: Pass, node: SyntaxNode) {
  const first = pass.doc.lineAt(node.from);
  const last = pass.doc.lineAt(node.to);
  if (pass.touches(first.from, last.to)) return;
  pass.hide(node.from, first.to);
  const close = node.lastChild;
  if (last.number > first.number && close?.name === "CodeMark" && close.from >= last.from) pass.hide(last.from, last.to);
}

/** The runs of a code block's lines, coloured by the client's own scanner. Nothing is
 *  touched in the "markup" mode: there the letter is shown as typed. */
function tokens(pass: Pass, node: SyntaxNode) {
  const first = pass.doc.lineAt(node.from);
  const lang = /^```+\s*(\S*)/.exec(pass.doc.sliceString(first.from, first.to))?.[1] ?? "";
  if (!canonicalLang(lang)) return;
  const last = pass.doc.lineAt(node.to).number;
  const start = node.name === "FencedCode" ? first.number + 1 : first.number;
  for (let n = start; n <= last; n++) {
    const line = pass.doc.line(n);
    if (line.text.startsWith("```")) continue;
    const text = line.text;
    for (const s of highlightTokens(text, lang)) {
      pass.out.push({ kind: "token", from: line.from + s.from, to: line.from + s.to, class: `hl-${s.cls}` });
    }
  }
}

/** `<u>…</u>`, the underline the formatting row types: the tags go, the words are underlined. */
function underline(pass: Pass, open: SyntaxNode) {
  const tag = (n: SyntaxNode) => pass.doc.sliceString(n.from, n.to).toLowerCase();
  if (tag(open) !== "<u>") return;
  let close = open.nextSibling;
  while (close && !(close.name === "HTMLTag" && tag(close) === "</u>")) close = close.nextSibling;
  if (!close) return;
  pass.out.push({ kind: "style", from: open.to, to: close.from, class: "md-u" });
  if (!pass.opts.markup && !pass.touches(open.from, close.to)) {
    pass.hide(open.from, open.to);
    pass.hide(close.from, close.to);
  }
}
