import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_TIME, type WorkTime } from "@depesha/plugin-api";
import { parseWhen } from "./parse";

const thursday = new Date(2026, 9, 8, 14, 30); // Thu 8 Oct 2026, 14:30
const stamp = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const when = (text: string, w: WorkTime = DEFAULT_WORK_TIME, now = thursday) => {
  const r = parseWhen(text, now, w);
  return r.ok ? stamp(r.at) : r.reason;
};

describe("the line of the Snooze menu", () => {
  it("reads the days of the week, short and in full", () => {
    expect(when("пт")).toBe("2026-10-9 9:00");
    expect(when("пятница")).toBe("2026-10-9 9:00");
    expect(when("в понедельник")).toBe("2026-10-12 9:00");
    expect(when("вт")).toBe("2026-10-13 9:00");
    expect(when("среда")).toBe("2026-10-14 9:00");
    expect(when("чт")).toBe("2026-10-15 9:00"); // today's weekday is next week's
    expect(when("суббота")).toBe("2026-10-10 9:00");
    expect(when("воскресенье")).toBe("2026-10-11 9:00");
  });

  it("reads today, tomorrow and the day after", () => {
    expect(when("завтра")).toBe("2026-10-9 9:00");
    expect(when("послезавтра")).toBe("2026-10-10 9:00");
    expect(when("сегодня")).toBe("2026-10-8 18:00"); // this evening
    expect(when("сегодня", DEFAULT_WORK_TIME, new Date(2026, 9, 8, 19, 0))).toBe("passed");
  });

  it("reads the time: 9, 9:00, 18", () => {
    expect(when("завтра 18")).toBe("2026-10-9 18:00");
    expect(when("пт 9:00")).toBe("2026-10-9 9:00");
    expect(when("пт в 9:30")).toBe("2026-10-9 9:30");
    expect(when("завтра 9 ч")).toBe("2026-10-9 9:00");
    expect(when("послезавтра вечером")).toBe("2026-10-10 18:00");
    expect(when("завтра утром")).toBe("2026-10-9 9:00");
    expect(when("завтра днем")).toBe("2026-10-9 13:00");
  });

  it("puts a bare time on today, or tomorrow when it has gone by", () => {
    expect(when("18")).toBe("2026-10-8 18:00");
    expect(when("9")).toBe("2026-10-9 9:00");
    expect(when("9:00")).toBe("2026-10-9 9:00");
  });

  it("follows the user's day for «morning» and «evening»", () => {
    const w: WorkTime = { ...DEFAULT_WORK_TIME, day: { h: 8, m: 15 }, evening: { h: 19, m: 30 } };
    expect(when("завтра", w)).toBe("2026-10-9 8:15");
    expect(when("завтра вечером", w)).toBe("2026-10-9 19:30");
    expect(when("сегодня", w)).toBe("2026-10-8 19:30");
  });

  it("reads «in N hours/days/weeks»", () => {
    expect(when("через час")).toBe("2026-10-8 15:30");
    expect(when("через 3 часа")).toBe("2026-10-8 17:30");
    expect(when("через 20 минут")).toBe("2026-10-8 14:50");
    expect(when("через 3 дня")).toBe("2026-10-11 9:00");
    expect(when("через неделю")).toBe("2026-10-15 9:00");
    expect(when("через 2 недели")).toBe("2026-10-22 9:00");
    expect(when("через 3 дня в 18")).toBe("2026-10-11 18:00");
  });

});

describe("the line of the Snooze menu, the rest", () => {
  it("rounds «in an hour» up to five minutes", () => {
    expect(when("через час", DEFAULT_WORK_TIME, new Date(2026, 9, 8, 14, 31))).toBe("2026-10-8 15:35");
  });

  it("reads dates", () => {
    expect(when("15 окт")).toBe("2026-10-15 9:00");
    expect(when("15 октября 10:00")).toBe("2026-10-15 10:00");
    expect(when("1 мая")).toBe("2027-5-1 9:00");
    expect(when("12.10")).toBe("2026-10-12 9:00");
    expect(when("3 марта")).toBe("2027-3-3 9:00");
    expect(when("31 фев")).toBe("unknown");
  });

  it("says the time has gone by, and says nothing it cannot read", () => {
    expect(when("сегодня 9")).toBe("passed");
    expect(when("вчера")).toBe("unknown");
    expect(when("")).toBe("unknown");
    expect(when("когда-нибудь")).toBe("unknown");
    expect(when("пт 25:00")).toBe("unknown");
    expect(when("пт 9:75")).toBe("unknown");
    expect(when("завтра в пол шестого")).toBe("unknown");
    expect(when("через 3 часа пт")).toBe("unknown");
  });

  it("ignores case and spaces", () => {
    expect(when("  ЗАВТРА   18 ")).toBe("2026-10-9 18:00");
    expect(when("Пятница")).toBe("2026-10-9 9:00");
  });
});
