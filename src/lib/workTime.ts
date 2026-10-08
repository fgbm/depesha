// The user's day for «Snooze» (#95): when the day and the evening begin and which weekdays
// are working ones. Settings → General keeps them; plugins read them as a `WorkTime`.

export interface Clock {
  h: number;
  m: number;
}

export interface WorkTime {
  /** «Tomorrow», the weekend and the working days point here. */
  day: Clock;
  /** «This evening» points here. */
  evening: Clock;
  /** Working days, ISO: 1 Monday … 7 Sunday. */
  days: number[];
}

export interface WorkTimeSettings {
  day_start: string;
  evening_start: string;
  work_days: number[];
}

export const DEFAULT_WORK_TIME: WorkTime = { day: { h: 9, m: 0 }, evening: { h: 18, m: 0 }, days: [1, 2, 3, 4, 5] };

/** «9», «9:00», «09:30», «9 30»; nothing for anything else or a time off the clock. */
export function parseClock(text: string): Clock | null {
  const m = text.trim().match(/^(\d{1,2})(?:[:. ]?(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  return h > 23 || min > 59 ? null : { h, m: min };
}

/** «9:00», «18:30». */
export function formatClock(c: Clock): string {
  return `${c.h}:${String(c.m).padStart(2, "0")}`;
}

/** The settings as the menu reads them; a value that does not parse falls back to the default. */
export function workTimeFrom(s: Partial<WorkTimeSettings>): WorkTime {
  const days = (s.work_days ?? DEFAULT_WORK_TIME.days).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return {
    day: parseClock(s.day_start ?? "") ?? DEFAULT_WORK_TIME.day,
    evening: parseClock(s.evening_start ?? "") ?? DEFAULT_WORK_TIME.evening,
    days: [...new Set(days)].sort((a, b) => a - b),
  };
}

/** What a page saves: a time that does not parse is not saved, the saved one stays. */
export function cleanWorkTime(draft: WorkTimeSettings, saved: WorkTimeSettings): WorkTimeSettings {
  const keep = (text: string, was: string) => {
    const c = parseClock(text);
    return c ? formatClock(c) : was;
  };
  return {
    day_start: keep(draft.day_start, saved.day_start),
    evening_start: keep(draft.evening_start, saved.evening_start),
    work_days: [...new Set(draft.work_days)].sort((a, b) => a - b),
  };
}
