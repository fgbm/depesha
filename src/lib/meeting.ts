// The words and the local time of a meeting invitation (0.8.13, decision 3.1 А): the core reads
// the calendar and says what it holds, in whose zone and how it repeats; here the reader's own
// clock and the interface language say what a person sees. A time is turned into an instant
// through `Intl`, so a zone name needs no table of its own.

import { locale, t, tn } from "./i18n.svelte";
import type { Attendee, Meeting, Participation, Repeat, Wall } from "./types";

/** Milliseconds the zone `zone` is ahead of UTC at the instant `at`. */
export function zoneOffset(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Midnight comes as «24» from some engines: the next day of the same month at 24:00 is 00:00.
  const asUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"), part("second"));
  return asUtc - at;
}

/** The instant a calendar's wall clock stands for, or `null` when it says nothing usable. */
export function instant(w: Wall | null | undefined): number | null {
  if (!w) return null;
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  if (w.zone) {
    try {
      // Twice: the offset at the guess may differ from the one at the answer, around a change
      // of daylight saving.
      let at = wall;
      for (let i = 0; i < 2; i++) at = wall - zoneOffset(w.zone, at);
      return at;
    } catch {
      // A zone name the system does not know: the file's own offset, else the reader's clock.
    }
  }
  if (w.offset !== null && w.offset !== undefined) return wall - w.offset * 1000;
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute).getTime();
}

/** The zone the reader's own clock is in, as an IANA name. */
export function readerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

type Labels = { day: Intl.DateTimeFormat; time: Intl.DateTimeFormat };
const labels = new Map<string, Labels>();

function f(): Labels {
  const loc = locale();
  let v = labels.get(loc);
  if (!v) {
    v = {
      day: new Intl.DateTimeFormat(loc, { weekday: "short", day: "numeric", month: "long" }),
      time: new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit" }),
    };
    labels.set(loc, v);
  }
  return v;
}

/** «Пт, 6 ноября»: the day of the meeting, as the week names it. */
export function dayLabel(at: number): string {
  const text = f().day.format(new Date(at));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** «15:00»: the time of the meeting in the reader's zone. */
export function timeLabel(at: number): string {
  return f().time.format(new Date(at));
}

/** The same instant as the clock of `zone` shows it: the organizer's own time. */
function timeIn(zone: string, at: number): string {
  try {
    return new Intl.DateTimeFormat(locale(), { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  } catch {
    // A zone name the system does not know: the reader's own clock says the same instant.
    return timeLabel(at);
  }
}

const DAY = 86_400_000;

/** When the meeting is, in the reader's own zone: «Пт, 6 ноября · 15:00–16:00». */
export function whenLabel(m: Meeting): string {
  const start = instant(m.start);
  if (start === null) return "";
  const end = instant(m.end);
  if (m.all_day) {
    // The end of a whole-day meeting is the first moment of the day after it.
    const last = end !== null && end - start > DAY ? end - DAY : null;
    const days = last === null ? dayLabel(start) : `${dayLabel(start)} — ${dayLabel(last)}`;
    return `${days} · ${t("cal.allDay")}`;
  }
  const from = timeLabel(start);
  if (end === null) return `${dayLabel(start)} · ${from}`;
  const to = timeLabel(end);
  // A meeting that runs past midnight names both days: an hour alone would not say which.
  if (end - start >= DAY) return `${dayLabel(start)} · ${from} — ${dayLabel(end)} · ${to}`;
  return `${dayLabel(start)} · ${from}–${to}`;
}

/** «UTC+3» for a count of seconds east of UTC. */
function offsetText(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const minutes = Math.abs(Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `UTC${sign}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

/** «UTC+3»: how far the meeting's own zone is from UTC, at the meeting itself. */
export function zoneCaption(w: Wall): string {
  const start = instant(w);
  let seconds = w.offset ?? null;
  if (w.zone && start !== null) {
    try {
      seconds = Math.round(zoneOffset(w.zone, start) / 1000);
    } catch {
      // An unknown zone name: the offset the file's own VTIMEZONE gave is what is left.
      seconds = w.offset ?? null;
    }
  }
  return seconds === null ? "" : offsetText(seconds);
}

/** «UTC+5»: how far the reader's own clock is from UTC at the meeting. The time beside it is the
 *  reader's, so the offset must be the reader's too: the meeting's own offset goes with the
 *  organizer's line. */
export function localCaption(m: Meeting): string {
  const start = instant(m.start);
  if (start === null || !m.start.zone) return "";
  try {
    return offsetText(zoneOffset(readerZone(), start) / 1000);
  } catch {
    // No reader's zone to speak of: the time stands without an offset.
    return "";
  }
}

/** The organizer's time, when the reader is in another zone than the meeting: what the card
 *  shows under the local time (3.1 А). */
export function otherZone(m: Meeting): { caption: string; range: string } | null {
  const start = instant(m.start);
  if (!m.start.zone || start === null) return null;
  try {
    const here = zoneOffset(readerZone(), start);
    if (Math.round(zoneOffset(m.start.zone, start)) === Math.round(here)) return null;
  } catch {
    // Either zone unknown: a second time would only guess, and the card shows none.
    return null;
  }
  // The organizer's clock, not the reader's: that is the time the invitation was written in.
  const zone = m.start.zone;
  const end = instant(m.end);
  const from = timeIn(zone, start);
  const range = end === null ? from : `${from}–${timeIn(zone, end)}`;
  return { caption: zoneCaption(m.start), range };
}

/** The days a weekly meeting falls on, as a person lists them: «вторникам и четвергам». */
function weekdays(days: number[]): string {
  const names = days.map((day) => t(`cal.wd.${Math.min(7, Math.max(1, day))}` as "cal.wd.1"));
  return new Intl.ListFormat(locale(), { type: "conjunction", style: "long" }).format(names);
}

/** «Повторяется: по вторникам в 15:00»: a rule as a person reads it, or «Повторяется» when the
 *  file says more than the card tells. */
export function repeatLabel(r: Repeat, start: Wall): string | null {
  const at = instant(start);
  const time = at === null || start.all_day ? "" : timeLabel(at);
  switch (r.freq) {
    case "daily":
      return r.interval > 1 ? tn("cal.repeat.everyDays", r.interval, { time }) : t("cal.repeat.daily", { time });
    case "weekly":
      if (r.days.length) return t("cal.repeat.weekdays", { days: weekdays(r.days), time });
      return r.interval > 1 ? tn("cal.repeat.everyWeeks", r.interval, { time }) : t("cal.repeat.weekly", { time });
    case "monthly":
      return r.month_day ? t("cal.repeat.monthlyDay", { day: r.month_day, time }) : t("cal.repeat.monthly", { time });
    case "yearly":
      return t("cal.repeat.yearly", { time });
    default:
      return t("cal.repeats");
  }
}

/** How the invitation names itself: an invitation, an answer to one, or a cancelled meeting. */
export function kindLabel(m: Meeting, method: string): string {
  if (method === "reply") return t("cal.kind.reply");
  if (m.repeat) return t("cal.kind.repeat");
  if (m.all_day) return t("cal.kind.allDay");
  return t("cal.kind.invitation");
}

/** What a participant answered, in one word for the pill; `null` when they have not yet. */
export function answerLabel(status: Participation | null): string | null {
  switch (status) {
    case "accepted":
      return t("cal.accepted");
    case "declined":
      return t("cal.declined");
    case "tentative":
      return t("cal.tentative");
    case "needs_action":
      return null;
    default:
      return null;
  }
}

/** «1 принял, 2 ждут»: the answers of those invited, counted. */
export function answersLine(attendees: Attendee[]): string {
  const accepted = attendees.filter((a) => a.status === "accepted").length;
  const waiting = attendees.filter((a) => a.status === "needs_action" || a.status === null || a.status === "other").length;
  const parts = [tn("cal.acceptedCount", accepted)];
  if (waiting) parts.push(tn("cal.waitingCount", waiting));
  return parts.join(", ");
}

/** Whether the invitation says it is a later version of one already sent (`SEQUENCE` above
 *  zero on a request): the card marks it, and compares it when the earlier letter is known. */
export function isUpdate(notice: { sequence: number; method: string }): boolean {
  return notice.method === "request" && notice.sequence > 0;
}

/** Whether the invitation is not an invitation any more — `METHOD:CANCEL`, or `STATUS:CANCELLED`
 *  in the meeting itself: the card frames it in red and offers no way into the calendar. */
export function isCancelled(n: { cancelled: boolean; events: Meeting[] }): boolean {
  return n.cancelled || !!n.events[0]?.cancelled;
}

/** Whether this meeting differs from the earlier version in a way the card names. */
export function changed(previous: Meeting, m: Meeting): boolean {
  return (
    instant(previous.start) !== instant(m.start) ||
    instant(previous.end) !== instant(m.end) ||
    (previous.location ?? "") !== (m.location ?? "") ||
    previous.title !== m.title ||
    previous.all_day !== m.all_day
  );
}
