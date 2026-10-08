import { beforeEach, describe, expect, it } from "vitest";
import { i18n, t, tn } from "./i18n.svelte";
import { en } from "./locales/en";
import { ru } from "./locales/ru";
import { forward, reply, emptyDraft } from "./compose";
import { putSignatureText, splitPlain, withSignature } from "./signatures";
import { when } from "./later";
import { size } from "./format";
import type { OpenedMessage } from "./types";

const me = { name: "Jane", email: "jane@corp.example" };

function msg(): OpenedMessage {
  const summary = {
    message_id: "m1@x", in_reply_to: null, references: [], subject: "Budget", date: 1790000000,
    from: { name: "Bob", email: "bob@x.example" }, to: [me], cc: [], reply_to: [], has_attachments: false,
    bulk: false, unsubscribe: null,
  };
  return {
    row: { id: 1, account_id: "a", folder: "INBOX", uid: 1, message_id: "m1@x", in_reply_to: null, references: [],
      subject: "Budget", from: summary.from, to: [me], cc: [], reply_to: [], date: 1790000000, size: 1,
      flags: { seen: true, answered: false, flagged: false, draft: false, deleted: false }, has_attachments: false,
      thread: "m1@x", bulk: false, thread_count: 1, thread_date: 0, thread_senders: [], thread_draft: false, snoozed_until: null, followup_due: null },
    view: { summary, text: "Numbers attached.", html: null, has_remote_content: false, authenticated: false, attachments: [] },
    trusted_sender: false,
  };
}

beforeEach(() => {
  i18n.lang = "en";
});

describe("dictionaries", () => {
  it("translate every key, with the same placeholders", () => {
    const holes = (v: unknown) => JSON.stringify(v).match(/\{\w+\}/g)?.filter((h) => h !== "{n}").sort() ?? [];
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(ru[key], key).toBeTruthy();
      expect([...new Set(holes(ru[key]))], key).toEqual([...new Set(holes(en[key]))]);
    }
  });

  it("choose plural forms by language", () => {
    expect(tn("count.messages", 1)).toBe("1 message");
    expect(tn("count.messages", 5)).toBe("5 messages");
    i18n.lang = "ru";
    expect([1, 3, 5, 21, 11].map((n) => tn("count.messages", n))).toEqual(["1 письмо", "3 письма", "5 писем", "21 письмо", "11 писем"]);
    expect(t("toast.sent", { subject: "x" })).toBe("Отправлено: x");
  });
});

describe("English mail text", () => {
  it("quotes and forwards in English, and the signature finds an English quote", () => {
    const r = reply(msg(), me, false);
    expect(r.text).toMatch(/\nOn .+, Bob <bob@x\.example> wrote:\n> Numbers attached\./);
    const f = forward(msg(), me);
    expect(f.text).toContain("-------- Forwarded message --------\nSubject: Budget");
    const jane = { id: "s1", name: "Jane", html: "Jane", text: "Jane" };
    const swapped = putSignatureText(r.text, jane);
    expect(swapped.indexOf("-- \nJane")).toBeLessThan(swapped.indexOf("wrote:"));
    // The English forward header is told apart from what is typed too.
    expect(splitPlain(f.text)).toMatchObject({ body: "", signature: null });
    expect(putSignatureText(f.text, jane).indexOf("-- \nJane")).toBeLessThan(putSignatureText(f.text, jane).indexOf("Forwarded"));
    expect(withSignature(emptyDraft(me), { ...jane, text: "J" }).text).toBe("\n\n-- \nJ");
  });

  it("names times and sizes in English", () => {
    const now = new Date(2026, 9, 2, 10, 0);
    expect(when(new Date(2026, 9, 3, 9, 0).getTime() / 1000, now)).toBe("tomorrow at 09:00");
    expect(size(1536 * 1024)).toBe("1.5 MB");
    i18n.lang = "ru";
    expect(size(1536 * 1024)).toBe("1,5 МБ");
  });
});
