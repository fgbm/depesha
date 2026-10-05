import { describe, expect, it } from "vitest";
import { after, edit, isAuto, labelOf, left, secondsAfter, type LabelOf, type Remind } from "./due";
import { LATE, LEFT } from "./strings";

describe("reminder time", () => {
  // Friday, 2 October 2026, 15:30 local time.
  const friday = new Date(2026, 9, 2, 15, 30);

  it("counts working days over the weekend, at the same time of day", () => {
    const d = after(friday, 2, "workdays");
    expect([d.getDate(), d.getDay(), d.getHours(), d.getMinutes()]).toEqual([6, 2, 15, 30]);
    expect(after(friday, 1, "workdays").getDate()).toBe(5);
  });

  it("calendar days, hours and minutes as they are", () => {
    expect(after(friday, 2, "days").getDate()).toBe(4);
    expect(secondsAfter(friday, 90, "minutes")).toBe(5400);
    expect(secondsAfter(friday, 3, "hours")).toBe(10800);
  });
});

describe("saved choices", () => {
  const label: LabelOf = (n, unit) => `${n} ${unit}`;
  const made: Remind = { id: "a", label: "2 workdays", amount: 2, unit: "workdays", auto: true };

  it("a made-up label follows the new amount and unit", () => {
    expect(edit(made, { amount: 3 }, label)).toMatchObject({ amount: 3, label: "3 workdays", auto: true });
    expect(edit(made, { unit: "days" }, label)).toMatchObject({ unit: "days", label: "2 days", auto: true });
  });

  it("a typed name stays when the amount or unit changes", () => {
    const named = edit(made, { label: "  Till Monday " }, label);
    expect(named).toMatchObject({ label: "Till Monday", auto: false });
    expect(edit(named, { amount: 5, unit: "hours" }, label)).toMatchObject({ amount: 5, unit: "hours", label: "Till Monday", auto: false });
  });

  it("an empty name gives the made-up one back; a bad amount keeps the old one", () => {
    const named = { ...made, label: "Mine", auto: false };
    expect(edit(named, { label: " " }, label)).toMatchObject({ label: "2 workdays", auto: true });
    expect(edit(made, { amount: 0 }, label).amount).toBe(2);
    expect(edit(made, { amount: Number.NaN }, label).amount).toBe(2);
    expect(edit(made, { amount: 1.5 }, label).amount).toBe(2);
  });

  it("choices saved before the flag count as made up while their label is the made one", () => {
    const old = { id: "b", label: "2 workdays", amount: 2, unit: "workdays" } as Remind;
    expect(isAuto(old, label)).toBe(true);
    expect(edit(old, { amount: 4 }, label).label).toBe("4 workdays");
    const renamed = { ...old, label: "Soon" };
    expect(isAuto(renamed, label)).toBe(false);
    expect(labelOf(renamed, label)).toBe("Soon");
  });
});

describe("how far the reminder is", () => {
  const now = 1_000_000;
  const ru = (n: number, forms: { one?: string; few?: string; many?: string; other: string }) => {
    const form = new Intl.PluralRules("ru").select(n) as keyof typeof forms;
    return (forms[form] ?? forms.other).replace("{n}", String(n));
  };
  const say = (due: number) => {
    const l = left(due, now);
    return ru(l.n, (l.overdue ? LATE : LEFT)[l.unit].ru);
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
    expect(say(now + 5 * 86_400)).toBe("осталось 5 дней");
    expect(say(now - 3 * 86_400)).toBe("просрочено на 3 дня");
    expect(say(now - 21 * 86_400)).toBe("просрочено на 21 день");
    expect(say(now - 11 * 3600)).toBe("просрочено на 11 часов");
    expect(say(now + 22 * 60)).toBe("осталось 22 минуты");
  });
});
