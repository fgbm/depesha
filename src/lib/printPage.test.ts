import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { letterOf, printPage, type PrintLabels, type PrintLetter } from "./printPage";
import type { OpenedMessage } from "./types";

const labels: PrintLabels = { from: "От", to: "Кому", cc: "Копия", date: "Дата", attachments: "Вложения", noSubject: "(без темы)" };

const letter = (over: Partial<PrintLetter> = {}): PrintLetter => ({
  subject: "Счёт на оплату",
  from: { name: "Анна Петрова", email: "anna@example.com" },
  to: [{ name: null, email: "me@example.com" }],
  cc: [],
  date: "9 октября 2026 г., 10:15",
  files: [],
  body: "<p>Здравствуйте</p>",
  markdown: false,
  allowRemote: false,
  ...over,
});

const opened = (over: Partial<OpenedMessage["view"]> = {}): OpenedMessage =>
  ({
    row: { id: 7, date: 1_790_000_000 },
    trusted_sender: false,
    view: {
      summary: { subject: "Тема", from: { name: "Б", email: "b@x.org" }, to: [{ name: null, email: "me@x.org" }], cc: [], date: 1_790_000_000 },
      text: "a < b & c",
      html: "<p>HTML <b>body</b></p>",
      markdown: "<h1>Заголовок</h1>",
      attachments: [],
      ...over,
    },
  }) as unknown as OpenedMessage;

describe("the printed page of a letter", () => {
  it("opens with the subject, then From, To, Date in that order", () => {
    const page = printPage(letter(), labels);
    expect(page).toContain("<h1>Счёт на оплату</h1>");
    const at = ["От", "Кому", "Дата"].map((k) => page.indexOf(`<dt>${k}</dt>`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(page).toContain("Анна Петрова &lt;anna@example.com&gt;");
    expect(page).toContain("<dd>me@example.com</dd>");
    expect(page).toContain("<dd>9 октября 2026 г., 10:15</dd>");
  });

  it("has the Cc line only when there is a copy", () => {
    expect(printPage(letter(), labels)).not.toContain("Копия");
    const page = printPage(letter({ cc: [{ name: "Ив", email: "iv@x.org" }, { name: null, email: "z@x.org" }] }), labels);
    expect(page).toContain("<dt>Копия</dt><dd>Ив &lt;iv@x.org&gt;, z@x.org</dd>");
  });

  it("names the attachments, and only when there are some", () => {
    expect(printPage(letter(), labels)).not.toContain("Вложения");
    const page = printPage(letter({ files: ["счёт.pdf", "акт.xlsx"] }), labels);
    expect(page).toContain("<dt>Вложения</dt>");
    expect(page).toContain("счёт.pdf");
    expect(page).toContain("акт.xlsx");
  });

  it("escapes what the header shows, so a name cannot add markup", () => {
    const page = printPage(
      letter({
        subject: "<script>alert(1)</script>",
        from: { name: '"><img src=x onerror=1>', email: "a@b.c" },
        files: ["<b>x</b>.txt"],
      }),
      labels,
    );
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<img");
    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("&lt;b&gt;x&lt;/b&gt;.txt");
  });

  it("says so when the letter has no subject; and carries no logo", () => {
    const page = printPage(letter({ subject: "" }), labels);
    expect(page).toContain("<h1>(без темы)</h1>");
    expect(page).not.toMatch(/<img|<svg|Депеша|Depesha/i);
  });

  it("sets the subject as the title, for the name of a saved PDF", () => {
    expect(printPage(letter({ subject: "A & B" }), labels)).toContain("<title>A &amp; B</title>");
  });

  it("is light whatever the app's theme, and lets pictures in only when the screen did", () => {
    const closed = printPage(letter(), labels);
    expect(closed).toContain("color-scheme:light");
    expect(closed).toMatch(/img-src data:\s*;/);
    expect(closed).toContain("@page");
    const open = printPage(letter({ allowRemote: true }), labels);
    expect(open).toMatch(/img-src data: https: http:;/);
  });

  it("puts the body in as it is — the backend has cleaned it", () => {
    expect(printPage(letter({ body: "<table><tr><td>1</td></tr></table>" }), labels)).toContain("<table><tr><td>1</td></tr></table>");
  });
});

describe("the page keeps a letter off the header", () => {
  it("holds the body in a box of its own, so its absolute or fixed text cannot cover the header", () => {
    const page = printPage(letter({ body: '<div style="position:absolute;top:0">Подделка</div>' }), labels);
    expect(page).toContain("main{contain:paint;position:relative;overflow:hidden}");
    // The header comes before the box and outside it.
    expect(page.indexOf("</header>")).toBeLessThan(page.indexOf("<main>"));
  });

  it("switches DNS prefetch off, as the reading frame does", () => {
    expect(printPage(letter(), labels)).toContain('<meta http-equiv="x-dns-prefetch-control" content="off">');
  });
});

describe("the letter taken from the opened message", () => {
  it("prints the HTML form as HTML", () => {
    const l = letterOf(opened(), "html", false, "дата");
    expect(l.body).toBe("<p>HTML <b>body</b></p>");
    expect(l.markdown).toBe(false);
  });

  it("prints the text form escaped, with its line breaks kept by the style", () => {
    const l = letterOf(opened(), "text", false, "дата");
    expect(l.body).toBe('<div class="plain">a &lt; b &amp; c</div>');
  });

  it("prints the Markdown form as the screen draws it, and takes the coloured code when given", () => {
    const plain = letterOf(opened(), "markdown", false, "дата");
    expect(plain.markdown).toBe(true);
    expect(plain.body).toContain("<h1>Заголовок</h1>");
    const coloured = letterOf(opened(), "markdown", false, "дата", "<h1>Цвет</h1>");
    expect(coloured.body).toContain("<h1>Цвет</h1>");
    expect(coloured.body).not.toContain("Заголовок");
  });

  it("falls back to the text when the form is not in the letter", () => {
    const l = letterOf(opened({ html: null }), "html", false, "дата");
    expect(l.body).toContain("a &lt; b &amp; c");
  });

  it("lists the files, not the pictures drawn in the text", () => {
    const att = [
      { index: 0, name: "a.pdf", mime: "application/pdf", size: 1, content_id: null, inline: false },
      { index: 1, name: "logo.png", mime: "image/png", size: 1, content_id: "cid1", inline: true },
      { index: 2, name: "b.png", mime: "image/png", size: 1, content_id: null, inline: true },
    ];
    expect(letterOf(opened({ attachments: att }), "text", false, "дата").files).toEqual(["a.pdf", "b.png"]);
  });

  it("carries the pictures' permission from the screen", () => {
    expect(letterOf(opened(), "html", true, "дата").allowRemote).toBe(true);
    expect(letterOf(opened(), "html", false, "дата").allowRemote).toBe(false);
  });
});

// The sheet the macOS test (src-tauri/tests/mac_print.rs) prints into a PDF: the same page the
// app builds, kept in a file so that the Rust test needs no Node. Regenerate: UPDATE_SHEET=1 npx vitest run printPage.
describe("the sheet of the macOS print test", () => {
  const file = new URL("../../src-tauri/tests/fixtures/sheet.html", import.meta.url);
  const sheet = printPage(
    letter({
      subject: "Invoice 42: Счёт на оплату",
      from: { name: "Anna Petrova", email: "anna@example.com" },
      cc: [{ name: null, email: "boss@example.com" }],
      files: ["invoice-42.pdf"],
      body: "<h2>Payment due</h2><p>Hello, the invoice is attached. Здравствуйте, счёт во вложении.</p>",
    }),
    labels,
  );

  it("is the page the app builds now", () => {
    if (process.env.UPDATE_SHEET) writeFileSync(file, sheet);
    expect(readFileSync(file, "utf-8")).toBe(sheet);
  });
});
