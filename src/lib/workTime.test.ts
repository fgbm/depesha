import { describe, expect, it } from "vitest";
import { cleanWorkTime, formatClock, parseClock, workTimeFrom } from "./workTime";

describe("the clock of the settings", () => {
  it("reads the ways a time is typed", () => {
    expect(parseClock("9")).toEqual({ h: 9, m: 0 });
    expect(parseClock("9:00")).toEqual({ h: 9, m: 0 });
    expect(parseClock(" 18:30 ")).toEqual({ h: 18, m: 30 });
    expect(parseClock("0930")).toEqual({ h: 9, m: 30 });
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("9:75")).toBeNull();
    expect(parseClock("утро")).toBeNull();
    expect(parseClock("")).toBeNull();
  });

  it("writes it back the way the settings keep it", () => {
    expect(formatClock({ h: 9, m: 0 })).toBe("9:00");
    expect(formatClock({ h: 18, m: 5 })).toBe("18:05");
  });
});

describe("the user's day", () => {
  it("reads an old config with none of the fields as the defaults", () => {
    expect(workTimeFrom({})).toEqual({ day: { h: 9, m: 0 }, evening: { h: 18, m: 0 }, days: [1, 2, 3, 4, 5] });
  });

  it("keeps a chosen day, drops a broken time and a day off the week", () => {
    const w = workTimeFrom({ day_start: "8:30", evening_start: "??", work_days: [6, 1, 1, 9, 0] });
    expect(w).toEqual({ day: { h: 8, m: 30 }, evening: { h: 18, m: 0 }, days: [1, 6] });
    expect(workTimeFrom({ work_days: [] }).days).toEqual([]);
  });

  it("saves a time that parses and keeps the saved one when it does not", () => {
    const saved = { day_start: "9:00", evening_start: "18:00", work_days: [1, 2, 3, 4, 5] };
    expect(cleanWorkTime({ day_start: "8", evening_start: "late", work_days: [5, 1, 5] }, saved)).toEqual({
      day_start: "8:00",
      evening_start: "18:00",
      work_days: [1, 5],
    });
  });
});
