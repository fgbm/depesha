import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_TIME } from "@depesha/plugin-api";
import type { KeyInfo, Outcome } from "./menu.svelte";
import { moveMonth, Picker } from "./picker.svelte";

const thursday = new Date(2026, 9, 8, 14, 30); // Thu 8 Oct 2026, 14:30
const open = () => new Picker(() => ({ now: thursday, work: DEFAULT_WORK_TIME, lang: "ru", say: (k) => k }));
const press = (code: string, rest: Partial<KeyInfo> = {}): KeyInfo => ({ code, key: code, ...rest });
const day = (p: Picker) => `${p.day.getFullYear()}-${p.day.getMonth() + 1}-${p.day.getDate()}`;
const stamp = (o: Outcome | null) => (o?.type === "pick" ? `${o.at.getMonth() + 1}.${o.at.getDate()} ${o.at.getHours()}:${String(o.at.getMinutes()).padStart(2, "0")}` : o?.type);

describe("the calendar from the keyboard", () => {
  it("starts on tomorrow at the start of the day", () => {
    const p = open();
    expect(day(p)).toBe("2026-10-9");
    expect(p.time).toBe("09:00");
    expect(p.focus).toBe("cal");
    expect(stamp(p.key(press("Enter")))).toBe("10.9 9:00");
  });

  it("moves by days with ←→, by weeks with ↑↓", () => {
    const p = open();
    p.key(press("ArrowRight"));
    expect(day(p)).toBe("2026-10-10");
    p.key(press("ArrowDown"));
    expect(day(p)).toBe("2026-10-17");
    p.key(press("ArrowLeft"));
    p.key(press("ArrowUp"));
    expect(day(p)).toBe("2026-10-9");
  });

  it("moves by months with PgUp/PgDn and by years with Shift", () => {
    const p = open();
    p.key(press("PageDown"));
    expect(day(p)).toBe("2026-11-9");
    p.key(press("PageUp", { shift: true }));
    expect(day(p)).toBe("2025-11-9");
    p.key(press("PageDown", { shift: true }));
    p.key(press("PageUp"));
    expect(day(p)).toBe("2026-10-9");
  });

  it("keeps to the last day of a shorter month", () => {
    expect(moveMonth(new Date(2026, 0, 31), 1).getDate()).toBe(28);
    expect(moveMonth(new Date(2026, 2, 31), -1).getMonth()).toBe(1);
  });

  it("goes to the start and the end of the week with Home and End", () => {
    const p = open(); // Friday
    p.key(press("Home"));
    expect(day(p)).toBe("2026-10-5");
    p.key(press("End"));
    expect(day(p)).toBe("2026-10-11");
  });

});

describe("the time and the end of the calendar", () => {
  it("goes with Tab to the time, then to the button, and round; Shift+Tab back", () => {
    const p = open();
    p.key(press("Tab"));
    expect(p.focus).toBe("time");
    p.key(press("Tab"));
    expect(p.focus).toBe("ok");
    p.key(press("Tab"));
    expect(p.focus).toBe("cal");
    p.key(press("Tab", { shift: true }));
    expect(p.focus).toBe("ok");
  });

  it("changes the time with ↑↓ by a quarter of an hour, with Shift by an hour", () => {
    const p = open();
    p.key(press("Tab"));
    p.key(press("ArrowUp"));
    expect(p.time).toBe("09:15");
    p.key(press("ArrowDown", { shift: true }));
    expect(p.time).toBe("08:15");
    p.time = "00:05";
    p.key(press("ArrowDown"));
    expect(p.time).toBe("23:50");
  });

  it("lets a digit start the time, and Enter does the day and the time", () => {
    const p = open();
    expect(p.key(press("Digit1"))).toBeNull(); // goes to the field
    expect(p.focus).toBe("time");
    p.time = "18:30";
    p.key(press("ArrowRight")); // the field keeps the arrows for the caret
    expect(day(p)).toBe("2026-10-9");
    expect(stamp(p.key(press("Enter")))).toBe("10.9 18:30");
  });

  it("does not take a time that has passed or one that is not a time", () => {
    const p = open();
    p.day = new Date(2026, 9, 8);
    p.time = "14:00";
    expect(p.target.error).toBe("passed");
    expect(p.key(press("Enter"))).toEqual({ type: "stay" });
    p.time = "25:00";
    expect(p.target.error).toBe("format");
    p.time = "15:00";
    expect(stamp(p.key(press("Enter")))).toBe("10.8 15:00");
  });

  it("goes back to the menu with Esc", () => {
    expect(open().key(press("Escape"))).toEqual({ type: "back" });
  });

  it("shows the month in six weeks, Monday first", () => {
    const weeks = open().weeks;
    expect(weeks).toHaveLength(42);
    expect(weeks[0].getDay()).toBe(1);
    expect(weeks.some((d) => d.getMonth() === 9 && d.getDate() === 31)).toBe(true);
  });
});

describe("the calendar of a reminder (#103)", () => {
  it("counts a moment not later than the sending time as passed", () => {
    const p = new Picker(() => ({ now: thursday, work: DEFAULT_WORK_TIME, lang: "ru", say: (k) => k, after: new Date(2026, 9, 12, 12, 0) }));
    // Starts on Fri 9 Oct 9:00: before the letter leaves on Mon 12 Oct.
    expect(p.target.error).toBe("passed");
    p.day = new Date(2026, 9, 13);
    expect(p.target.error).toBeUndefined();
  });
});
