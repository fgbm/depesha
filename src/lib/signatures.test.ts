import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import { emptyDraft, forward, isDirty, reply } from "./compose";
import { htmlToText } from "./richtext";
import {
  SIGNATURE_WARN,
  addSignature,
  defaultSignature,
  isHeavy,
  moveSignature,
  previewLine,
  putSignatureHtml,
  putSignatureText,
  removeSignature,
  replySignature,
  sigBlock,
  signatureIn,
  signatureShown,
  signatureText,
  splitPlain,
  withSignature,
} from "./signatures";
import type { OpenedMessage, Signature } from "./types";
import { rowDefaults, summaryDefaults } from "./testing";

const me = { name: "Мария", email: "maria@example.com" };
const LOGO = "data:image/png;base64,iVBORw0KGgo=";

const work: Signature = {
  id: "w",
  name: "Рабочая",
  html: `<div><img src="${LOGO}"> <b>Мария Соколова</b></div><div>+7 495 000-00-00 · <a href="https://example.com">example.com</a></div>`,
  text: "Мария Соколова\n+7 495 000-00-00 · example.com <https://example.com>",
};
const short: Signature = { id: "s", name: "Короткая", html: "<div>Мария, ООО «Север»</div>", text: "Мария, ООО «Север»" };
const personal: Signature = { id: "p", name: "Личная", html: "<div>Маша</div><div>maria@example.org</div>", text: "Маша\nmaria@example.org" };

const workBox = { signatures: [work, short], default_signature: "w" };
const homeBox = { signatures: [personal], default_signature: "p" };

function msg(): OpenedMessage {
  const summary = {
    message_id: "m2@example.org", in_reply_to: null, references: [], subject: "Смета",
    from: { name: "Иван", email: "ivan@example.org" }, to: [me], cc: [], reply_to: [], date: 1790000000,
    has_attachments: false, bulk: false, unsubscribe: null, ...summaryDefaults,
  };
  return {
    row: { id: 7, account_id: "a", folder: "INBOX", uid: 1, message_id: summary.message_id, in_reply_to: null, references: [],
      subject: summary.subject, from: summary.from, to: summary.to, cc: [], reply_to: [], date: 1790000000, size: 1,
      flags: { seen: true, answered: false, flagged: false, draft: false, deleted: false, forwarded: false, answered_all: false }, has_attachments: false,
      thread: "m2@example.org", bulk: false, thread_count: 1, thread_date: 0, thread_senders: [], thread_draft: false, snoozed_until: null, followup_due: null, ...rowDefaults },
    view: { summary, text: "Добрый день!", html: "<p>Добрый <b>день</b>!</p>", has_remote_content: false, authenticated: false, attachments: [], send_at: null, format: null, acts_on: null, markdown: null, views: ["text"], },
    trusted_sender: false,
    sender_unverified: false,
  };
}

beforeEach(() => {
  i18n.lang = "ru";
});

describe("the list in the settings", () => {
  it("has a default one, or none", () => {
    expect(defaultSignature(workBox)?.id).toBe("w");
    expect(defaultSignature({ signatures: [work], default_signature: null })).toBeNull();
    expect(defaultSignature({ signatures: [work], default_signature: "gone" })).toBeNull();
    expect(defaultSignature(undefined)).toBeNull();
  });

  it("a reply signature is its own when set, else the plain default", () => {
    expect(replySignature(workBox)?.id).toBe("w");
    expect(replySignature({ ...workBox, reply_signature: "s" })?.id).toBe("s");
    // A gone reply signature reads as "not set": the plain default comes back.
    expect(replySignature({ ...workBox, reply_signature: "gone" })?.id).toBe("w");
    expect(replySignature({ ...workBox, reply_signature: "gone", default_signature: null })).toBeNull();
    expect(replySignature(undefined)).toBeNull();
    expect(replySignature({ signatures: [work], reply_signature: "w" })?.id).toBe("w");
  });

  it("the first one added becomes the default; later ones do not", () => {
    const one = addSignature({ list: [], defaultId: null, replyId: null }, "Подпись 1");
    expect(one.defaultId).toBe(one.id);
    const two = addSignature(one, "Подпись 2");
    expect(two.list.map((s) => s.name)).toEqual(["Подпись 1", "Подпись 2"]);
    expect(two.defaultId).toBe(one.id);
    expect(two.replyId).toBeNull();
    expect(new Set(two.list.map((s) => s.id)).size).toBe(2);
  });

  it("deleting the default makes the first one left the default; deleting all leaves none", () => {
    const state = { list: [work, short, personal], defaultId: "s", replyId: "p" };
    expect(removeSignature(state, "s")).toEqual({ list: [work, personal], defaultId: "w", replyId: "p" });
    expect(removeSignature(state, "p").replyId).toBeNull();
    expect(removeSignature({ list: [work], defaultId: "w", replyId: "w" }, "w")).toEqual({ list: [], defaultId: null, replyId: null });
  });

  it("moves up and down, and stays at the ends", () => {
    const list = [work, short, personal];
    expect(moveSignature(list, "p", -1).map((s) => s.id)).toEqual(["w", "p", "s"]);
    expect(moveSignature(list, "w", 1).map((s) => s.id)).toEqual(["s", "w", "p"]);
    expect(moveSignature(list, "w", -1)).toBe(list);
    expect(moveSignature(list, "p", 1)).toBe(list);
  });

  it("shows a signature in one line", () => {
    expect(previewLine(work)).toBe("Мария Соколова · +7 495 000-00-00 · example.com <https://example.com>");
  });
});

describe("the text version", () => {
  it("keeps the words and the links with their addresses, no pictures", () => {
    const text = signatureText(work.html);
    expect(text).toBe("Мария Соколова\n+7 495 000-00-00 · example.com <https://example.com>");
    expect(text).not.toContain("data:");
  });

  it("an HTML letter's plain part has the separator before the signature, none for pictures alone", () => {
    const d = withSignature(emptyDraft(me, "html"), work);
    expect(d.text).toBe(`\n-- \n${work.text}`);
    const picture = { ...work, html: `<div><img src="${LOGO}"></div>`, text: "" };
    expect(htmlToText(`<div>Да</div><div class="depesha-signature">${picture.html}</div>`)).toBe("Да");
  });

  it("warns about pictures over 200 KB", () => {
    const big = `<img src="data:image/png;base64,${"A".repeat(Math.ceil(((SIGNATURE_WARN + 1024) * 4) / 3))}">`;
    expect(isHeavy(work.html)).toBe(false);
    expect(isHeavy(big)).toBe(true);
  });
});

describe("the signature in a letter", () => {
  it("an untouched signature with a picture does not make the letter worth keeping", () => {
    expect(isDirty(withSignature(emptyDraft(me, "html"), work))).toBe(false);
    expect(isDirty(withSignature(emptyDraft(me, "plain"), work))).toBe(false);
  });

  it("a letter in text or Markdown gets the text version under -- , without pictures", () => {
    for (const format of ["plain", "markdown"] as const) {
      const d = withSignature(emptyDraft(me, format), work);
      expect(d.html).toBeNull();
      expect(d.text).toBe(`\n\n-- \n${work.text}`);
      expect(d.text).not.toContain("<img");
    }
  });

  it("a Markdown letter carries the signature's HTML beside its text", () => {
    const d = withSignature(emptyDraft(me, "markdown"), work);
    // The text keeps the plain version (what the plain part goes out as).
    expect(d.text).toBe(`\n\n-- \n${work.text}`);
    // The HTML goes with the letter: the window shows it formatted (frame 13 of #45) and
    // the backend builds the HTML and Markdown parts from it (#67).
    expect(d.signature).toBe(`<div class="depesha-signature">${work.html}</div>`);
    // No signature takes it away again.
    expect(withSignature(d, null).signature).toBeNull();
  });

  it("shows the signature formatted in an HTML and Markdown letter, as text in a plain one", () => {
    expect(signatureShown("markdown", work)).toEqual({ html: work.html });
    expect(signatureShown("html", work)).toEqual({ html: work.html });
    expect(signatureShown("plain", work)).toEqual({ text: sigBlock(work).replace(/^\n\n/, "") });
    expect(signatureShown("markdown", null)).toBeNull();
    // A signature of pictures alone has no text to show; the Markdown window shows it whole.
    const logo: Signature = { id: "l", name: "Логотип", html: `<div><img src="${LOGO}"></div>`, text: "" };
    const shown = signatureShown("markdown", logo);
    expect(shown && "html" in shown && shown.html).toBeTruthy();
  });

  it("choosing another one replaces the block, the text above stays", () => {
    const d = withSignature(reply(msg(), me, false, "html"), work);
    const typed = `<div>Смету посмотрела.</div>${d.html}`;
    const swapped = putSignatureHtml(typed, short);
    expect(swapped.startsWith("<div>Смету посмотрела.</div>")).toBe(true);
    expect(swapped).toContain("Мария, ООО «Север»");
    expect(swapped).not.toContain(LOGO);
    expect(swapped.match(/depesha-signature/g)?.length).toBe(1);
    expect(swapped.indexOf("depesha-signature")).toBeLessThan(swapped.indexOf("depesha-quote"));
    // "No signature" takes the block away whole; another one puts it back above the quote.
    const none = putSignatureHtml(swapped, null);
    expect(none).not.toContain("depesha-signature");
    expect(none.startsWith("<div>Смету посмотрела.</div>")).toBe(true);
    const back = putSignatureHtml(none, work);
    expect(back.indexOf("depesha-signature")).toBeLessThan(back.indexOf("depesha-quote"));
  });

  it("the same in a plain letter, a reply and a forward", () => {
    const r = withSignature(reply(msg(), me, false), work);
    const typed = `Да.${r.text}`;
    const swapped = putSignatureText(typed, short);
    expect(swapped.startsWith("Да.\n\n-- \nМария, ООО «Север»\n\n")).toBe(true);
    expect(swapped).toContain("пишет:\n> Добрый день!");
    expect(putSignatureText(swapped, null).startsWith("Да.\n\n")).toBe(true);
    expect(putSignatureText(swapped, null)).not.toContain("-- ");
    const f = withSignature(forward(msg(), me), work);
    expect(f.text.indexOf("-- \nМария")).toBeLessThan(f.text.indexOf("Пересылаемое"));
    expect(splitPlain(f.text)).toMatchObject({ body: "", signature: work.text });
  });

  it("another sender puts its default signature, even over one chosen by hand", () => {
    // What the window does on a sender change: the new mailbox's default in place of the block.
    const chosen = putSignatureHtml(withSignature(emptyDraft(me, "html"), work).html ?? "", short);
    const moved = putSignatureHtml(chosen, defaultSignature(homeBox));
    expect(moved).toContain("maria@example.org");
    expect(moved).not.toContain("Короткая");
    expect(moved).not.toContain("ООО «Север»");
    expect(moved.match(/depesha-signature/g)?.length).toBe(1);
    // A mailbox without signatures leaves the letter without one.
    expect(putSignatureHtml(moved, defaultSignature({ signatures: [] }))).not.toContain("depesha-signature");
    const plain = putSignatureText(putSignatureText(withSignature(emptyDraft(me), work).text, short), defaultSignature(homeBox));
    expect(plain).toBe("\n\n-- \nМаша\nmaria@example.org");
  });

  it("finds which of the mailbox's signatures a letter has, or keeps a letter's own", () => {
    expect(signatureIn(withSignature(emptyDraft(me, "html"), short), workBox.signatures)?.id).toBe("s");
    expect(signatureIn(withSignature(emptyDraft(me), work), workBox.signatures)?.id).toBe("w");
    expect(signatureIn(emptyDraft(me, "html"), workBox.signatures)).toBeNull();
    expect(signatureIn(emptyDraft(me), workBox.signatures)).toBeNull();
    // Changed since in the settings, or another program's: kept as the letter has it.
    const own = signatureIn({ ...emptyDraft(me), text: "Да\n\n-- \nСтарая подпись" }, workBox.signatures);
    expect(own).toMatchObject({ id: "", text: "Старая подпись" });
    // A signature of a letter before #25 (with the separator in the HTML) is found too.
    const old = signatureIn({ ...emptyDraft(me, "html"), html: '<div>Да</div><div class="depesha-signature">-- <br>Мария, ООО «Север»</div>' }, workBox.signatures);
    expect(old?.id).toBe("s");
  });

  it("tells one image-only signature from another by its HTML", () => {
    const picture = (src: string): Signature => ({ id: src, name: src, html: `<div><img src="${src}"></div>`, text: "" });
    const first = picture("data:image/png;base64,AAAA");
    const second = picture("data:image/png;base64,BBBB");
    const list = [first, second];
    // No words to match: the HTML decides, not the first image-only one in the list.
    expect(signatureIn(withSignature(emptyDraft(me, "html"), second), list)?.id).toBe(second.id);
    expect(signatureIn(withSignature(emptyDraft(me, "html"), first), list)?.id).toBe(first.id);
  });

  it("finds an image-only signature of a Markdown draft by its HTML part", () => {
    // A Markdown letter keeps its signature's HTML apart (decision on #67): a picture-only
    // one has no "-- " in the text, so the block itself is what says which it is.
    const logo: Signature = { id: "l", name: "Логотип", html: `<div><img src="${LOGO}"></div>`, text: "" };
    const d = withSignature(emptyDraft(me, "markdown"), logo);
    expect(d.text).not.toContain("-- ");
    expect(d.signature).toBe(`<div class="depesha-signature">${logo.html}</div>`);
    expect(signatureIn(d, [logo])?.id).toBe("l");
    // A draft opened from the server carries the same block; a changed one is kept as it is.
    const opened = { ...emptyDraft(me, "markdown"), signature: `<div class="depesha-signature">${logo.html}</div>` };
    expect(signatureIn(opened, [logo])?.id).toBe("l");
    expect(signatureIn(opened, [work])?.html).toBe(logo.html);
  });
});
