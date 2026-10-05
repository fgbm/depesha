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
  signatureIn,
  signatureText,
  splitPlain,
  withSignature,
} from "./signatures";
import type { OpenedMessage, Signature } from "./types";

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
    has_attachments: false, bulk: false, unsubscribe: null,
  };
  return {
    row: { id: 7, account_id: "a", folder: "INBOX", uid: 1, message_id: summary.message_id, in_reply_to: null, references: [],
      subject: summary.subject, from: summary.from, to: summary.to, cc: [], reply_to: [], date: 1790000000, size: 1,
      flags: { seen: true, answered: false, flagged: false, draft: false, deleted: false }, has_attachments: false,
      thread: "m2@example.org", bulk: false, thread_count: 1, thread_date: 0, thread_senders: [], thread_draft: false, snoozed_until: null, followup_due: null },
    view: { summary, text: "Добрый день!", html: "<p>Добрый <b>день</b>!</p>", has_remote_content: false, authenticated: false, attachments: [] },
    trusted_sender: false,
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

  it("the first one added becomes the default; later ones do not", () => {
    const one = addSignature({ list: [], defaultId: null }, "Подпись 1");
    expect(one.defaultId).toBe(one.id);
    const two = addSignature(one, "Подпись 2");
    expect(two.list.map((s) => s.name)).toEqual(["Подпись 1", "Подпись 2"]);
    expect(two.defaultId).toBe(one.id);
    expect(new Set(two.list.map((s) => s.id)).size).toBe(2);
  });

  it("deleting the default makes the first one left the default; deleting all leaves none", () => {
    const state = { list: [work, short, personal], defaultId: "s" };
    expect(removeSignature(state, "s")).toEqual({ list: [work, personal], defaultId: "w" });
    expect(removeSignature(state, "p").defaultId).toBe("s");
    expect(removeSignature({ list: [work], defaultId: "w" }, "w")).toEqual({ list: [], defaultId: null });
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
});
