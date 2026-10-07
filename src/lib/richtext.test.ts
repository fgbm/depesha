import { describe, expect, it } from "vitest";
import { findBlock, GAP, paragraphsHtml, hasFormatting, htmlHasOwnText, htmlToMarkdown, htmlToText, QUOTE_CLASS, removeBlock, SIGNATURE_CLASS, splitHtmlQuote, textToHtml } from "./richtext";

describe("htmlToText", () => {
  it("keeps the text and drops the markup", () => {
    expect(htmlToText("<div>Привет, <b>Боб</b>!</div>")).toBe("Привет, Боб!");
    expect(htmlToText("<p>Раз</p><p>Два &amp; три</p>")).toBe("Раз\n\nДва & три");
  });

  it("writes the lines of the editor as lines, empty ones included", () => {
    expect(htmlToText("<div>a</div><div><br></div><div>b</div>")).toBe("a\n\nb");
    expect(htmlToText("a<br>b<br><br>c")).toBe("a\nb\n\nc");
    expect(htmlToText("<div>a<br></div><div>b</div>")).toBe("a\nb");
  });

  it("collapses the spaces of the source", () => {
    expect(htmlToText("<div>  много\n   пробелов </div>")).toBe("много пробелов");
    expect(htmlToText("<div>a&nbsp;&nbsp;b</div>")).toBe("a  b");
  });

  it("writes lists with bullets and numbers", () => {
    expect(htmlToText("<ul><li>раз</li><li>два<ol><li>а</li><li>б</li></ol></li></ul>")).toBe("- раз\n- два\n  1. а\n  2. б");
  });

  it("starts paragraphs in quotes and list items without an empty line", () => {
    expect(htmlToText("<p>Вопрос</p><blockquote><p>раз</p><p>два</p></blockquote>")).toBe("Вопрос\n\n> раз\n>\n> два");
    expect(htmlToText("<ul><li><p>раз</p></li><li><p>два</p></li></ul>")).toBe("- раз\n- два");
  });

  it("puts quotes under >", () => {
    expect(htmlToText("<div>Иван пишет:</div><blockquote><div>да</div><blockquote>нет</blockquote></blockquote>")).toBe(
      "Иван пишет:\n> да\n> > нет",
    );
  });

  it("shows where a link leads unless its text says it", () => {
    expect(htmlToText('<a href="https://example.com/a">отчёт</a>')).toBe("отчёт <https://example.com/a>");
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe("https://example.com");
    expect(htmlToText('<a href="mailto:a@example.com">a@example.com</a>')).toBe("a@example.com");
    expect(htmlToText('<a href="javascript:x()">ссылка</a>')).toBe("ссылка");
  });

  it("drops what is not text", () => {
    expect(htmlToText("<style>p{}</style><script>x()</script><!-- c --><img src=x>Текст")).toBe("Текст");
  });

  it("keeps the signature separator and the blank line before the quote", () => {
    const html =
      '<div>Ответ</div><div class="depesha-signature">-- <br>Влад</div><div class="depesha-quote"><div>Иван пишет:</div><blockquote>да</blockquote></div>';
    expect(htmlToText(html)).toBe("Ответ\n\n-- \nВлад\n\nИван пишет:\n> да");
  });
});

describe("htmlToMarkdown", () => {
  it("keeps what Markdown has", () => {
    expect(htmlToMarkdown("<div><b>жирный</b> и <i>курсив</i></div><ul><li>раз</li></ul>")).toBe("**жирный** и *курсив*\n\n- раз");
    expect(htmlToMarkdown('<a href="https://example.com">сайт</a>')).toBe("[сайт](https://example.com)");
    expect(htmlToMarkdown("<h2>Итоги</h2><p>текст</p>")).toBe("## Итоги\n\nтекст");
    expect(htmlToMarkdown("<blockquote>да</blockquote>")).toBe("> да");
  });

  it("keeps brackets of a link's address inside it", () => {
    expect(htmlToMarkdown('<a href="https://example.com/a_(b)">ссылка</a>')).toBe("[ссылка](https://example.com/a_%28b%29)");
  });

  it("does not let plain text turn into formatting", () => {
    expect(htmlToMarkdown("<div>2*3 = 6</div><div># не заголовок</div><div>- не список</div>")).toBe("2\\*3 = 6\n\\# не заголовок\n\\- не список");
  });

  it("keeps tags, references and brackets of the text as text", () => {
    expect(htmlToMarkdown("<div>Use Vector&lt;int&gt;</div>")).toBe("Use Vector\\<int>");
    expect(htmlToMarkdown("<div>&amp;copy; и a &amp; b</div>")).toBe("\\&copy; и a & b");
    expect(htmlToMarkdown("<div>[1] ~x~ _a_ snake_case</div>")).toBe("\\[1\\] \\~x\\~ \\_a\\_ snake_case");
  });

  it("does not escape inside a code span", () => {
    expect(htmlToMarkdown("<div><code>a*b &lt;T&gt;</code> a*b</div>")).toBe("`a*b <T>` a\\*b");
  });
});

describe("textToHtml", () => {
  it("makes a line a line and escapes the text", () => {
    expect(textToHtml("a < b\n\nc")).toBe("<div>a &lt; b</div><div><br></div><div>c</div>");
  });

  it("turns > lines into quotes", () => {
    const html = textToHtml("Иван пишет:\n> да\n> > нет");
    expect(html).toContain("<blockquote");
    expect(htmlToText(html)).toBe("Иван пишет:\n> да\n> > нет");
  });
});

describe("blocks", () => {
  const html = '<div>x</div><div class="depesha-signature">-- <br><div>Влад</div></div><div class="depesha-quote"><blockquote>q</blockquote></div>';

  it("finds a block with its nested lines", () => {
    const b = findBlock(html, "depesha-signature");
    expect(b && html.slice(b.start, b.end)).toBe('<div class="depesha-signature">-- <br><div>Влад</div></div>');
    expect(removeBlock(html, "depesha-signature")).toBe('<div>x</div><div class="depesha-quote"><blockquote>q</blockquote></div>');
    expect(findBlock("<div>x</div>", "depesha-signature")).toBeNull();
  });

  it("splits the quote off", () => {
    const { head, quote } = splitHtmlQuote(html);
    expect(quote.startsWith('<div class="depesha-quote">')).toBe(true);
    expect(head + quote).toBe(html);
    expect(splitHtmlQuote("<div>x</div>")).toEqual({ head: "<div>x</div>", quote: "" });
  });
});

describe("formatting checks", () => {
  it("tells formatted HTML from lines of text", () => {
    expect(hasFormatting('<div>a</div><div><br></div><div class="depesha-signature">-- <br>b</div>')).toBe(false);
    expect(hasFormatting("<div>a <b>b</b></div>")).toBe(true);
    expect(hasFormatting("<ul><li>a</li></ul>")).toBe(true);
  });

});

describe("paragraphsHtml", () => {
  it("parts paragraphs by empty lines and links addresses", () => {
    expect(paragraphsHtml("Иван, спасибо!\nДо четверга.\n\nСмета: https://example.com/smeta, пишите на a@example.com")).toBe(
      '<p>Иван, спасибо!<br>До четверга.</p><p>Смета: <a href="https://example.com/smeta">https://example.com/smeta</a>, пишите на <a href="mailto:a@example.com">a@example.com</a></p>',
    );
    expect(paragraphsHtml("a < b")).toBe("<p>a &lt; b</p>");
  });
});

describe("whether an HTML letter has words of its own", () => {
  it("counts text, not the signature or the quote (#44, frame 12А)", () => {
    expect(htmlHasOwnText(GAP)).toBe(false);
    expect(htmlHasOwnText("<div>Привет</div>")).toBe(true);
    expect(htmlHasOwnText(`<div class="${SIGNATURE_CLASS}"><div>-- <br>Иван</div></div>`)).toBe(false);
    expect(htmlHasOwnText(`<div class="${QUOTE_CLASS}"><div>&gt; старое</div></div>`)).toBe(false);
    expect(htmlHasOwnText(`<div class="${SIGNATURE_CLASS}"><div>Иван</div></div>${GAP}<div class="${QUOTE_CLASS}"><div>старое</div></div>`)).toBe(false);
    expect(htmlHasOwnText(`<div>Ответ</div>${GAP}<div class="${SIGNATURE_CLASS}"><div>Иван</div></div>`)).toBe(true);
    // Spaces alone are no words.
    expect(htmlHasOwnText("<div> </div>")).toBe(false);
  });
});
