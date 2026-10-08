// Syntax highlighting of code, on the client only (decisions on #45): the same small set of
// languages lights up code blocks in the Markdown editor (a CodeMirror decoration) and in a
// Markdown letter Depesha shows (classes put on the HTML before MailFrame, the styles in its
// srcdoc — no scripts in the frame). Nothing goes into the HTML a letter is sent with, and no
// per-language lezer parser is pulled in: a letter's blocks are short, a token scan is enough.
// Covered by syntax.test.ts.

/** The languages both the editor and the reader know, and the names they go by. */
const ALIASES: Record<string, string> = {
  js: "js",
  jsx: "js",
  javascript: "js",
  mjs: "js",
  cjs: "js",
  ts: "ts",
  tsx: "ts",
  typescript: "ts",
  json: "json",
  jsonc: "json",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sql: "sql",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  html: "html",
  xml: "html",
  svg: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  yml: "yaml",
  yaml: "yaml",
};

/** The keywords that light up, per language. */
const KEYWORDS: Record<string, string[]> = {
  js: "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined".split(" "),
  ts: "as async await break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of private protected public readonly return set static super switch this throw try type typeof var void while yield satisfies infer true false null undefined".split(" "),
  json: ["true", "false", "null"],
  python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self".split(" "),
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while union".split(" "),
  sql: "select from where and or not order by group having insert into values update set delete create table alter drop join left right inner outer on as limit offset distinct null true false case when then end count sum avg min max".split(" "),
  bash: "if then else elif fi for while do done case esac function return in select until export local readonly declare echo cd exit source".split(" "),
  css: [],
  yaml: ["true", "false", "null", "yes", "no"],
  html: [],
};

/** Comment markers: a line that starts the run, and a block that opens and closes. */
const COMMENTS: Record<string, { line?: string; block?: [string, string] }> = {
  js: { line: "//", block: ["/*", "*/"] },
  ts: { line: "//", block: ["/*", "*/"] },
  json: { line: "//", block: ["/*", "*/"] },
  python: { line: "#" },
  rust: { line: "//", block: ["/*", "*/"] },
  sql: { line: "--", block: ["/*", "*/"] },
  bash: { line: "#" },
  css: { block: ["/*", "*/"] },
  yaml: { line: "#" },
  html: {},
};

/** A run of code and the class the frame colours it by. */
export interface Span {
  from: number;
  to: number;
  /** `kw` keyword, `str` text, `cm` comment, `num` number, `tag`/`attr` markup, `prop` a name. */
  cls: string;
}

/** The canonical name of a code block's language, or null when it is not one we light. */
export function canonicalLang(name: string): string | null {
  const first = name.trim().toLowerCase().split(/[\s,;{]/)[0] ?? "";
  return ALIASES[first] ?? null;
}

/** Every language the editor and the reader light up. */
export const LANGS = ["js", "ts", "json", "python", "rust", "sql", "bash", "html", "css", "yaml"] as const;

const IDENT = /[A-Za-z_$][\w$]*/;
const NUMBER = /0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/;

/**
 * The coloured runs of a piece of code, in the order they appear. Line by line, with the
 * block comment and multi-line string carried over from the line before. Unknown languages
 * give no runs: the reader then leaves the block plain.
 */
export function highlightTokens(code: string, lang: string): Span[] {
  const name = canonicalLang(lang);
  if (!name) return [];
  const scan = new Scan(name, new Set((KEYWORDS[name] ?? []).map((w) => w.toLowerCase())), COMMENTS[name] ?? {});
  let base = 0;
  for (const line of code.split("\n")) {
    scan.line(line, base);
    base += line.length + 1;
  }
  return scan.spans;
}

/** One pass over the code, carrying an open comment or string from line to line. */
class Scan {
  readonly spans: Span[] = [];
  private block: string | null = null;
  private quote: string | null = null;

  constructor(
    private readonly name: string,
    private readonly words: Set<string>,
    private readonly comment: { line?: string; block?: [string, string] },
  ) {}

  line(text: string, base: number) {
    let i = 0;
    while (i < text.length) {
      const at = base + i;
      if (this.block) {
        const { next, closed } = this.carry(text, base, i, this.block, "cm");
        i = next;
        if (closed) this.block = null;
        continue;
      }
      if (this.quote) {
        const { next, closed } = this.carry(text, base, i, this.quote, "str");
        i = next;
        if (closed) this.quote = null;
        continue;
      }
      const ch = text[i];
      if (this.comment.line && text.startsWith(this.comment.line, i)) {
        this.spans.push({ from: at, to: base + text.length, cls: "cm" });
        return;
      }
      if (this.comment.block && text.startsWith(this.comment.block[0], i)) {
        const open = this.comment.block[0];
        const end = text.indexOf(this.comment.block[1], i + open.length);
        if (end < 0) {
          this.spans.push({ from: at, to: base + text.length, cls: "cm" });
          this.block = this.comment.block[1];
          return;
        }
        this.spans.push({ from: at, to: base + end + this.comment.block[1].length, cls: "cm" });
        i = end + this.comment.block[1].length;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        const end = text.indexOf(ch, i + 1);
        if (end < 0) {
          this.spans.push({ from: at, to: base + text.length, cls: "str" });
          this.quote = ch;
          return;
        }
        this.spans.push({ from: at, to: base + end + 1, cls: "str" });
        i = end + 1;
        continue;
      }
      if (this.name === "html") {
        const next = markup(text, i, at, this.spans);
        if (next > i) {
          i = next;
          continue;
        }
      }
      i = this.word(text, base, i);
    }
  }

  /** An open comment or string run: to its end on this line, or the rest of the line. */
  private carry(text: string, base: number, i: number, mark: string, cls: string): { next: number; closed: boolean } {
    const end = text.indexOf(mark, i);
    if (end < 0) {
      this.spans.push({ from: base + i, to: base + text.length, cls });
      return { next: text.length, closed: false };
    }
    this.spans.push({ from: base + i, to: base + end + mark.length, cls });
    return { next: end + mark.length, closed: true };
  }

  /** A number, a keyword or a name at `i`; the place after it. */
  private word(text: string, base: number, i: number): number {
    const num = NUMBER.exec(text.slice(i));
    if (num && num.index === 0) {
      this.spans.push({ from: base + i, to: base + i + num[0].length, cls: "num" });
      return i + num[0].length;
    }
    const id = IDENT.exec(text.slice(i));
    if (id && id.index === 0) {
      if (this.words.has(id[0].toLowerCase())) this.spans.push({ from: base + i, to: base + i + id[0].length, cls: "kw" });
      else if (this.name === "css" && text[i + id[0].length] === ":") this.spans.push({ from: base + i, to: base + i + id[0].length, cls: "prop" });
      return i + id[0].length;
    }
    return i + 1;
  }
}

/** Markup inside HTML: `<tag`, its attributes and their values; 0 when nothing is there. */
function markup(text: string, i: number, at: number, spans: Span[]): number {
  if (text[i] !== "<") return 0;
  const tag = /^<\/?([A-Za-z][\w:-]*)/.exec(text.slice(i));
  if (!tag) return 0;
  spans.push({ from: at, to: at + tag[0].length, cls: "tag" });
  let j = i + tag[0].length;
  while (j < text.length && text[j] !== ">") {
    if (/\s/.test(text[j])) {
      j++;
      continue;
    }
    const attr = /^[A-Za-z_:][\w:.-]*/.exec(text.slice(j));
    if (!attr) {
      j++;
      continue;
    }
    spans.push({ from: at + j, to: at + j + attr[0].length, cls: "attr" });
    j += attr[0].length;
    const eq = /^\s*=\s*/.exec(text.slice(j));
    if (!eq) continue;
    j += eq[0].length;
    const q = text[j];
    if (q === '"' || q === "'") {
      const end = text.indexOf(q, j + 1);
      const stop = end < 0 ? text.length : end + 1;
      spans.push({ from: at + j, to: at + stop, cls: "str" });
      j = stop;
    }
  }
  return j < text.length ? j + 1 : text.length;
}

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A piece of code as HTML with the runs wrapped in `span.hl-…`, ready for the frame. */
export function highlightHtml(code: string, lang: string): string {
  const spans = highlightTokens(code, lang);
  let out = "";
  let at = 0;
  for (const s of spans) {
    if (s.from < at) continue;
    out += escape(code.slice(at, s.from)) + `<span class="hl-${s.cls}">${escape(code.slice(s.from, s.to))}</span>`;
    at = s.to;
  }
  return out + escape(code.slice(at));
}

/** The colours of the runs, in the frame's own document: no scripts and no per-language CSS
 *  files go into the sandbox. Greys and tints that read on white and on a dark theme alike. */
export const HL_CSS = `<style>
.hl-kw{color:#a626a4}.hl-str{color:#50a14f}.hl-cm{color:#a0a1a7;font-style:italic}
.hl-num{color:#986801}.hl-tag{color:#e45649}.hl-attr{color:#986801}.hl-prop{color:#4078f2}
@media (prefers-color-scheme:dark){
.hl-kw{color:#c678dd}.hl-str{color:#98c379}.hl-cm{color:#7f848e}.hl-num{color:#d19a66}
.hl-tag{color:#e06c75}.hl-attr{color:#d19a66}.hl-prop{color:#61afef}
}</style>`;

/** `<pre><code class="language-x">…</code></pre>` of a letter's HTML: the code inside it gets
 *  the runs of the language it names. A block with no language (or one we do not know) stays
 *  as it was. Called in a lazy chunk, the frame's own styles give the runs their colours.
 *  The letter is read the way the browser reads it, not by a pattern of our own: a `>` inside
 *  another attribute is no end of a tag, and `&quot;` in the code is a quote, not markup. */
export function highlightDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = false;
  for (const code of doc.querySelectorAll("pre > code")) {
    const lang = languageOf(code.getAttribute("class") ?? "");
    if (!lang) continue;
    code.replaceChildren(...highlightNodes(doc, code.textContent ?? "", lang));
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

/** The language a `<code>` names: `language-…`/`lang-…` first, else its only word. */
function languageOf(classes: string): string | null {
  const m = /(?:^|\s)(?:language-|lang-)([\w+#.-]+)/i.exec(classes) ?? /(?:^|\s)([\w+#.-]+)/.exec(classes);
  return m ? canonicalLang(m[1]) : null;
}

/** The code's runs as nodes: the text as it is, a run in a `span.hl-…`. */
function highlightNodes(doc: Document, code: string, lang: string): Node[] {
  const spans = highlightTokens(code, lang);
  const nodes: Node[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.from < at) continue;
    if (s.from > at) nodes.push(doc.createTextNode(code.slice(at, s.from)));
    const span = doc.createElement("span");
    span.className = `hl-${s.cls}`;
    span.textContent = code.slice(s.from, s.to);
    nodes.push(span);
    at = s.to;
  }
  if (at < code.length) nodes.push(doc.createTextNode(code.slice(at)));
  return nodes;
}
