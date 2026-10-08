import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_TIME, type WorkTime } from "@depesha/plugin-api";
import { slots, workdaySlots } from "./times";

/** «пт 9 окт 09:00» as the menu's test writes it. */
const show = (d: Date | null) =>
  d ? `${["вс", "пн", "вт", "ср", "чт", "пт", "сб"][d.getDay()]} ${d.getDate()}.${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : null;
const at = (list: ReturnType<typeof slots>) => Object.fromEntries(list.map((s) => [s.id, show(s.at)]));

const thursday = new Date(2026, 9, 8, 14, 30); // Thu 8 Oct 2026, 14:30
const week = (days: number[], extra: Partial<WorkTime> = {}): WorkTime => ({ ...DEFAULT_WORK_TIME, days, ...extra });

describe("the moments of the Snooze menu", () => {
  it("by the default day, on a Thursday afternoon", () => {
    expect(at(slots(thursday, DEFAULT_WORK_TIME))).toEqual({
      evening: "чт 8.10 18:00",
      tomorrow: "пт 9.10 9:00",
      weekend: "сб 10.10 9:00",
      nextWeek: "пн 12.10 9:00",
      nextMonth: "пн 2.11 9:00",
    });
    expect(slots(thursday, DEFAULT_WORK_TIME).every((s) => s.off === null)).toBe(true);
  });

  it("starts the day when the setting says, here at 8:00", () => {
    const early = week([1, 2, 3, 4, 5], { day: { h: 8, m: 0 } });
    expect(at(slots(thursday, early))).toMatchObject({ tomorrow: "пт 9.10 8:00", weekend: "сб 10.10 8:00", nextWeek: "пн 12.10 8:00" });
    expect(workdaySlots(thursday, early).every((s) => s.at.getHours() === 8)).toBe(true);
  });

  it("keeps «this evening» in place once the evening has come, and switches it off", () => {
    const late = slots(new Date(2026, 9, 8, 18, 0), DEFAULT_WORK_TIME);
    expect(late.map((s) => s.id)).toEqual(["evening", "tomorrow", "weekend", "nextWeek", "nextMonth"]);
    expect(late[0].off).toBe("passed");
    expect(slots(new Date(2026, 9, 8, 17, 59), DEFAULT_WORK_TIME)[0].off).toBeNull();
    const evening = week([1, 2, 3, 4, 5], { evening: { h: 14, m: 0 } });
    expect(slots(thursday, evening)[0].off).toBe("passed");
  });

  it("on a Saturday the weekend is the next one, and the week starts on Monday", () => {
    const saturday = new Date(2026, 9, 10, 11, 0);
    expect(at(slots(saturday, DEFAULT_WORK_TIME))).toMatchObject({ tomorrow: "вс 11.10 9:00", weekend: "сб 17.10 9:00", nextWeek: "пн 12.10 9:00" });
  });

  it("goes to the first working day when Monday is not one", () => {
    expect(at(slots(thursday, week([2, 3])))).toMatchObject({ nextWeek: "вт 13.10 9:00", nextMonth: "вт 3.11 9:00" });
    expect(at(slots(thursday, week([6, 7])))).toMatchObject({ nextWeek: "сб 17.10 9:00", nextMonth: "вс 1.11 9:00" });
  });

  it("switches off the weeks and months with no working day, and the submenu is empty", () => {
    const none = slots(thursday, week([]));
    expect(none.filter((s) => s.off === "noWorkDays").map((s) => s.id)).toEqual(["nextWeek", "nextMonth"]);
    expect(none[3].at).toBeNull();
    expect(workdaySlots(thursday, week([]))).toEqual([]);
  });

  it("lists the working days with the next of each, the one that is off is missing", () => {
    const noFriday = workdaySlots(thursday, week([1, 2, 3, 4]));
    expect(noFriday.map((s) => s.iso)).toEqual([1, 2, 3, 4]);
    expect(noFriday.map((s) => show(s.at))).toEqual(["пн 12.10 9:00", "вт 13.10 9:00", "ср 14.10 9:00", "чт 15.10 9:00"]);
    // Today's weekday means next week's: the letter is not asked to come back in the past.
    expect(show(workdaySlots(thursday, DEFAULT_WORK_TIME).find((s) => s.iso === 5)!.at)).toBe("пт 9.10 9:00");
  });
});
