import { describe, expect, it } from "vitest";
import { sayIn } from "./fixtures";
import { labelMaker } from "./labels";
import { edit, fresh, isAuto, labelOf, type LabelOf, type Remind } from "./presets";

describe("saved choices", () => {
  const label: LabelOf = (s) =>
    `${s.kind ?? "after"} ${s.amount} ${s.unit}${s.weekday !== undefined ? ` day ${s.weekday}` : ""}${s.time ? ` at ${s.time}` : ""}${s.repeat ? ` every ${s.repeat.amount} ${s.repeat.unit}` : ""}`;
  const made: Remind = { id: "a", label: "after 2 workdays", amount: 2, unit: "workdays", auto: true };

  it("a made-up label follows the new amount and unit", () => {
    expect(edit(made, { amount: 3 }, label)).toMatchObject({ amount: 3, label: "after 3 workdays", auto: true });
    expect(edit(made, { unit: "days" }, label)).toMatchObject({ unit: "days", label: "after 2 days", auto: true });
  });

  it("a typed name stays when the rest changes", () => {
    const named = edit(made, { label: "  Contractors " }, label);
    expect(named).toMatchObject({ label: "Contractors", auto: false });
    expect(edit(named, { amount: 5, unit: "hours" }, label)).toMatchObject({ amount: 5, unit: "hours", label: "Contractors", auto: false });
  });

  it("an empty name gives the made-up one back; bad values keep the old ones", () => {
    const named = { ...made, label: "Mine", auto: false };
    expect(edit(named, { label: " " }, label)).toMatchObject({ label: "after 2 workdays", auto: true });
    for (const amount of [0, Number.NaN, 1.5]) expect(edit(made, { amount }, label).amount).toBe(2);
  });

  it("choices saved before the flag count as made up while their label is the made one", () => {
    const old = { id: "b", label: "after 2 workdays", amount: 2, unit: "workdays" } as Remind;
    expect(isAuto(old, label)).toBe(true);
    const renamed = { ...old, label: "Soon" };
    expect(isAuto(renamed, label)).toBe(false);
    expect(labelOf(renamed, label)).toBe("Soon");
  });

  it("kind, day, time and repeat; a day of the week and a deadline get a time", () => {
    const monday = edit(made, { kind: "weekday" }, label);
    expect(monday).toMatchObject({ kind: "weekday", weekday: 1, time: "09:00", auto: true });
    expect(edit(monday, { weekday: 3, time: "10:15" }, label)).toMatchObject({ weekday: 3, time: "10:15" });
    expect(edit(monday, { weekday: 9, time: "25:00" }, label)).toMatchObject({ weekday: 1, time: "09:00" });
    // Before a deadline counts days.
    expect(edit({ ...made, unit: "hours" }, { kind: "before" }, label)).toMatchObject({ kind: "before", unit: "days", time: "09:00" });
    expect(edit(made, { kind: "before" }, label).unit).toBe("workdays");
    const every = edit(made, { repeat: { amount: 3, unit: "days" } }, label);
    expect(every.repeat).toEqual({ amount: 3, unit: "days" });
    expect(every.label).toBe(label(every));
    expect(edit(every, { repeat: { amount: 0, unit: "days" } }, label).repeat).toEqual({ amount: 3, unit: "days" });
    expect(edit(every, { repeat: null }, label).repeat).toBeNull();
  });

  it("a new one is in two days, named after that", () => {
    expect(fresh("x", label)).toMatchObject({ id: "x", kind: "after", amount: 2, unit: "days", label: "after 2 days", auto: true });
  });
});

describe("names of the choices", () => {
  const ru = labelMaker(sayIn("ru"));
  const en = labelMaker(sayIn("en"));

  it("read as the examples of the request", () => {
    expect(ru({ amount: 2, unit: "workdays" })).toBe("Напомнить через 2 рабочих дня без ответа");
    expect(ru({ amount: 3, unit: "days", repeat: { amount: 3, unit: "days" } })).toBe("Каждые 3 дня до получения ответа");
    expect(ru({ amount: 1, unit: "days", repeat: { amount: 1, unit: "days" } })).toBe("Каждый день до получения ответа");
    expect(ru({ kind: "weekday", amount: 1, unit: "days", weekday: 1, time: "09:00" })).toBe("Напомнить в ближайший понедельник в 09:00");
    expect(ru({ kind: "weekday", amount: 1, unit: "days", weekday: 3, time: "09:00" })).toBe("Напомнить в ближайшую среду в 09:00");
    expect(ru({ kind: "before", amount: 1, unit: "days", time: "09:00" })).toBe("Напомнить за сутки до срока");
    expect(ru({ kind: "before", amount: 2, unit: "workdays" })).toBe("Напомнить за 2 рабочих дня до срока");
    expect(ru({ amount: 2, unit: "workdays", repeat: { amount: 2, unit: "days" } })).toBe("Напомнить через 2 рабочих дня без ответа, потом каждые 2 дня");
    expect(ru({ amount: 2, unit: "days", repeat: { amount: 1, unit: "days" } })).toBe("Напомнить через 2 дня без ответа, потом каждый день");
    expect(en({ amount: 3, unit: "days", repeat: { amount: 3, unit: "days" } })).toBe("Every 3 days until a reply");
    expect(en({ kind: "before", amount: 1, unit: "days" })).toBe("Remind a day before the deadline");
    expect(en({ kind: "weekday", amount: 1, unit: "days", weekday: 1, time: "09:00", repeat: { amount: 1, unit: "days" } })).toBe(
      "Remind next Monday at 09:00, then every day",
    );
  });
});
