// How the menu writes a moment: «сб, 10 окт» in a row, «пт, 10 окт, 9:00» in the toast.

import type { Lang } from "@depesha/plugin-api";

/** «сб, 10 окт», «Sat, Oct 10». */
export function fmtDay(d: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short" }).format(d).replace(/\./g, "");
}

/** «9:00», «18:30». */
export function fmtTime(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** «пт, 10 окт, 9:00». */
export function fmtWhen(d: Date, lang: Lang): string {
  return `${fmtDay(d, lang)}, ${fmtTime(d)}`;
}
