import { describe, expect, it } from "vitest";
import { canonicalLang, highlightDocument, highlightHtml, highlightTokens, LANGS } from "./syntax";

/** The runs as `cls:text` pairs, easier to read in a test than offsets. */
function runs(code: string, lang: string): string[] {
  return highlightTokens(code, lang).map((s) => `${s.cls}:${code.slice(s.from, s.to)}`);
}

describe("the languages the client lights up", () => {
  it("knows its names and their aliases", () => {
    expect(canonicalLang("js")).toBe("js");
    expect(canonicalLang("JavaScript")).toBe("js");
    expect(canonicalLang("ts")).toBe("ts");
    expect(canonicalLang("py")).toBe("python");
    expect(canonicalLang("rs json")).toBe("rust");
    expect(canonicalLang("xml")).toBe("html");
    expect(canonicalLang("sh")).toBe("bash");
    expect(canonicalLang("yml")).toBe("yaml");
    expect(canonicalLang("brainfuck")).toBeNull();
    expect(canonicalLang("")).toBeNull();
  });

  it("has the small shared set of languages", () => {
    expect(LANGS).toEqual(["js", "ts", "json", "python", "rust", "sql", "bash", "html", "css", "yaml"]);
  });
});

describe("the runs a piece of code is made of", () => {
  it("lights keywords, numbers, strings and comments", () => {
    expect(runs("const n = 42; // note", "js")).toEqual(["kw:const", "num:42", "cm:// note"]);
    expect(runs("def go(x):\n    return x  # ok", "python")).toEqual(["kw:def", "kw:return", "cm:# ok"]);
    expect(runs('name = "Иван"', "python")).toEqual(["str:\"Иван\""]);
  });

  it("carries a block comment over the lines", () => {
    expect(runs("/* a\nb */ x", "js")).toEqual(["cm:/* a", "cm:b */"]);
  });

  it("carries a multi-line string over the lines", () => {
    expect(runs('s = "one\ntwo"', "python")).toEqual(["str:\"one", "str:two\""]);
  });

  it("reads SQL keywords whatever their case", () => {
    expect(runs("SELECT id FROM t WHERE x = 1 -- c", "sql")).toEqual([
      "kw:SELECT",
      "kw:FROM",
      "kw:WHERE",
      "num:1",
      "cm:-- c",
    ]);
  });

  it("marks the tags and attributes of markup", () => {
    expect(runs('<a href="x">hi</a>', "html")).toEqual(["tag:<a", "attr:href", 'str:"x"', "tag:</a"]);
  });

  it("gives no runs for a language it does not know", () => {
    expect(runs("whatever", "brainfuck")).toEqual([]);
  });
});

describe("code as HTML for the frame", () => {
  it("wraps the runs and escapes the code", () => {
    expect(highlightHtml("x < 1", "js")).toBe('x &lt; <span class="hl-num">1</span>');
    expect(highlightHtml("a", "html")).toBe("a");
  });

  it("leaves a block of an unknown language alone", () => {
    const html = '<pre><code class="language-brainfuck">+++</code></pre>';
    expect(highlightDocument(html)).toBe(html);
  });

  it("colours the code blocks of a Markdown letter", () => {
    const html = '<p>x</p><pre><code class="language-sql">SELECT 1</code></pre>';
    const out = highlightDocument(html);
    expect(out).toContain('<span class="hl-kw">SELECT</span>');
    expect(out).toContain('<span class="hl-num">1</span>');
    expect(out).not.toContain("script");
  });

  it("reads a bare class name and stays clear of scripts", () => {
    const html = '<pre><code class="rust">fn main() {}</code></pre>';
    const out = highlightDocument(html);
    expect(out).toContain('<span class="hl-kw">fn</span>');
    expect(out).not.toContain("script");
  });
});
