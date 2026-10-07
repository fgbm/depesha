// The Markdown of a letter as the backend reads it (pulldown-cmark with tables,
// strikethrough and tasks; message.rs, render_markdown): CommonMark and those three,
// without the subscript, superscript, emoji and bare-address links of GitHub's flavour.
// Covered by dialect.test.ts against the backend's own examples.

import { Language, LanguageSupport } from "@codemirror/language";
import { commonmarkLanguage } from "@codemirror/lang-markdown";
import { Strikethrough, Table, TaskList, type DelimiterType, type MarkdownConfig, type MarkdownParser } from "@lezer/markdown";

const Punctuation = /[\p{P}\p{S}]/u;

/** One tilde on each side strikes out too, but only between words: never inside one. */
const SINGLE_TILDE: DelimiterType = { resolve: "Strikethrough", mark: "StrikethroughMark" };

const SingleTilde: MarkdownConfig = {
  parseInline: [
    {
      name: "SingleTilde",
      parse(cx, next, pos) {
        if (next !== 126 /* ~ */ || cx.char(pos + 1) === 126 || cx.char(pos - 1) === 126) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 1, pos + 2);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        const left = !sAfter && (!pAfter || sBefore || pBefore);
        const right = !sBefore && (!pBefore || sAfter || pAfter);
        return cx.addDelimiter(SINGLE_TILDE, pos, pos + 1, left && (!right || pBefore), right && (!left || pAfter));
      },
      after: "Strikethrough",
    },
  ],
};

export const markdownParser: MarkdownParser = (commonmarkLanguage.parser as MarkdownParser).configure([Table, Strikethrough, SingleTilde, TaskList]);

/** The same data as the Markdown of CodeMirror, so its commands (Enter in a list) know it. */
const markdownLanguage = new Language(commonmarkLanguage.data, markdownParser, [], "markdown");

export function markdownSupport(): LanguageSupport {
  return new LanguageSupport(markdownLanguage);
}
