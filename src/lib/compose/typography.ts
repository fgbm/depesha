import type { Replacement } from "@depesha/plugin-api";

/** The range of a field a key replaces, and what goes in its place. */
export interface ReplacementMatch {
  start: number;
  end: number;
  insert: string;
}

/** The key of a replacement, as a keyboard event carries it. */
export interface ReplacementKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  /** The IME's own key code, on an event that has no `isComposing`. */
  keyCode?: number;
  preventDefault(): void;
}

/**
 * The entry a key completes at the caret: the typed character is the last one of an entry
 * and the characters before the caret are the rest of it. Longest entry wins, so a table
 * of `..` and `...` takes the third dot for the ellipsis.
 */
export function matchReplacement(text: string, caret: number, typed: string, table: Replacement[]): ReplacementMatch | null {
  if (typed.length !== 1 || caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  let best: Replacement | null = null;
  for (const entry of table) {
    if (!entry.from.endsWith(typed) || !before.endsWith(entry.from.slice(0, -1))) continue;
    if (best === null || entry.from.length > best.from.length) best = entry;
  }
  if (best === null) return null;
  return { start: caret - best.from.length + 1, end: caret, insert: best.to };
}

/**
 * Puts the replacement in place of the prefix a key would complete, and answers whether it
 * did. Only a collapsed caret, an unmodified key outside a composition, and a table entry
 * the key completes count: everything else is the field's own typing.
 */
export function replaceOnKey(e: ReplacementKey, field: HTMLTextAreaElement, table: Replacement[]): boolean {
  if (table.length === 0 || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (field.selectionStart !== field.selectionEnd) return false;
  const match = matchReplacement(field.value, field.selectionStart, e.key, table);
  if (match === null) return false;
  e.preventDefault();
  field.setSelectionRange(match.start, match.end);
  if (typesIn(field, match.insert)) return true;
  field.setRangeText(match.insert, match.start, match.end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/** The editor's own insert command where the build has one: the replacement is then undone as one typing. */
function typesIn(field: HTMLTextAreaElement, text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  try {
    return document.execCommand("insertText", false, text);
  } catch {
    // Deprecated and gone in some engines: the field's own insertion does the same, so the error is not worth showing.
    return false;
  }
}
