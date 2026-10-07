// What was done with a letter, as the list and the letter's header say it (#55): an icon
// per act before the date, a reply and a reply to all as one (the fuller), the forward after
// them; the time when Depesha did it, "server mark, time unknown" when only the server says
// so. Pure, covered by marks.test.ts.

import { locale, t } from "./i18n.svelte";
import type { Act, Mark } from "./types";

export interface MarkIcon {
  act: Act;
  /** What it is, for a screen reader: there is a label without hovering. */
  label: string;
  /** Every act of the icon with its time, one a line. */
  title: string;
}

export interface HeaderMark {
  act: Act;
  text: string;
  /** An answer: "open" shows it when it is in the cache. */
  answer: boolean;
}

const NAME = { reply: "mark.reply", reply_all: "mark.replyAll", forward: "mark.forward" } as const satisfies Record<Act, string>;

/** "5 окт, 14:20", "сегодня, 14:20", "5 окт 2025, 14:20"; `sep` goes before the time. */
function moment(unix: number, now: Date, sep: "comma" | "at"): string {
  const d = new Date(unix * 1000);
  const loc = locale();
  const time = new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit" }).format(d);
  let day: string;
  if (d.toDateString() === now.toDateString()) day = t("mark.today");
  else {
    const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    day = new Intl.DateTimeFormat(loc, opts).format(d).replace(".", "").replace(/\s*г\.?$/, "");
  }
  return t(sep === "at" ? "mark.dayAt" : "mark.dayComma", { day, time });
}

/** The reply group first (one icon, the fuller act), then the forward. */
function groups(marks: Mark[]): { act: Act; marks: Mark[] }[] {
  const replies = marks.filter((m) => m.act !== "forward");
  const forward = marks.filter((m) => m.act === "forward");
  const out: { act: Act; marks: Mark[] }[] = [];
  if (replies.length) out.push({ act: replies.some((m) => m.act === "reply_all") ? "reply_all" : "reply", marks: replies });
  if (forward.length) out.push({ act: "forward", marks: forward });
  return out;
}

export function rowMarks(marks: Mark[] | undefined, now = new Date()): MarkIcon[] {
  return groups(marks ?? []).map((g) => ({
    act: g.act,
    label: t(NAME[g.act]),
    title: g.marks
      .map((m) => (m.at === null ? t("mark.server", { what: t(NAME[m.act]) }) : t("mark.at", { what: t(NAME[m.act]), when: moment(m.at, now, "comma") })))
      .join("\n"),
  }));
}

export function headerMarks(marks: Mark[] | undefined, now = new Date()): HeaderMark[] {
  return groups(marks ?? []).map((g) => {
    const m = g.marks.find((x) => x.act === g.act) ?? g.marks[0];
    const answer = g.act !== "forward";
    if (m.at === null) return { act: g.act, text: t(NAME[g.act]), answer };
    const when = moment(m.at, now, "at");
    const key = g.act === "reply" ? "mark.youReplied" : g.act === "reply_all" ? "mark.youRepliedAll" : "mark.forwardedAt";
    return { act: g.act, text: t(key, { when }), answer };
  });
}
