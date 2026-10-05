// When a reminder comes: a number of minutes, hours, days or working days after sending,
// a day of the week, or some days before a deadline; whether it comes again; how far it
// is. Pure, covered by due.test.ts.

import type { FollowupPlan } from "@depesha/plugin-api";

export type Unit = "minutes" | "hours" | "days" | "workdays";
/** Units of a repeat: a fixed time, so not working days. */
export type Every = "minutes" | "hours" | "days";
/** Units before a deadline: it is a day. */
export type DayUnit = "days" | "workdays";

export const UNITS: Unit[] = ["minutes", "hours", "days", "workdays"];
export const EVERY: Every[] = ["minutes", "hours", "days"];
export const DAY_UNITS: DayUnit[] = ["days", "workdays"];

/**
 * When the first reminder comes. `after`: `amount` units after sending. `weekday`: the
 * `weekday` (0 is Sunday) at `time`, at least a day after sending. `before`: `amount`
 * days or working days before the deadline, at `time`; the deadline is given when writing.
 */
export type Kind = "after" | "weekday" | "before";

export interface Repeat {
  amount: number;
  unit: Every;
}

/** What a reminder choice says, apart from its name. */
export interface Spec {
  /** `after` when missing: choices saved before kinds existed. */
  kind?: Kind;
  amount: number;
  unit: Unit;
  weekday?: number;
  /** "HH:MM". */
  time?: string;
  /** Again this often until a reply comes. */
  repeat?: Repeat | null;
}

export const kindOf = (s: Spec): Kind => s.kind ?? "after";

export const goodTime = (t: string | undefined): t is string => !!t && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

/** `time` ("HH:MM") on the day of `d`. */
function at(d: Date, time: string | undefined): Date {
  const [h, m] = (goodTime(time) ? time : "09:00").split(":").map(Number);
  const out = new Date(d);
  out.setHours(h, m, 0, 0);
  return out;
}

/**
 * `amount` units after `from`, or before it when negative; working days skip Saturday
 * and Sunday and keep the time of day.
 */
export function after(from: Date, amount: number, unit: Unit): Date {
  const d = new Date(from);
  if (unit === "minutes") d.setMinutes(d.getMinutes() + amount);
  else if (unit === "hours") d.setHours(d.getHours() + amount);
  else if (unit === "days") d.setDate(d.getDate() + amount);
  else {
    const step = Math.sign(amount);
    let left = Math.abs(amount);
    while (left > 0) {
      d.setDate(d.getDate() + step);
      if (d.getDay() !== 0 && d.getDay() !== 6) left--;
    }
  }
  return d;
}

/** Seconds from `from` to the reminder, as the backend takes them. */
export function secondsAfter(from: Date, amount: number, unit: Unit): number {
  return Math.round((after(from, amount, unit).getTime() - from.getTime()) / 1000);
}

/**
 * A date's local wall-clock time in milliseconds: a calendar day stays exactly 24 h
 * even across a DST change, unlike `getTime`, which can make it 23 h or 25 h.
 */
function wallMs(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

/** The nearest `weekday` (0 is Sunday) at `time` on or after the day of `from`. */
function nearestWeekday(from: Date, weekday: number, time: string): Date {
  const d = at(from, time);
  d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7));
  return d;
}

/**
 * The `weekday` (0 is Sunday) at `time` ("HH:MM"), not earlier than a day after `from`:
 * "on Monday at 9:00" sent on Monday at 8:00 is next Monday, not in an hour. The day is
 * counted on the clock, so a spring-forward's 23 h day does not push the answer a week.
 */
export function nextWeekday(from: Date, weekday: number, time: string): Date {
  const d = nearestWeekday(from, weekday, time);
  while (wallMs(d) - wallMs(from) < 86_400_000) d.setDate(d.getDate() + 7);
  return d;
}

/** The end of the day `day` (local midnight, seconds): an answer is due by then. */
export function endOfDay(day: number): number {
  const d = new Date(day * 1000);
  d.setHours(23, 59, 59, 0);
  return Math.floor(d.getTime() / 1000);
}

/** The local midnight of the day of `unix`. */
export function dayOf(unix: number): number {
  const d = new Date(unix * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** A deadline to offer with a choice before one: a few days after the reminder would come. */
export function defaultDeadline(from: Date, s: Spec): number {
  return dayOf(Math.floor(after(from, Math.max(1, s.amount) + 2, s.unit === "workdays" ? "workdays" : "days").getTime() / 1000));
}

/** When a choice before a deadline reminds: `amount` days before the deadline's day, at its time. */
export function beforeDeadline(s: Spec, day: number): number {
  const unit: Unit = s.unit === "workdays" ? "workdays" : "days";
  return Math.floor(after(at(new Date(day * 1000), s.time), -s.amount, unit).getTime() / 1000);
}

const EVERY_SECS: Record<Every, number> = { minutes: 60, hours: 3600, days: 86_400 };

export const repeatSecs = (r: Repeat | null | undefined) => (r && r.amount > 0 ? r.amount * EVERY_SECS[r.unit] : 0);

/** The reminder soonest a minute after sending: one before a deadline that is close comes at once. */
const MIN_SECS = 60;

/** What the form of "Custom…" gives: a choice (`keep`: saved in the list), or a date. */
export type Due = { spec: Spec; keep: boolean } | { at: number; repeat: Repeat | null };

/** A choice as the compose window has it: a saved or custom one (with the deadline's day), or a date. */
export type Choice = { spec: Spec; deadline: number | null } | { at: number; repeat: Repeat | null };

/** When the first reminder comes for a choice made at `from` (unix seconds); null before a deadline without one. */
export function firstAt(choice: Choice, from: Date): number | null {
  const base = Math.floor(from.getTime() / 1000);
  if ("at" in choice) return Math.max(base + MIN_SECS, choice.at);
  const s = choice.spec;
  const k = kindOf(s);
  if (k === "before") {
    if (!choice.deadline) return null;
    return Math.min(endOfDay(choice.deadline), Math.max(base + MIN_SECS, beforeDeadline(s, choice.deadline)));
  }
  const d = k === "weekday" ? nextWeekday(from, s.weekday ?? 1, s.time ?? "09:00") : after(from, s.amount, s.unit);
  return Math.max(base + MIN_SECS, Math.floor(d.getTime() / 1000));
}

/**
 * What the compose window asks of the backend for a choice made at `from` (the time the
 * letter leaves): the first reminder in seconds and the rest of the wait. A choice before
 * a deadline without one gives null: there is nothing to count from yet.
 */
export function planOf(choice: Choice, from: Date, expect: string, kind: string): { secs: number; plan: FollowupPlan } | null {
  const first = firstAt(choice, from);
  if (first === null) return null;
  const base = Math.floor(from.getTime() / 1000);
  const own = !("at" in choice) && kindOf(choice.spec) === "before" && choice.deadline;
  return {
    secs: first - base,
    plan: {
      deadline_secs: own ? endOfDay(choice.deadline!) - base : 0,
      repeat_secs: repeatSecs("at" in choice ? choice.repeat : choice.spec.repeat),
      expect,
      kind,
    },
  };
}

/** How far the reminder is: what is left until it, or how late it is. */
export interface Left {
  overdue: boolean;
  n: number;
  unit: "minutes" | "hours" | "days";
}

/** Whole days, else whole hours, else minutes (at least one); `due` and `now` in seconds. */
export function left(due: number, now: number): Left {
  const overdue = due <= now;
  const secs = Math.abs(due - now);
  if (secs >= 86_400) return { overdue, n: Math.floor(secs / 86_400), unit: "days" };
  if (secs >= 3600) return { overdue, n: Math.floor(secs / 3600), unit: "hours" };
  return { overdue, n: Math.max(1, Math.floor(secs / 60)), unit: "minutes" };
}
