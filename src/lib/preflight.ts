// Checks before sending: the mistakes people regret a second after "Send".

import { t, tn } from "./i18n.svelte";
import type { ComposeDraft } from "./types";

/** Mail providers where a shared domain says nothing about being colleagues. */
const PUBLIC = new Set([
  "gmail.com", "googlemail.com", "yandex.ru", "ya.ru", "yandex.com", "mail.ru", "bk.ru", "list.ru", "inbox.ru",
  "internet.ru", "rambler.ru", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "yahoo.com",
  "proton.me", "protonmail.com", "gmx.com", "gmx.de", "zoho.com", "aol.com",
]);

const MENTIONS_FILE = /(во вложени|в приложени|прилага|прикрепл|приложил|приложен|attach|enclosed|see the file)/i;
const QUOTE = /\n\n[^\n]*(пишет:|wrote:|-------- Пересылаемое сообщение|-------- Forwarded message)/;

/** What the user wrote: without the quote and the signature. */
export function ownText(text: string): string {
  let t = text;
  const q = t.search(QUOTE);
  if (q >= 0) t = t.slice(0, q);
  const sig = t.indexOf("\n-- \n");
  if (sig >= 0) t = t.slice(0, sig);
  return t.trimEnd();
}

function domain(email: string): string {
  return email.split("@").pop()?.toLowerCase().trim() ?? "";
}

export interface Warning {
  kind: "attachment" | "external" | "many" | "subject";
  text: string;
}

export function preflight(d: ComposeDraft, myEmail: string): Warning[] {
  const out: Warning[] = [];
  if (d.attachments.length === 0 && MENTIONS_FILE.test(ownText(d.text))) {
    out.push({ kind: "attachment", text: t("preflight.attachment") });
  }
  const all = [...d.to, ...d.cc, ...d.bcc];
  const mine = domain(myEmail);
  if (mine && !PUBLIC.has(mine)) {
    const inside = all.filter((a) => domain(a.email) === mine);
    const outside = [...new Set(all.map((a) => domain(a.email)).filter((x) => x && x !== mine))];
    // Colleagues and outsiders on one letter is how internal talk leaks.
    if (inside.length > 0 && outside.length > 0) {
      out.push({ kind: "external", text: t("preflight.external", { domains: outside.join(", ") }) });
    }
  }
  if (all.length > 10) out.push({ kind: "many", text: tn("preflight.many", all.length) });
  if (!d.subject.trim()) out.push({ kind: "subject", text: t("preflight.subject") });
  return out;
}
