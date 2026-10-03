import { describe, expect, it } from "vitest";
import { emptyDraft, forward, isDirty, forwardSubject, reply, replySubject, swapSignature, withSignature } from "./compose";
import { linkify, parseAddr, pluralRu } from "./format";
import type { OpenedMessage } from "./types";

const me = { name: "Влад", email: "me@example.com" };

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
      thread: "m1@example.org", bulk: false, thread_count: 1, snoozed_until: null, followup_due: null },
    view: {
      summary,
      text: "Добрый день!\n> старая цитата",
      html: null,
      has_remote_content: false,
      attachments: [
        { index: 0, name: "счёт.pdf", mime: "application/pdf", size: 10, content_id: null, inline: false },
        { index: 1, name: "logo.png", mime: "image/png", size: 5, content_id: "logo", inline: true },
      ],
    },
    trusted_sender: false,
  };
}

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

describe("forward", () => {
  it("keeps real attachments, drops inline images", () => {
    const d = forward(msg(), me);
    expect(d.subject).toBe("Fwd: Счёт");
    expect(d.to).toEqual([]);
    expect(d.attachments).toEqual([{ kind: "message", id: 7, index: 0, name: "счёт.pdf", size: 10 }]);
    expect(d.text).toContain("Пересылаемое сообщение");
    expect(d.text).toContain("Добрый день!");
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
    expect(withSignature(emptyDraft(me), "Иван\nотдел ИТ").text).toBe("\n\n-- \nИван\nотдел ИТ");
    const r = withSignature(reply(msg(), me, false), "Иван");
    expect(r.text.indexOf("-- \nИван")).toBeLessThan(r.text.indexOf("пишет:"));
    expect(withSignature(emptyDraft(me), "  ").text).toBe("");
  });

  it("is swapped when the sender changes", () => {
    const text = withSignature(reply(msg(), me, false), "Старая").text;
    const swapped = swapSignature(text, "Старая", "Новая");
    expect(swapped).toContain("-- \nНовая");
    expect(swapped).not.toContain("Старая");
    expect(swapped.indexOf("Новая")).toBeLessThan(swapped.indexOf("пишет:"));
    const added = swapSignature(reply(msg(), me, false).text, "", "Добавлена");
    expect(added.indexOf("Добавлена")).toBeLessThan(added.indexOf("пишет:"));
    expect(swapSignature("Текст\n\n-- \nСтарая", "Старая", "")).toBe("Текст");
  });

  it("an untouched signature is not a draft", () => {
    expect(isDirty(withSignature(emptyDraft(me), "Иван"), "Иван")).toBe(false);
    expect(isDirty({ ...withSignature(emptyDraft(me), "Иван"), text: "Привет" + withSignature(emptyDraft(me), "Иван").text }, "Иван")).toBe(true);
  });
});
