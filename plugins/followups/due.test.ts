import { describe, expect, it } from "vitest";
import { after, beforeDeadline, dayOf, defaultDeadline, endOfDay, firstAt, left, nextWeekday, planOf, secondsAfter } from "./due";
import { sayIn } from "./fixtures";
import { LATE, LEFT } from "./strings";

// Friday, 2 October 2026, 15:30 local time.
const friday = new Date(2026, 9, 2, 15, 30);
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

describe("reminder time", () => {
  it("counts working days over the weekend, at the same time of day, both ways", () => {
    const d = after(friday, 2, "workdays");
    expect([d.getDate(), d.getDay(), d.getHours(), d.getMinutes()]).toEqual([6, 2, 15, 30]);
    expect(after(friday, 1, "workdays").getDate()).toBe(5);
    const back = after(new Date(2026, 9, 5, 10, 0), -1, "workdays");
    expect([back.getDate(), back.getDay(), back.getHours()]).toEqual([2, 5, 10]);
  });

  it("calendar days, hours and minutes as they are", () => {
    expect(after(friday, 2, "days").getDate()).toBe(4);
    expect(secondsAfter(friday, 90, "minutes")).toBe(5400);
    expect(secondsAfter(friday, 3, "hours")).toBe(10800);
  });
});

describe("a day of the week", () => {
  it("is the nearest one at its time", () => {
    const monday = nextWeekday(friday, 1, "09:00");
    expect([monday.getDate(), monday.getDay(), monday.getHours(), monday.getMinutes()]).toEqual([5, 1, 9, 0]);
    expect(nextWeekday(friday, 0, "09:00").getDate()).toBe(4);
  });

  it("is not sooner than a day after sending", () => {
    // Monday 5 October, 8:00: "on Monday at 9:00" is the next Monday, not in an hour.
    const early = new Date(2026, 9, 5, 8, 0);
    expect(nextWeekday(early, 1, "09:00").getDate()).toBe(12);
    // Later the same Monday: next Monday too.
    expect(nextWeekday(new Date(2026, 9, 5, 18, 0), 1, "09:00").getDate()).toBe(12);
    // Friday 15:30 for Saturday 9:00: under a day, so the Saturday after.
    expect(nextWeekday(friday, 6, "16:00").getDate()).toBe(3);
    expect(nextWeekday(friday, 6, "15:00").getDate()).toBe(10);
  });
});

describe("what the compose window asks", () => {
  it("an amount after sending, the deadline its time", () => {
    const made = planOf({ spec: { amount: 2, unit: "days" }, deadline: null }, friday, "", "In 2 days")!;
    expect(made.secs).toBe(2 * 86_400);
    expect(made.plan).toEqual({ deadline_secs: 0, repeat_secs: 0, expect: "", kind: "In 2 days" });
  });

  it("again every few days until a reply", () => {
    const made = planOf({ spec: { amount: 3, unit: "days", repeat: { amount: 3, unit: "days" } }, deadline: null }, friday, "ivan@example.org", "")!;
    expect(made.secs).toBe(3 * 86_400);
    expect(made.plan).toMatchObject({ repeat_secs: 3 * 86_400, expect: "ivan@example.org" });
    expect(planOf({ at: secs(friday) + 7200, repeat: { amount: 2, unit: "hours" } }, friday, "", "")).toMatchObject({ secs: 7200, plan: { repeat_secs: 7200 } });
  });

  it("next Monday at nine", () => {
    const made = planOf({ spec: { kind: "weekday", amount: 1, unit: "days", weekday: 1, time: "09:00" }, deadline: null }, friday, "", "")!;
    expect(made.secs).toBe(secs(new Date(2026, 9, 5, 9, 0)) - secs(friday));
  });

  it("a day before the deadline, at its time; the deadline the end of its day", () => {
    const thursday = dayOf(secs(new Date(2026, 9, 8, 12)));
    const spec = { kind: "before" as const, amount: 1, unit: "days" as const, time: "09:00" };
    const made = planOf({ spec, deadline: thursday }, friday, "", "")!;
    expect(made.secs).toBe(secs(new Date(2026, 9, 7, 9, 0)) - secs(friday));
    expect(made.plan.deadline_secs).toBe(secs(new Date(2026, 9, 8, 23, 59, 59)) - secs(friday));
    expect(endOfDay(thursday)).toBe(secs(new Date(2026, 9, 8, 23, 59, 59)));
    // Working days before Monday skip the weekend.
    expect(beforeDeadline({ ...spec, unit: "workdays" }, dayOf(secs(new Date(2026, 9, 12))))).toBe(secs(new Date(2026, 9, 9, 9, 0)));
    // No deadline yet: nothing to count from.
    expect(planOf({ spec, deadline: null }, friday, "", "")).toBeNull();
    // A deadline closer than that: reminded at once, not in the past.
    expect(firstAt({ spec, deadline: dayOf(secs(friday)) }, friday)).toBe(secs(friday) + 60);
  });

  it("offers a deadline a few days after the reminder", () => {
    const spec = { kind: "before" as const, amount: 1, unit: "days" as const };
    expect(defaultDeadline(friday, spec)).toBe(dayOf(secs(new Date(2026, 9, 5))));
  });
});

describe("how far the reminder is", () => {
  const now = 1_000_000;
  const ru = sayIn("ru");
  const say = (due: number) => {
    const l = left(due, now);
    return ru.plural(l.n, (l.overdue ? LATE : LEFT)[l.unit]);
  };

  it("whole days, hours or minutes, left or overdue", () => {
    expect(left(now + 2 * 86_400 + 3600, now)).toEqual({ overdue: false, n: 2, unit: "days" });
    expect(left(now - 3 * 86_400, now)).toEqual({ overdue: true, n: 3, unit: "days" });
    expect(left(now + 5 * 3600 + 59, now)).toEqual({ overdue: false, n: 5, unit: "hours" });
    expect(left(now + 30, now)).toEqual({ overdue: false, n: 1, unit: "minutes" });
    expect(left(now, now)).toEqual({ overdue: true, n: 1, unit: "minutes" });
  });

  it("reads in Russian with the right plural", () => {
    expect(say(now + 2 * 86_400)).toBe("осталось 2 дня");
    expect(say(now + 86_400)).toBe("остался 1 день");
    expect(say(now - 3 * 86_400)).toBe("просрочено на 3 дня");
    expect(say(now - 21 * 86_400)).toBe("просрочено на 21 день");
    expect(say(now + 22 * 60)).toBe("осталось 22 минуты");
  });
});
