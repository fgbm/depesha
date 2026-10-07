// The formatting row on the Markdown editor: the edits of mdedit.ts as CodeMirror
// transactions, and the buttons pressed by the syntax under the caret. Covered by
// field.test.ts.

import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { Edit } from "../mdedit";
import type { FormatId } from "./types";

/** An edit as one step of the editor's history, with the selection it leaves. */
export function editSpec(edit: Edit): TransactionSpec {
  return {
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.single(edit.select[0], edit.select[1]),
    annotations: isolateHistory.of("full"),
    userEvent: "input.format",
    scrollIntoView: true,
  };
}

const BY_NODE: Record<string, FormatId> = {
  StrongEmphasis: "bold",
  Emphasis: "italic",
  Link: "link",
  BulletList: "bullets",
  OrderedList: "numbers",
  Blockquote: "quote",
};

/** The syntax under a place of the letter, walked up from the innermost node. */
function under(state: EditorState, pos: number): SyntaxNode {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  return tree.resolveInner(pos, -1);
}

/** The formatting at a place of the letter, as the buttons show it. */
export function formatsAt(state: EditorState, pos: number): Set<FormatId> {
  const on = new Set<FormatId>();
  for (let node: SyntaxNode | null = under(state, pos); node; node = node.parent) {
    const id = BY_NODE[node.name];
    if (id) on.add(id);
  }
  // `<u>` is a tag of its own, not an element around the text: an open one before the caret.
  const line = state.doc.lineAt(pos);
  const before = state.doc.sliceString(line.from, pos).toLowerCase();
  if (before.lastIndexOf("<u>") > before.lastIndexOf("</u>") && state.doc.sliceString(pos, line.to).toLowerCase().includes("</u>")) on.add("underline");
  return on;
}

/**
 * Whether the caret stands in a table's cell (frame 1, note 2 of the 0.7 mockup): there the
 * formatting row's buttons that a cell cannot hold (lists, a quote, a picture, a heading) are
 * off, while bold, italic, code and a link stay on.
 */
export function inTableAt(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = under(state, pos); node; node = node.parent) {
    if (node.name === "Table") return true;
  }
  return false;
}
