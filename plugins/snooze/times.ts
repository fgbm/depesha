// The moments the «Snooze» menu offers, from the user's day (Settings → Snooze and waiting). Local
// time, pure functions: `now` and the settings are arguments, so a test picks any day.

import type { Clock, WorkTime } from "@depesha/plugin-api";

export type SlotId = "evening" | "tomorrow" | "weekend" | "nextWeek" | "nextMonth";

export interface Slot {
  id: SlotId;
  /** When the letter comes back; null when the item has no day (no working days). */
  at: Date | null;
  /** Why the item cannot be chosen now. */
  off: "passed" | "noWorkDays" | null;
}

export interface WorkdaySlot {
  /** ISO: 1 Monday … 7 Sunday; also the digit that picks it. */
  iso: number;
  at: Date;
}

/** ISO day of the week: 1 Monday … 7 Sunday. */
export function isoDay(d: Date): number {
  return d.getDay() || 7;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function atClock(d: Date, c: Clock): Date {
  const x = new Date(d);
  x.setHours(c.h, c.m, 0, 0);
  return x;
}

/** The same calendar day. */
export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** The next such weekday after today: on a Thursday, Thursday means next week's. */
export function nextIsoDay(now: Date, iso: number): Date {
  return addDays(now, ((iso - isoDay(now) + 7) % 7) || 7);
}

/** `d` itself or the first working day after it; none when no day of the week is a working one. */
export function firstWorkDay(d: Date, w: WorkTime): Date | null {
  for (let i = 0; i < 7; i++) {
    const x = addDays(d, i);
    if (w.days.includes(isoDay(x))) return x;
  }
  return null;
}

/** The same day `n` months on, the last day of a shorter month. */
export function addMonths(d: Date, n: number): Date {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last), d.getHours(), d.getMinutes());
}

/** The five items above «Working days», in the menu's order. */
export function slots(now: Date, w: WorkTime): Slot[] {
  const evening = atClock(now, w.evening);
  const nextWeek = firstWorkDay(nextIsoDay(now, 1), w);
  const nextMonth = firstWorkDay(new Date(now.getFullYear(), now.getMonth() + 1, 1), w);
  return [
    { id: "evening", at: evening, off: evening.getTime() <= now.getTime() ? "passed" : null },
    { id: "tomorrow", at: atClock(addDays(now, 1), w.day), off: null },
    { id: "weekend", at: atClock(nextIsoDay(now, 6), w.day), off: null },
    { id: "nextWeek", at: nextWeek && atClock(nextWeek, w.day), off: nextWeek ? null : "noWorkDays" },
    { id: "nextMonth", at: nextMonth && atClock(nextMonth, w.day), off: nextMonth ? null : "noWorkDays" },
  ];
}

/** The submenu «Working days»: the next of each working day, a day that is off is not there. */
export function workdaySlots(now: Date, w: WorkTime): WorkdaySlot[] {
  return [1, 2, 3, 4, 5, 6, 7].filter((iso) => w.days.includes(iso)).map((iso) => ({ iso, at: atClock(nextIsoDay(now, iso), w.day) }));
}

/** An hour and a bit on: «in an hour» typed as text, rounded up to five minutes. */
export function inMinutes(now: Date, minutes: number): Date {
  const d = new Date(now.getTime() + minutes * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return d;
}
