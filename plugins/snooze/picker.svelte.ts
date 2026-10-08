// «Pick date and time…»: a calendar and a time, all from the keyboard — arrows over the days,
// PgUp/PgDn over the months, Tab to the time, Enter to snooze, Esc back to the menu.

import { formatClock, parseClock } from "@depesha/plugin-api";
import type { KeyInfo, MenuEnv, Outcome } from "./menu.svelte";
import { addDays, atClock } from "./times";

export type PickerFocus = "cal" | "time" | "ok";

export type Target = { error?: undefined; at: Date } | { error: "format"; at?: undefined } | { error: "passed"; at: Date };

const STAY: Outcome = { type: "stay" };
const ORDER: PickerFocus[] = ["cal", "time", "ok"];

/** The day `n` months on, at most the last day of that month. */
export function moveMonth(d: Date, n: number): Date {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes());
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(d.getDate(), last));
  return first;
}

export class Picker {
  /** The day under the cursor. */
  day = $state<Date>(new Date());
  /** The time as typed. */
  time = $state("");
  focus = $state<PickerFocus>("cal");

  private env: () => MenuEnv;

  constructor(env: () => MenuEnv) {
    this.env = env;
    const { now, work } = env();
    this.day = atClock(addDays(now, 1), { h: 0, m: 0 });
    this.time = formatClock(work.day).replace(/^(\d):/, "0$1:");
  }

  /** The moment the picker stands on, or why it cannot be used. */
  get target(): Target {
    const clock = parseClock(this.time);
    if (!clock) return { error: "format" };
    const at = atClock(this.day, clock);
    return at.getTime() <= this.env().now.getTime() ? { at, error: "passed" } : { at };
  }

  /** The 6 weeks that show the month of `day`, Monday first. */
  get weeks(): Date[] {
    const first = new Date(this.day.getFullYear(), this.day.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => addDays(first, i - offset));
  }

  select(day: Date) {
    this.day = atClock(day, { h: 0, m: 0 });
    this.focus = "cal";
  }

  shiftMonth(n: number) {
    this.day = moveMonth(this.day, n);
  }

  confirm(): Outcome {
    const t = this.target;
    return t.error ? STAY : { type: "pick", at: t.at };
  }

  private nudgeTime(minutes: number) {
    const now = parseClock(this.time) ?? this.env().work.day;
    const total = (((now.h * 60 + now.m + minutes) % 1440) + 1440) % 1440;
    this.time = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  key(e: KeyInfo): Outcome | null {
    if (e.ctrl || e.alt || e.meta) return null;
    const c = e.code;
    if (c === "Escape") return { type: "back" };
    if (c === "Enter" || c === "NumpadEnter") return this.confirm();
    if (c === "Tab") {
      this.focus = ORDER[(ORDER.indexOf(this.focus) + (e.shift ? 2 : 1)) % 3];
      return STAY;
    }
    if (this.focus === "time") {
      if (c === "ArrowUp" || c === "ArrowDown") {
        this.nudgeTime((c === "ArrowUp" ? 1 : -1) * (e.shift ? 60 : 15));
        return STAY;
      }
      return null;
    }
    if (this.focus !== "cal") return null;
    const weekday = (this.day.getDay() + 6) % 7;
    const steps: Record<string, () => Date> = {
      ArrowLeft: () => addDays(this.day, -1),
      ArrowRight: () => addDays(this.day, 1),
      ArrowUp: () => addDays(this.day, -7),
      ArrowDown: () => addDays(this.day, 7),
      PageUp: () => moveMonth(this.day, e.shift ? -12 : -1),
      PageDown: () => moveMonth(this.day, e.shift ? 12 : 1),
      Home: () => addDays(this.day, -weekday),
      End: () => addDays(this.day, 6 - weekday),
    };
    if (steps[c]) {
      this.day = steps[c]();
      return STAY;
    }
    // A digit starts the time: it goes into that field, which takes the focus.
    if (/^(Digit|Numpad)\d$/.test(c)) {
      this.focus = "time";
    }
    return null;
  }
}
