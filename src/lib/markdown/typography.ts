// The typography replacements of a Markdown letter as CodeMirror transactions: a typed
// pair of hyphens becomes a dash, three dots an ellipsis (plugins/typography). One
// transaction, so the caret and Ctrl+Z take the replacement as one typing. Covered by
// typography.test.ts.

import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { Replacement } from "@depesha/plugin-api";
import { keyReplacement, type ReplacementKey } from "../compose/typography";
import { inCodeAt } from "./field";

/** A line of hyphens alone is an hr, or the setext underline of the line above: `---` stays typeable. */
const HYPHENS = /^ {0,3}-+$/;

/**
 * The replacement a typed key makes in the letter, as one transaction, or null when the key
 * is the editor's own: another node's typing, code, a range of selected text, or the start
 * of a line of hyphens.
 */
export function typographySpec(state: EditorState, e: ReplacementKey, table: Replacement[]): TransactionSpec | null {
  if (table.length === 0) return null;
  const { main } = state.selection;
  if (!main.empty) return null;
  const caret = main.head;
  // The longest entry decides how far back the key reads.
  const longest = table.reduce((n, r) => Math.max(n, r.from.length), 0);
  const windowStart = Math.max(0, caret - Math.max(0, longest - 1));
  const match = keyReplacement(e, state.doc.sliceString(windowStart, caret), caret - windowStart, table);
  if (match === null) return null;
  // Code keeps its own text: a dash there would change what the letter shows as code. The
  // syntax tree is read only for a key the table would take.
  if (inCodeAt(state, caret)) return null;
  if (e.key === "-" && HYPHENS.test(state.doc.sliceString(state.doc.lineAt(caret).from, caret))) return null;
  const from = windowStart + match.start;
  return {
    changes: { from, to: caret, insert: match.insert },
    selection: EditorSelection.single(from + match.insert.length),
    annotations: isolateHistory.of("before"),
    userEvent: "input.type",
    scrollIntoView: true,
  };
}
