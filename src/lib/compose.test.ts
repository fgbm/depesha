import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import {
  convertDraft,
  emptyDraft,
  formatFor,
  forward,
  fromDraft,
  isDirty,
  forwardSubject,
  losesFormatting,
  reply,
  replySubject,
  splitQuote,
  takeBodyPictures,
} from "./compose";
import { putSignatureHtml, putSignatureText, sigHtml, withSignature } from "./signatures";
import { htmlLetterText, htmlToText, splitHtmlQuote } from "./richtext";
import { linkify, parseAddr, pluralRu } from "./format";
import type { OpenedMessage, Signature } from "./types";

const me = { name: "Влад", email: "me@example.com" };

/** A signature of these words, its HTML a line a line. */
function sig(text: string): Signature {
  return { id: text, name: text, html: text.split("\n").map((l) => `<div>${l}</div>`).join(""), text };
}

function msg(over: Partial<OpenedMessage["view"]["summary"]> = {}): OpenedMessage {
  const summary = {
    message_id: "m2@example.org",
    in_reply_to: "m1@example.org",
    references: ["m1@example.org"],
    subject: "Счёт",
    from: { name: "Иван", email: "ivan@example.org" },
    to: [me, { name: null, email: "anna@example.org" }],
    cc: [{ name: null, email: "boss@example.org" }, { name: null, email: "ME@example.com" }],
    reply_to: [],
    date: 1790000000,
    has_attachments: true,
    bulk: false,
    unsubscribe: null,
    ...over,
  };
  return {
    row: { id: 7, account_id: "a", folder: "INBOX", uid: 1, message_id: summary.message_id, in_reply_to: null, references: [],
      subject: summary.subject, from: summary.from, to: summary.to, cc: summary.cc, reply_to: [], date: 1790000000, size: 1,
      flags: { seen: true, answered: false, flagged: false, draft: false, deleted: false }, has_attachments: true,
      thread: "m1@example.org", bulk: false, thread_count: 1, thread_date: 0, thread_senders: [], thread_draft: false, snoozed_until: null, followup_due: null },
    view: {
      summary,
      text: "Добрый день!\n> старая цитата",
      html: null,
      has_remote_content: false, authenticated: false,
      attachments: [
        { index: 0, name: "счёт.pdf", mime: "application/pdf", size: 10, content_id: null, inline: false },
        { index: 1, name: "logo.png", mime: "image/png", size: 5, content_id: "logo", inline: true },
      ],
    },
    trusted_sender: false,
  };
}

// These tests check the Russian wording; English has its own tests in i18n.test.ts.
beforeEach(() => {
  i18n.lang = "ru";
});

describe("subjects", () => {
  it("adds prefixes once", () => {
    expect(replySubject("Счёт")).toBe("Re: Счёт");
    expect(replySubject("RE: Счёт")).toBe("RE: Счёт");
    expect(replySubject("Ответ: Счёт")).toBe("Ответ: Счёт");
    expect(forwardSubject("Fw: x")).toBe("Fw: x");
    expect(forwardSubject("x")).toBe("Fwd: x");
  });
});

describe("reply", () => {
  it("replies to the sender with quote and threading", () => {
    const d = reply(msg(), me, false);
    expect(d.to.map((a) => a.email)).toEqual(["ivan@example.org"]);
    expect(d.cc).toEqual([]);
    expect(d.in_reply_to).toBe("m2@example.org");
    expect(d.references).toEqual(["m1@example.org", "m2@example.org"]);
    expect(d.text).toContain("Иван <ivan@example.org> пишет:");
    expect(d.text).toContain("> Добрый день!");
    expect(d.text).toContain(">> старая цитата");
  });

  it("reply all excludes me in any case and dedups", () => {
    const d = reply(msg(), me, true);
    expect(d.to.map((a) => a.email)).toEqual(["ivan@example.org"]);
    expect(d.cc.map((a) => a.email)).toEqual(["anna@example.org", "boss@example.org"]);
  });

  it("honours Reply-To", () => {
    const d = reply(msg({ reply_to: [{ name: null, email: "list@example.org" }] }), me, false);
    expect(d.to.map((a) => a.email)).toEqual(["list@example.org"]);
  });

  it("reply to my own sent message goes to its recipients", () => {
    const d = reply(msg({ from: me, to: [{ name: null, email: "anna@example.org" }], cc: [] }), me, false);
    expect(d.to.map((a) => a.email)).toEqual(["anna@example.org"]);
  });
});

describe("splitQuote", () => {
  it("takes the quote of a reply off what is typed, losing nothing", () => {
    const d = withSignature(reply(msg(), me, false), sig("Карл"));
    const typed = `Спасибо!${d.text}`;
    const { head, quote } = splitQuote(typed);
    expect(head).toBe("Спасибо!\n\n-- \nКарл");
    expect(quote.startsWith("\n\n")).toBe(true);
    expect(quote).toContain("пишет:\n> Добрый день!");
    expect(head + quote).toBe(typed);
  });

  it("leaves text without a trailing quote whole", () => {
    for (const text of ["", "Привет", "Итак:\n> вставка\nи мой ответ ниже", "> только цитата"]) {
      expect(splitQuote(text)).toEqual({ head: text, quote: "" });
    }
  });
});

describe("forward", () => {
  it("keeps attachments; a plain forward carries the letter's pictures as files", () => {
    const d = forward(msg(), me);
    expect(d.subject).toBe("Fwd: Счёт");
    expect(d.to).toEqual([]);
    expect(d.attachments).toEqual([
      { kind: "message", id: 7, index: 0, name: "счёт.pdf", size: 10 },
      { kind: "message", id: 7, index: 1, name: "logo.png", size: 5 },
    ]);
    expect(forward(msg(), me, "markdown").attachments).toHaveLength(2);
    // A plain-text letter has no HTML to carry its picture in.
    expect(forward(msg(), me, "html").attachments).toHaveLength(2);
  });

  it("an HTML forward attaches only the pictures its HTML cannot carry", () => {
    const m = msg();
    const big = { index: 2, name: "big.png", mime: "image/png", size: 6 * 1024 * 1024, content_id: "big", inline: true };
    const tiff = { index: 3, name: "scan.tiff", mime: "image/tiff", size: 5, content_id: "scan", inline: true };
    const view = { ...m.view, html: '<p>да</p><img src="data:image/png;base64,AA">', attachments: [...m.view.attachments, big, tiff] };
    const d = forward({ ...m, view }, me, "html");
    expect(d.attachments.map((a) => a.name)).toEqual(["счёт.pdf", "big.png", "scan.tiff"]);
  });

  it("carries the letter below its header", () => {
    const d = forward(msg(), me);
    expect(d.text).toContain("Пересылаемое сообщение");
    expect(d.text).toContain("Добрый день!");
  });

  it("stays in the conversation it came from", () => {
    const d = forward(msg(), me);
    expect(d.in_reply_to).toBe("m2@example.org");
    expect(d.references).toEqual(["m1@example.org", "m2@example.org"]);
  });
});

describe("format", () => {
  it("parses addresses", () => {
    expect(parseAddr("Иван Петров <ivan@example.org>")).toEqual({ name: "Иван Петров", email: "ivan@example.org" });
    expect(parseAddr("ivan@example.org,")).toEqual({ name: null, email: "ivan@example.org" });
    expect(parseAddr("not an address")).toBeNull();
  });

  it("linkifies without trailing punctuation", () => {
    const parts = linkify("см. https://example.com/x?a=1. Спасибо");
    expect(parts.find((p) => p.href)?.href).toBe("https://example.com/x?a=1");
  });

  it("plurals", () => {
    expect([1, 2, 5, 11, 21].map((n) => pluralRu(n, "письмо", "письма", "писем"))).toEqual([
      "письмо", "письма", "писем", "писем", "письмо",
    ]);
  });
});

describe("signature", () => {
  it("goes below a new message and above the quote of a reply", () => {
    expect(withSignature(emptyDraft(me), sig("Иван\nотдел ИТ")).text).toBe("\n\n-- \nИван\nотдел ИТ");
    const r = withSignature(reply(msg(), me, false), sig("Иван"));
    expect(r.text.indexOf("-- \nИван")).toBeLessThan(r.text.indexOf("пишет:"));
    expect(withSignature(emptyDraft(me), sig("  ")).text).toBe("");
    expect(withSignature(emptyDraft(me), null).text).toBe("");
  });

  it("is swapped when the sender changes", () => {
    const text = withSignature(reply(msg(), me, false), sig("Старая")).text;
    const swapped = putSignatureText(text, sig("Новая"));
    expect(swapped).toContain("-- \nНовая");
    expect(swapped).not.toContain("Старая");
    expect(swapped.indexOf("Новая")).toBeLessThan(swapped.indexOf("пишет:"));
    const added = putSignatureText(reply(msg(), me, false).text, sig("Добавлена"));
    expect(added.indexOf("Добавлена")).toBeLessThan(added.indexOf("пишет:"));
    expect(putSignatureText("Текст\n\n-- \nСтарая", null)).toBe("Текст");
  });

  it("an untouched signature is not a draft", () => {
    const d = withSignature(emptyDraft(me), sig("Иван"));
    expect(isDirty(d)).toBe(false);
    expect(isDirty({ ...d, text: "Привет" + d.text })).toBe(true);
  });
});

describe("formats", () => {
  const html = (over: Partial<OpenedMessage["view"]> = {}): OpenedMessage => {
    const m = msg();
    return { ...m, view: { ...m.view, html: "<p>Добрый <b>день</b>!</p><img src=\"data:image/png;base64,AAAA\">", ...over } };
  };
  // What the backend does with Markdown, as far as these tests look.
  const md = async (text: string) => `<p>${text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`;

  it("takes the mailbox's format, else the settings'", () => {
    expect(formatFor({ compose_format: "markdown" }, { compose_format: "html" })).toBe("markdown");
    expect(formatFor({ compose_format: null }, { compose_format: "html" })).toBe("html");
    expect(formatFor(undefined, { compose_format: "plain" })).toBe("plain");
  });

  it("a new HTML letter has the signature in its own block, below an empty line", () => {
    const d = withSignature(emptyDraft(me, "html"), sig("Иван\nотдел ИТ"));
    expect(d.html).toBe('<div><br></div><div class="depesha-signature"><div>Иван</div><div>отдел ИТ</div></div>');
    // Its plain version has the separator, though the HTML shows none.
    expect(d.text).toBe("\n-- \nИван\nотдел ИТ");
    expect(isDirty(d)).toBe(false);
    expect(isDirty({ ...d, html: "<div>Привет</div>" + d.html })).toBe(true);
  });

  it("an HTML reply quotes the letter with its formatting, the signature above the quote", () => {
    const d = withSignature(reply(html(), me, false, "html"), sig("Влад"));
    expect(d.format).toBe("html");
    const { head, quote } = splitHtmlQuote(d.html ?? "");
    expect(head).toContain("depesha-signature");
    expect(quote).toContain("<b>день</b>");
    expect(quote).toContain("<blockquote");
    // Its pictures go back inside the answer.
    expect(quote).toContain("data:image/png");
    expect(d.text).toContain("\n-- \nВлад\n\n");
    expect(d.text).toContain("> Добрый день!");
    // As in plain text, the quote follows an empty line: the checks before sending skip it.
    expect(reply(html(), me, false, "html").text.startsWith("\n\n")).toBe(true);
    // A plain-text letter is quoted as text in HTML too.
    expect(reply(msg(), me, false, "html").html).toContain("Добрый день!");
  });

  it("a plain or Markdown reply quotes with > as before", () => {
    for (const format of ["plain", "markdown"] as const) {
      const d = reply(html(), me, false, format);
      expect(d.html).toBeNull();
      expect(d.text).toContain("> Добрый день!");
    }
  });

  it("an HTML forward carries the letter below its header", () => {
    const d = withSignature(forward(html(), me, "html"), sig("Влад"));
    const { head, quote } = splitHtmlQuote(d.html ?? "");
    expect(head).toContain("Влад");
    expect(quote).toContain("Пересылаемое сообщение");
    expect(quote).toContain("<b>день</b>");
  });

  it("the signature of an HTML letter is swapped in its block", () => {
    const d = withSignature(reply(html(), me, false, "html"), sig("Старая"));
    const swapped = putSignatureHtml(d.html ?? "", sig("Новая"));
    expect(swapped).toContain("Новая");
    expect(swapped).not.toContain("Старая");
    expect(swapped.indexOf("Новая")).toBeLessThan(swapped.indexOf("depesha-quote"));
    expect(putSignatureHtml(swapped, null)).not.toContain("depesha-signature");
    const added = putSignatureHtml(reply(html(), me, false, "html").html ?? "", sig("Добавлена"));
    expect(added.indexOf("Добавлена")).toBeLessThan(added.indexOf("depesha-quote"));
  });

  it("a draft opens in the format it was written in", () => {
    const view = (over: Partial<OpenedMessage["view"]>) => ({ ...msg(), view: { ...msg().view, ...over } });
    const h = fromDraft(view({ format: "html", html: "<div><b>да</b></div>", text: "да" }), me);
    expect([h.format, h.html, h.text]).toEqual(["html", "<div><b>да</b></div>", "да"]);
    const m = fromDraft(view({ format: "markdown", html: "<p><strong>да</strong></p>", text: "**да**\r\n" }), me);
    expect([m.format, m.html, m.text]).toEqual(["markdown", null, "**да**\n"]);
    expect(fromDraft(view({ html: "<p>чужой</p>", text: "чужой" }), me).format).toBe("html");
    expect(fromDraft(view({}), me).format).toBe("plain");
  });

  it("asks only before HTML with formatting becomes plain text", () => {
    const plain = withSignature(emptyDraft(me, "html"), sig("Влад"));
    expect(losesFormatting(plain, "plain")).toBe(false);
    expect(losesFormatting({ ...plain, html: "<div><b>да</b></div>" + plain.html }, "plain")).toBe(true);
    expect(losesFormatting({ ...plain, html: '<div><img src="data:image/png;base64,AA"></div>' }, "plain")).toBe(true);
    expect(losesFormatting({ ...plain, html: "<div><b>да</b></div>" }, "markdown")).toBe(false);
    // Markdown is plain text already.
    expect(losesFormatting({ ...emptyDraft(me, "markdown"), text: "**да**" }, "plain")).toBe(false);
  });

  it("does not ask for the quote's style or the signature's picture", () => {
    const logo = { ...sig("Влад"), html: '<div><img src="data:image/png;base64,LOGO"></div>' };
    const d = withSignature(reply(html(), me, false, "html"), logo);
    expect(losesFormatting({ ...d, html: "<div>Да</div>" + (d.html ?? "") }, "plain")).toBe(false);
    expect(losesFormatting({ ...d, html: "<div><i>Да</i></div>" + (d.html ?? "") }, "plain")).toBe(true);
  });

  it("HTML becomes plain text with the same words, signature and quote", async () => {
    const d = withSignature(reply(html(), me, false, "html"), sig("Влад"));
    const typed = { ...d, html: "<div>Ответ <b>жирный</b></div>" + (d.html ?? "") };
    const plain = await convertDraft(typed, "plain", sig("Влад"), md);
    expect(plain.format).toBe("plain");
    expect(plain.html).toBeNull();
    const { head, quote } = splitQuote(plain.text);
    expect(head).toBe("Ответ жирный\n\n-- \nВлад");
    expect(quote).toContain("пишет:\n> Добрый день!");
    // The signature is found again: changing the sender replaces it.
    expect(putSignatureText(plain.text, sig("Иван"))).not.toContain("Влад");
  });

  it("the quote of an HTML reply is part of the letter, under the signature", async () => {
    const d = withSignature(reply(html(), me, false, "html"), sig("Влад"));
    // One piece of HTML: the empty line to type in, the signature, the quote with its formatting.
    expect(d.html?.startsWith('<div><br></div><div class="depesha-signature">')).toBe(true);
    expect(d.html).toMatch(/depesha-signature[\s\S]*<div class="depesha-quote">[\s\S]*<blockquote[^>]*><p>Добрый <b>день<\/b>!<\/p>/);
    // Answered between the lines of the quote: the answer is kept in any format.
    const between = { ...d, html: (d.html ?? "").replace("</blockquote>", "</blockquote><div>Согласна.</div>") };
    const plain = await convertDraft(between, "plain", sig("Влад"), md);
    expect(plain.text).toContain("> Добрый день!\n\nСогласна.");
    // A draft opens with the quote where it was.
    const view = { ...msg(), view: { ...msg().view, format: "html" as const, html: between.html ?? "", text: between.text } };
    const back = fromDraft(view, me);
    expect(back.html).toBe(between.html);
    expect(back.text).toBe(htmlLetterText(between.html ?? ""));
    expect(back.text).toMatch(/\n\n\S+ \S+, Иван/);
  });

  it("keeps the header of a quote with no text apart from the signature", async () => {
    const d = withSignature(reply(html({ html: '<img src="data:image/png;base64,AAAA">' }), me, false, "html"), sig("Влад"));
    const plain = await convertDraft({ ...d, html: "<div>Смотрю</div>" + (d.html ?? "") }, "plain", sig("Влад"), md);
    expect(plain.parts?.body).toBe("Смотрю");
    expect(plain.parts?.rest).toMatch(/^\n\n.*Иван <ivan@example.org> пишет:\n$/);
    expect(plain.text).toBe(plain.parts?.body + "\n\n-- \nВлад" + plain.parts?.rest);
  });

  it("HTML becomes Markdown with its formatting", async () => {
    const d = { ...emptyDraft(me, "html"), html: "<div><b>жирный</b></div><ul><li>раз</li></ul>" };
    expect((await convertDraft(d, "markdown", null, md)).text).toBe("**жирный**\n\n- раз");
  });

  it("plain text and Markdown become HTML with the signature in its block and the quote folded", async () => {
    const r = withSignature(reply(msg(), me, false, "plain"), sig("Влад"));
    const typed = { ...r, text: "Да, <согласен>" + r.text };
    const h = await convertDraft(typed, "html", sig("Влад"), md);
    expect(h.format).toBe("html");
    const { head, quote } = splitHtmlQuote(h.html ?? "");
    expect(head).toBe('<div>Да, &lt;согласен&gt;</div><div class="depesha-signature"><div>Влад</div></div>');
    expect(quote).toContain("<blockquote");
    expect(htmlToText(quote)).toContain("> Добрый день!");

    const m = await convertDraft({ ...emptyDraft(me, "markdown"), text: "**жирный**" }, "html", null, md);
    expect(m.html).toBe("<p><strong>жирный</strong></p>");
    // An empty letter keeps its empty line above the signature.
    expect((await convertDraft(withSignature(emptyDraft(me), sig("Влад")), "html", sig("Влад"), md)).html).toBe(
      '<div><br></div><div class="depesha-signature"><div>Влад</div></div>',
    );
  });

  it("plain text and Markdown keep their words when switched", async () => {
    const d = withSignature({ ...emptyDraft(me, "markdown"), text: "**да**" }, sig("Влад"));
    const plain = await convertDraft(d, "plain", sig("Влад"), md);
    expect(plain.text).toBe("**да**\n\n-- \nВлад");
    expect((await convertDraft(plain, "markdown", sig("Влад"), md)).text).toBe(plain.text);
  });

  it("the signature's picture is not attached when the letter becomes Markdown", async () => {
    const logo = "data:image/png;base64,LOGO";
    const bodyPic = "data:image/png;base64,BODY";
    const withLogo = { ...sig("Влад"), html: `<div><img src="${logo}"></div>`, text: "" };
    const html = `<div><img src="${bodyPic}"></div>` + sigHtml(withLogo);
    // What the window does before converting: only the letter's own picture is taken.
    const { html: kept, pictures } = takeBodyPictures(html);
    expect(pictures).toEqual([{ mime: "image/png", base64: "BODY" }]);
    expect(kept).toContain(logo);
    expect(kept).not.toContain(bodyPic);
    // Converting: the body becomes text, the signature is put by `sigBlock` (none here).
    const md2 = await convertDraft({ ...emptyDraft(me, "html"), html: kept }, "markdown", withLogo, md);
    expect(md2.text).not.toContain("data:");
    // Back to HTML the signature is put again, once, as `sigHtml` has it: no duplicate.
    const back = await convertDraft(md2, "html", withLogo, md);
    expect(back.html?.match(/depesha-signature/g)?.length).toBe(1);
    expect(back.html?.match(/data:image\/png;base64,LOGO/g)?.length).toBe(1);
  });
});
