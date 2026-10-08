// Russian text into a moment: «завтра 18», «пт 9:00», «через 3 часа», «15 окт». The line of
// the «Snooze» menu is read with it. Pure: `now` and the user's day are arguments.

import type { WorkTime } from "@depesha/plugin-api";
import { addDays, addMonths, atClock, inMinutes, nextIsoDay } from "./times";

export type Parsed = { ok: true; at: Date } | { ok: false; reason: "unknown" | "passed" };

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTH_RE = "(янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)";

const unknown: Parsed = { ok: false, reason: "unknown" };

/** The ISO day a weekday word stands for: «пт», «пятницу», «вторник». */
function weekdayOf(word: string): number {
  if (/^(пн|пон)/.test(word)) return 1;
  if (/^вт/.test(word)) return 2;
  if (/^ср/.test(word)) return 3;
  if (/^(чт|чет)/.test(word)) return 4;
  if (/^(пт|пят)/.test(word)) return 5;
  if (/^(сб|суб)/.test(word)) return 6;
  return 7;
}

function monthOf(word: string): number {
  return word.startsWith("ма") ? (word === "мар" ? 2 : 4) : MONTHS.indexOf(word);
}

/** The date `day.month` this year, or next year when it has gone by; none for a 31 February. */
function dateOf(now: Date, day: number, month: number): Date | null {
  const d = new Date(now.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (d.getTime() < atClock(now, { h: 0, m: 0 }).getTime()) d.setFullYear(d.getFullYear() + 1);
  return d;
}

/** Takes the first match out of the text, leaving a space. */
function take(r: { text: string }, re: RegExp): RegExpMatchArray | null {
  const m = r.text.match(re);
  if (m) r.text = r.text.replace(m[0], " ");
  return m;
}

/** What has been read of the text so far; `text` keeps what is left. */
interface Reading {
  text: string;
  day: Date | null;
  hour: number | null;
  minute: number;
  /** «Сегодня» was said: with no time it means this evening. */
  today: boolean;
}

/** «Через 3 часа»: a moment of its own, nothing else may be said with it. «Через 3 дня»: a day, the time may follow. */
function readRelative(r: Reading, now: Date): Parsed | null {
  const m = take(r, /\sчерез\s?(\d+)?\s?(мин\S*|час\S*|ч|мес\S*|дн\S*|день|д|нед\S*|н)\s/);
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  const unit = m[2];
  if (/^(мин|ч)/.test(unit)) {
    if (rest(r)) return unknown;
    return { ok: true, at: inMinutes(now, /^мин/.test(unit) ? n : n * 60) };
  }
  r.day = /^мес/.test(unit) ? addMonths(now, n) : addDays(now, /^н/.test(unit) ? 7 * n : n);
  return null;
}

/** «15 окт», «12.10»; false when the date does not exist. */
function readDate(r: Reading, now: Date): boolean {
  const dotted = r.text.match(/\s(\d{1,2})[./](\d{1,2})\s/);
  let m: RegExpMatchArray | null;
  let day: Date | null;
  if (dotted && Number(dotted[2]) >= 1 && Number(dotted[2]) <= 12 && Number(dotted[1]) >= 1 && Number(dotted[1]) <= 31) {
    take(r, /\s(\d{1,2})[./](\d{1,2})\s/);
    day = dateOf(now, Number(dotted[1]), Number(dotted[2]) - 1);
  } else if ((m = take(r, new RegExp(`\\s(\\d{1,2})\\s?${MONTH_RE}\\S*\\s`)))) {
    day = dateOf(now, Number(m[1]), monthOf(m[2]));
  } else return true;
  if (day) r.day = day;
  return day !== null;
}

/** «сегодня», «завтра», «послезавтра», «пт». */
function readDayWord(r: Reading, now: Date) {
  let m = take(r, /\s(сегодня|завтра|послезавтра)\s/);
  if (m) {
    r.day = m[1] === "сегодня" ? now : addDays(now, m[1] === "завтра" ? 1 : 2);
    r.today = m[1] === "сегодня";
    return;
  }
  m = take(r, /\s(пн|пон\S*|вт|втор\S*|ср|сред\S*|чт|чет\S*|пт|пят\S*|сб|суб\S*|вс|воскр\S*)\s/);
  if (m) r.day = nextIsoDay(now, weekdayOf(m[1]));
}

/** «утром», «вечером», «18», «9:30». */
function readTime(r: Reading, w: WorkTime) {
  let m = take(r, /\s(утром|вечером|днем)\s/);
  if (m) {
    const clock = m[1] === "утром" ? w.day : m[1] === "днем" ? { h: 13, m: 0 } : w.evening;
    r.hour = clock.h;
    r.minute = clock.m;
    return;
  }
  m = take(r, /\s(?:в\s)?(\d{1,2})[:.](\d{2})\s/);
  if (m) {
    r.hour = Number(m[1]);
    r.minute = Number(m[2]);
    return;
  }
  m = take(r, /\s(?:в\s)?(\d{1,2})(?:\s?(?:ч|час\S*))?\s/);
  if (m) r.hour = Number(m[1]);
}

/** What is left of the text but the word «в»; anything is a word not understood. */
function rest(r: Reading): string {
  return r.text.replace(/\sв(?=\s)/g, " ").trim();
}

export function parseWhen(input: string, now: Date, w: WorkTime): Parsed {
  const r: Reading = { text: ` ${input.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim()} `, day: null, hour: null, minute: 0, today: false };
  const relative = readRelative(r, now);
  if (relative) return relative;
  if (!readDate(r, now)) return unknown;
  readDayWord(r, now);
  readTime(r, w);
  if ((!r.day && r.hour === null) || rest(r)) return unknown;
  if (r.hour !== null && (r.hour > 23 || r.minute > 59)) return unknown;

  let at: Date;
  if (!r.day) {
    at = atClock(now, { h: r.hour!, m: r.minute });
    if (at.getTime() <= now.getTime()) at = addDays(at, 1);
  } else if (r.hour !== null) {
    at = atClock(r.day, { h: r.hour, m: r.minute });
  } else {
    // «Сегодня» alone is this evening; any other day, the start of its day.
    at = atClock(r.day, r.today ? w.evening : w.day);
  }
  return at.getTime() <= now.getTime() ? { ok: false, reason: "passed" } : { ok: true, at };
}
