// What the tests of the plugin share: the words in one language, a sent letter, a wait.

import type { FollowupInfo, MessageRow, PluralForms, Text } from "@depesha/plugin-api";
import type { Say } from "./labels";

/** The plugin's words in `lang`, as the context gives them. */
export function sayIn(lang: "en" | "ru"): Say {
  return {
    t: (text: Text, params: Record<string, string | number> = {}) =>
      text[lang].replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)),
    plural: (n: number, forms: { en: PluralForms; ru: PluralForms }) => {
      const set = forms[lang];
      const cat = new Intl.PluralRules(lang).select(n) as keyof PluralForms;
      return (set[cat] ?? set.other).replace("{n}", String(n));
    },
  };
}

export function wait(f: Partial<FollowupInfo> = {}): FollowupInfo {
  return {
    status: "waiting",
    due: 500,
    deadline: 500,
    own_deadline: false,
    repeat_secs: 0,
    expect: "",
    kind: "",
    ended: null,
    answered_by: null,
    answer: null,
    reminded: [],
    sent: 50,
    park: "",
    park_folder: "",
    auto_reply: null,
    ...f,
  };
}

/** A letter in Sent to Ivan and Maria, with its wait. */
export function letter(f: FollowupInfo | null): MessageRow {
  return {
    id: 1,
    account_id: "a",
    folder: "Sent",
    uid: 1,
    message_id: "q@example.org",
    in_reply_to: null,
    references: [],
    subject: "Смета",
    from: { name: "Кэрол", email: "carol@example.org" },
    to: [{ name: "Иван Петров", email: "Ivan@example.org" }],
    cc: [{ name: "Мария Соколова", email: "maria@example.org" }],
    reply_to: [],
    date: 100,
    size: 1,
    flags: { seen: true, answered: false, flagged: false, draft: false, deleted: false, forwarded: false, answered_all: false },
    has_attachments: false,
    thread: "q@example.org",
    bulk: false,
    thread_count: 1,
    thread_date: 100,
    thread_senders: [],
    thread_draft: false,
    snoozed_until: null,
    followup_due: f?.status === "waiting" ? f.due : null,
    followup: f,
    thread_size: 1,
    marks: [],
    my_answer: null,
    outgoing: null,
    answer_came: false,
    dmarc: false,
    importance: "normal",
    thread_voices: [],
  };
}

/** A letter from Maria in the inbox, answered or not. */
export function incoming(over: Partial<MessageRow> = {}): MessageRow {
  return {
    ...letter(null),
    id: 2,
    folder: "INBOX",
    message_id: "m@example.org",
    subject: "Счёт за сентябрь",
    from: { name: "Мария Соколова", email: "maria@example.org" },
    to: [{ name: "Кэрол", email: "carol@example.org" }],
    cc: [],
    ...over,
  };
}
