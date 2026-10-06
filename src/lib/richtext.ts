// The letter's HTML as text and back, without a DOM: the composer keeps a plain version
// of an HTML letter for the plain part, the checks before sending and plugins, and turns
// one format into another. Covered by richtext.test.ts.

/** Depesha's own blocks in an HTML letter; the backend's cleaning keeps these classes (`COMPOSE_CLASSES`). */
export const SIGNATURE_CLASS = "depesha-signature";
export const QUOTE_CLASS = "depesha-quote";

/** The empty line a new letter starts with, above the signature and the quote. */
export const GAP = "<div><br></div>";

/** How a quote looks in the recipient's mail: no stylesheet travels with the letter. */
export const QUOTE_STYLE = "margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", shy: "" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return NAMED[code.toLowerCase()] ?? all;
  });
}

interface Tag {
  name: string;
  close: boolean;
  attrs: Record<string, string>;
}

type Token = { text: string } | { tag: Tag };

function attrsOf(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Text and tags in order; comments and doctypes are dropped. */
function tokens(html: string): Token[] {
  const out: Token[] = [];
  const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let at = 0;
  for (const m of html.matchAll(re)) {
    if (m.index > at) out.push({ text: decode(html.slice(at, m.index)) });
    at = m.index + m[0].length;
    if (!m[1]) continue;
    out.push({ tag: { name: m[1].toLowerCase(), close: m[0][1] === "/", attrs: attrsOf(m[2] ?? "") } });
  }
  if (at < html.length) out.push({ text: decode(html.slice(at)) });
  return out;
}

const HIDDEN = new Set(["script", "style", "title", "head", "template", "noscript"]);
const PARAGRAPH = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "table", "ul", "ol", "dl", "hr", "figure"]);
const LINE = new Set(["div", "li", "blockquote", "tr", "section", "article", "header", "footer", "address", "center", "dt", "dd", "nav", "aside", "main", "caption", "form", "fieldset"]);

/** Markdown would read these at the start of a line as formatting. */
function escapeMarkdownLine(line: string): string {
  return line.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s)/, "$1\\$2");
}

/**
 * Text that Markdown would read as markup, an inline tag (which the backend's cleaning
 * then drops with its words) or a character reference. An underscore inside a word
 * is no emphasis and stays bare, so `snake_case` reads as typed.
 */
function escapeMarkdown(s: string): string {
  const word = /[\p{L}\p{N}]/u;
  return s
    .replace(/[\\`*[\]<~]/g, "\\$&")
    .replace(/&(?=#?[a-z0-9]+;)/gi, "\\&")
    .replace(/_/g, (m, at: number, all: string) => (word.test(all[at - 1] ?? "") && word.test(all[at + 1] ?? "") ? m : "\\_"));
}

/** An address as the target of a Markdown link: brackets and spaces would end it early. */
export function markdownUrl(url: string): string {
  return url.replace(/[()\s]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c)));
}

/**
 * Walks the HTML and writes it as lines of text, or as Markdown when `markdown` is set:
 * paragraphs apart by an empty line, lines of a quote under "> ", list items under
 * "- " and "1. ", a link with its address when the text does not show it.
 */
function render(html: string, markdown: boolean): string {
  const lines: string[] = [];
  let cur = "";
  let started = false; // the current line has content
  let pending = 0; // line breaks owed before the next content: 1 a new line, 2 an empty line between
  let depth = 0; // quote levels
  let hidden = 0;
  let pre = 0;
  let code = 0; // inline code spans open
  let opened = false; // a quote or a list item has just begun: a paragraph in it starts without an empty line
  let bullet = ""; // the list marker the next content starts with
  const lists: { ordered: boolean; n: number; items: number }[] = [];
  const links: { href: string; text: string; at: number }[] = [];
  // A signature block opened: its "-- " line goes before its first words. A block that
  // writes the separator itself (letters before #25) keeps one; one of pictures alone gets none.
  let sigOwed = false;
  let dropBreak = false;

  const prefix = () => (depth ? "> ".repeat(depth) : "");
  // The signature separator keeps its space (RFC 3676); other lines lose what trails them.
  const push = (line: string) => lines.push(line === "-- " && !depth ? line : (prefix() + line).trimEnd());
  const flush = () => {
    if (started) push(cur);
    cur = "";
    started = false;
  };
  const brk = (n: number) => {
    flush();
    pending = Math.max(pending, opened ? Math.min(n, 1) : n);
  };
  const lastBlank = () => lines.length > 0 && lines[lines.length - 1].replace(/>/g, "").trim() === "";
  const settle = () => {
    if (pending === 2 && lines.length > 0 && !lastBlank()) push("");
    pending = 0;
    opened = false;
  };
  const write = (s: string) => {
    if (!s) return;
    if (sigOwed) {
      sigOwed = false;
      dropBreak = false;
      flush();
      settle();
      push("-- ");
    }
    if (!started) {
      settle();
      started = true;
      cur = bullet;
      bullet = "";
    }
    cur += s;
    for (const l of links) l.text += s;
  };
  const text = (raw: string) => {
    if (hidden) return;
    if (sigOwed && /^\s*--\s*$/.test(raw)) {
      dropBreak = true;
      return;
    }
    if (sigOwed && !raw.trim()) return;
    if (pre) {
      raw.split("\n").forEach((part, i) => {
        if (i > 0) {
          if (!started) settle();
          push(cur);
          cur = "";
          started = true;
        }
        write(part);
      });
      return;
    }
    let s = raw.replace(/[ \t\r\n\f]+/g, " ");
    if (!started || cur.endsWith(" ")) s = s.replace(/^ /, "");
    // A code span shows its text as it is: an escape there would show its backslash.
    if (markdown && !code) s = escapeMarkdown(s);
    if (markdown && !code && !started) s = escapeMarkdownLine(s);
    write(s);
  };
  const mark = (s: string) => {
    if (markdown && !hidden) write(s);
  };

  for (const tok of tokens(html)) {
    if ("text" in tok) {
      text(tok.text);
      continue;
    }
    const { name, close, attrs } = tok.tag;
    if (HIDDEN.has(name)) {
      if (close) hidden = Math.max(0, hidden - 1);
      else hidden++;
      continue;
    }
    if (hidden) continue;
    if (name === "br") {
      if (dropBreak || sigOwed) {
        dropBreak = false;
        continue;
      }
      if (!started) settle();
      push(cur);
      cur = "";
      started = false;
      continue;
    }
    if (name === "img") continue;
    if (name === "hr") {
      brk(2);
      write(markdown ? "---" : "———");
      brk(2);
      continue;
    }
    const classes = (attrs.class ?? "").split(/\s+/);
    const own = classes.some((c) => c === SIGNATURE_CLASS || c === QUOTE_CLASS);
    if (own && !close && classes.includes(SIGNATURE_CLASS)) {
      brk(2);
      sigOwed = true;
      continue;
    }
    if (name === "blockquote") {
      brk(1);
      // An empty line owed before or after the quote stays outside it.
      if (!close && pending === 2 && lines.length > 0 && !lastBlank()) push("");
      if (!close) pending = 1;
      depth = Math.max(0, depth + (close ? -1 : 1));
      opened = !close;
      continue;
    }
    if (name === "ul" || name === "ol") {
      brk(lists.length ? 1 : 2);
      if (close) lists.pop();
      else lists.push({ ordered: name === "ol", n: Number(attrs.start) || 1, items: 0 });
      continue;
    }
    if (name === "li") {
      brk(1);
      if (!close) {
        const list = lists[lists.length - 1];
        // Items follow each other line by line, paragraphs in them or not.
        if (list && list.items++ > 0) pending = Math.min(pending, 1);
        bullet = "  ".repeat(Math.max(0, lists.length - 1)) + (list?.ordered ? `${list.n++}. ` : "- ");
        opened = true;
      }
      continue;
    }
    if (name === "pre") {
      if (close) {
        if (markdown) {
          brk(1);
          write("```");
        }
        pre = Math.max(0, pre - 1);
        brk(2);
      } else {
        brk(2);
        if (markdown) {
          write("```");
          brk(1);
        }
        pre++;
      }
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      brk(2);
      if (!close) mark("#".repeat(Number(name[1])) + " ");
      continue;
    }
    if (name === "td" || name === "th") {
      if (!close && started && cur.trim()) write("\t");
      continue;
    }
    if (PARAGRAPH.has(name) || own) {
      brk(2);
      continue;
    }
    if (LINE.has(name)) {
      brk(1);
      continue;
    }
    if (name === "a") {
      if (!close) {
        links.push({ href: attrs.href ?? "", text: "", at: cur.length });
        mark("[");
        continue;
      }
      const link = links.pop();
      if (!link) continue;
      const href = link.href.trim();
      const shown = link.text.trim();
      const address = href.replace(/^mailto:/i, "");
      if (markdown) {
        if (/^(https?:|mailto:)/i.test(href)) write(`](${markdownUrl(href)})`);
        else if (started) cur = cur.slice(0, link.at) + cur.slice(link.at + 1);
      } else if (/^(https?:|mailto:)/i.test(href) && shown !== address && shown !== href) {
        write(` <${address}>`);
      }
      continue;
    }
    if (markdown) {
      if (name === "b" || name === "strong") mark("**");
      else if (name === "i" || name === "em") mark("*");
      else if (name === "s" || name === "strike" || name === "del") mark("~~");
      else if (name === "code" && !pre) {
        code = Math.max(0, code + (close ? -1 : 1));
        mark("`");
      }
    }
  }
  flush();
  while (lines.length && lastBlank()) lines.pop();
  return lines.join("\n").replace(/\u00a0/g, " ");
}

/** The plain version of an HTML letter: the same text without the markup. */
export function htmlToText(html: string): string {
  return render(html, false);
}

/** An HTML letter as Markdown: what Markdown has keeps its formatting, the rest becomes text. */
export function htmlToMarkdown(html: string): string {
  return render(html, true);
}

/** Plain text as HTML: a line a line, "> " lines a quote. */
export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const block = (part: string[]): string => {
    let out = "";
    for (let i = 0; i < part.length; ) {
      if (part[i].startsWith(">")) {
        const quoted: string[] = [];
        while (i < part.length && part[i].startsWith(">")) quoted.push(part[i++].replace(/^> ?/, ""));
        out += `<blockquote style="${QUOTE_STYLE}">${block(quoted)}</blockquote>`;
        continue;
      }
      const line = part[i++];
      out += line ? `<div>${escapeHtml(line).replace(/ {2}/g, " \u00a0")}</div>` : GAP;
    }
    return out;
  };
  return block(lines);
}

const ADDRESS = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi;

function linked(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(ADDRESS)) {
    const at = m.index ?? 0;
    out += escapeHtml(line.slice(last, at));
    const href = m[0].includes("@") && !/^https?:/i.test(m[0]) ? `mailto:${m[0]}` : m[0];
    out += `<a href="${escapeHtml(href)}">${escapeHtml(m[0])}</a>`;
    last = at + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

/**
 * Typed text as an HTML letter (the quick reply of an HTML mailbox): paragraphs parted
 * by an empty line, a line break kept, web and mail addresses as links.
 */
export function paragraphsHtml(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p) => `<p>${p.split("\n").map(linked).join("<br>")}</p>`)
    .join("");
}

/** Where a block of Depesha's (`SIGNATURE_CLASS`, `QUOTE_CLASS`) starts and ends in the HTML. */
export function findBlock(html: string, cls: string): { start: number; end: number } | null {
  const open = new RegExp(`<div\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>`, "i").exec(html);
  if (!open) return null;
  const re = /<div\b[^>]*>|<\/div\s*>/gi;
  re.lastIndex = open.index + open[0].length;
  let level = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    level += m[0][1] === "/" ? -1 : 1;
    if (level === 0) return { start: open.index, end: m.index + m[0].length };
  }
  return { start: open.index, end: html.length };
}

export function removeBlock(html: string, cls: string): string {
  const b = findBlock(html, cls);
  return b ? html.slice(0, b.start) + html.slice(b.end) : html;
}

/** An HTML reply as what is typed and the quote under it; `head + quote` is the HTML again. */
export function splitHtmlQuote(html: string): { head: string; quote: string } {
  const b = findBlock(html, QUOTE_CLASS);
  return b ? { head: html.slice(0, b.start), quote: html.slice(b.start) } : { head: html, quote: "" };
}

/**
 * The plain version of an HTML letter given apart as what is typed and its quote as
 * text (a long quote is turned into text once). The quote always follows an empty line,
 * as in a plain-text reply: the checks before sending tell it from what is typed by that.
 */
export function letterText(head: string, quoteText: string): string {
  return htmlToText(head) + (quoteText ? `\n\n${quoteText}` : "");
}

/** The plain version of a whole HTML letter, the same as the composer keeps. */
export function htmlLetterText(html: string): string {
  const { head, quote } = splitHtmlQuote(html);
  return letterText(head, htmlToText(quote));
}

/** The tags that carry formatting; lines, paragraphs and Depesha's blocks do not. */
export function hasFormatting(html: string): boolean {
  for (const tok of tokens(html)) {
    if (!("tag" in tok)) continue;
    const { name, attrs } = tok.tag;
    if (name === "br" || name === "p" || name === "div") continue;
    if (name === "span" && !attrs.style) continue;
    return true;
  }
  return false;
}
