import type { Replacement } from "@depesha/plugin-api";
import { keyReplacement, type ReplacementKey } from "./typography";

/** Text the table leaves alone: code keeps its characters, a link is not retyped, a locked block is not the caret's. */
const UNTYPED = "pre, code, a, [contenteditable='false']";

/**
 * The text a typed key replaces in the visual editor, or null when the key is the editor's
 * own. The caret must be collapsed in a text node of `root`, and the matched prefix must lie
 * in that node whole: a replacement never reaches across an element boundary. The prefix is
 * selected and the key stopped, so the editor's own insert command puts the replacement there.
 */
export function typedReplacement(e: ReplacementKey, root: HTMLElement, table: Replacement[]): string | null {
  if (root.getAttribute("contenteditable") === "false") return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  // The locked block is taken out of editing by its own element; closest sees it above the text node.
  if (node.parentElement?.closest(UNTYPED)) return null;
  const match = keyReplacement(e, node.textContent ?? "", range.startOffset, table);
  if (match === null) return null;
  e.preventDefault();
  range.setStart(node, match.start);
  range.setEnd(node, match.end);
  return match.insert;
}
