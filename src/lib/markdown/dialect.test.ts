import { describe, expect, it } from "vitest";
import type { SyntaxNode } from "@lezer/common";
import { markdownParser } from "./dialect";
import cases from "../../../crates/depesha-core/tests/markdown_dialect.json";

/** The tags pulldown-cmark writes for these nodes, in the order it opens them. */
const TAGS: Record<string, string[]> = {
  Paragraph: ["p"],
  Emphasis: ["em"],
  StrongEmphasis: ["strong"],
  Strikethrough: ["del"],
  InlineCode: ["code"],
  FencedCode: ["pre", "code"],
  CodeBlock: ["pre", "code"],
  Link: ["a"],
  Autolink: ["a"],
  Image: ["img"],
  BulletList: ["ul"],
  OrderedList: ["ol"],
  ListItem: ["li"],
  Blockquote: ["blockquote"],
  HorizontalRule: ["hr"],
  HardBreak: ["br"],
  Table: ["table"],
  TableHeader: ["thead", "tr"],
  TableCell: [],
};

/** The tags the editor's parser sees in a text, as the backend would write them. */
function tagsOf(text: string): string[] {
  const out: string[] = [];
  const walk = (node: SyntaxNode, inParagraph: boolean) => {
    const name = node.name;
    if (/^(ATX|Setext)Heading\d$/.test(name)) out.push(`h${name.slice(-1)}`);
    else if (name === "Paragraph" && node.parent?.name === "ListItem") {
      // A tight list's item has no paragraph of its own.
    } else if (name === "TableRow") {
      if (node.prevSibling?.name !== "TableRow") out.push("tbody");
      out.push("tr");
    } else if (name === "TableCell") out.push(node.parent?.name === "TableHeader" ? "th" : "td");
    else if (name === "TaskMarker") out.push(/x/i.test(text.slice(node.from, node.to)) ? "task-done" : "task");
    else if (name === "HTMLTag") {
      const tag = /^<([a-z][a-z0-9]*)/i.exec(text.slice(node.from, node.to));
      if (tag) out.push(tag[1].toLowerCase());
    } else out.push(...(TAGS[name] ?? []));
    // A line break inside a paragraph is a break: the backend keeps the lines of a letter.
    const paragraph = inParagraph || name === "Paragraph";
    let at = node.from;
    for (let child = node.firstChild; ; child = child.nextSibling) {
      const gapEnd = child ? child.from : node.to;
      // A hard break holds its line break: that is the one <br>.
      if (paragraph && name !== "InlineCode" && name !== "HardBreak") {
        for (const ch of text.slice(at, gapEnd)) if (ch === "\n") out.push("br");
      }
      if (!child) break;
      walk(child, paragraph);
      at = child.to;
    }
  };
  walk(markdownParser.parse(text).topNode, false);
  return out;
}

describe("the editor reads Markdown as the backend does", () => {
  it.each(cases as { md: string; tags: string[] }[])("$md", ({ md, tags }) => {
    expect(tagsOf(md)).toEqual(tags);
  });

  it("has no syntax the backend does not know", () => {
    const names = new Set(markdownParser.nodeSet.types.map((t) => t.name));
    for (const name of ["Subscript", "Superscript", "Emoji"]) expect(names.has(name)).toBe(false);
    // No autolinks of bare addresses: the backend leaves them as text.
    expect(markdownParser.parse("https://example.com").topNode.firstChild?.firstChild).toBeNull();
  });
});
