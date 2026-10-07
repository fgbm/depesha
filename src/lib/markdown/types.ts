// What the window and the formatting row see of the Markdown editor. No code: the
// editor itself comes in its own chunk (markdownEditor.ts), these are only its shape.

import type { Edit } from "../mdedit";

/** The formatting row's buttons pressed by the caret's place. */
export type FormatId = "bold" | "italic" | "underline" | "bullets" | "numbers" | "quote" | "link";

/** The Markdown field: a text field to the window, as the plain one it replaces. */
export interface MarkdownField {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  setSelectionRange(from: number, to: number): void;
  /** The scroll of the letter, as a textarea's. */
  scrollTop: number;
  /** An edit of the formatting row, undone in one step. */
  apply(edit: Edit): void;
  /** The formatting under the caret. */
  formats(): Set<FormatId>;
}
