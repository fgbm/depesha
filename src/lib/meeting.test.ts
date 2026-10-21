// The words and the local time of a meeting card (0.8.13, decision 3.1 А): a time written in a
// Windows zone of an Exchange invitation is the same instant as in the reader's own zone, and a
// rule of `RRULE` reads as a person says it.
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// The reader's own clock is half of what the card says: a CI machine may stand in any zone, so
// the test takes one and says which. It is put back, as the worker may run another file after it.
const TZ = process.env.TZ;
process.env.TZ = "Europe/Moscow";
afterAll(() => {
  process.env.TZ = TZ;
});

import { i18n } from "./i18n.svelte";
import { answersLine, dayLabel, instant, localCaption, otherZone, repeatLabel, whenLabel, zoneCaption } from "./meeting";
import type { Attendee, Meeting, Repeat, Wall } from "./types";

const wall = (over: Partial<Wall> = {}): Wall => ({
  year: 2026,
  month: 11,
  day: 6,
  hour: 15,
  minute: 0,
  all_day: false,
  zone: "Europe/Moscow",
  offset: 3 * 3600,
  ...over,
});

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  uid: "u1@example.org",
  sequence: 0,
  title: "Планёрка по выпуску",
  cancelled: false,
  start: wall(),
  end: wall({ hour: 16 }),
  all_day: false,
  location: "Переговорная 2",
  link: null,
  organizer: null,
  attendees: [],
  repeat: null,
  description: null,
  ...over,
});

beforeEach(() => {
  i18n.lang = "ru";
});

describe("the time of a meeting", () => {
  it("is the same instant in the zone the file names and in UTC", () => {
    expect(instant(wall())).toBe(Date.UTC(2026, 10, 6, 12, 0));
    const utc = instant(wall({ zone: "UTC", offset: 0 }));
    expect(utc).toBe(Date.UTC(2026, 10, 6, 15, 0));
  });

  it("takes the file's own offset when the zone is a name the system does not know", () => {
    expect(instant(wall({ zone: "Somewhere Standard Time", offset: 5 * 3600 }))).toBe(Date.UTC(2026, 10, 6, 10, 0));
  });

  it("stands for the reader's own clock when the file names no zone at all", () => {
    const at = instant(wall({ zone: null, offset: null }));
    expect(at).toBe(new Date(2026, 10, 6, 15, 0).getTime());
  });

  it("is said in the reader's language and zone", () => {
    expect(whenLabel(meeting())).toBe("Пт, 6 ноября · 15:00–16:00");
    i18n.lang = "en";
    expect(whenLabel(meeting())).toBe("Fri 6 November · 15:00–16:00");
  });

  it("is the whole day when the file gives a date without a time", () => {
    const all = meeting({ all_day: true, start: wall({ hour: 0, minute: 0, all_day: true }), end: wall({ day: 7, hour: 0, minute: 0, all_day: true }) });
    expect(whenLabel(all)).toBe("Пт, 6 ноября · весь день");
  });

  it("names the meeting's own zone beside the time", () => {
    expect(zoneCaption(wall())).toBe("UTC+3");
    expect(zoneCaption(wall({ zone: "Asia/Yekaterinburg", offset: 5 * 3600 }))).toBe("UTC+5");
    expect(zoneCaption(wall({ zone: null, offset: -5 * 3600 - 1800 }))).toBe("UTC-5:30");
    expect(zoneCaption(wall({ zone: null, offset: null }))).toBe("");
  });

  it("names the reader's own offset beside the time and the organizer's beside theirs", () => {
    expect(localCaption(meeting())).toBe("UTC+3");
    const elsewhere = meeting({
      start: wall({ zone: "Asia/Yekaterinburg", offset: 5 * 3600 }),
      end: wall({ hour: 16, zone: "Asia/Yekaterinburg", offset: 5 * 3600 }),
    });
    expect(localCaption(elsewhere)).toBe("UTC+3");
    // The organizer's own clock, said in their own offset: the invitation was written in it.
    expect(otherZone(elsewhere)?.range).toBe("15:00–16:00");
    expect(otherZone(elsewhere)?.caption).toBe("UTC+5");
    // The reader and the meeting in one zone: no second time at all.
    expect(otherZone(meeting())).toBeNull();
  });

  it("keeps the day of a date with no zone wherever the reader is", () => {
    const date = wall({ hour: 0, minute: 0, zone: null, offset: null });
    expect(dayLabel(instant(date) ?? 0)).toContain("ноября");
  });
});

describe("a rule of the repetition", () => {
  const rule = (over: Partial<Repeat> = {}): Repeat => ({ freq: "weekly", interval: 1, days: [], month_day: null, ...over });

  it("reads the weekdays of a weekly meeting", () => {
    expect(repeatLabel(rule({ days: [2] }), wall())).toBe("Повторяется: по вторникам в 15:00");
    expect(repeatLabel(rule({ days: [2, 4] }), wall())).toBe("Повторяется: по вторникам и четвергам в 15:00");
    expect(repeatLabel(rule(), wall())).toBe("Каждую неделю в 15:00");
    expect(repeatLabel(rule({ interval: 2 }), wall())).toBe("Каждые 2 недели в 15:00");
    i18n.lang = "en";
    expect(repeatLabel(rule({ days: [2, 4] }), wall())).toBe("Repeats: Tuesdays and Thursdays, at 15:00");
  });

  it("reads a daily and a monthly meeting", () => {
    i18n.lang = "ru";
    expect(repeatLabel(rule({ freq: "daily" }), wall())).toBe("Ежедневно в 15:00");
    expect(repeatLabel(rule({ freq: "daily", interval: 3 }), wall())).toBe("Каждые 3 дня в 15:00");
    expect(repeatLabel(rule({ freq: "monthly" }), wall())).toBe("Ежемесячно в 15:00");
    expect(repeatLabel(rule({ freq: "monthly", month_day: 9 }), wall())).toBe("Ежемесячно, 9 числа, в 15:00");
  });

  it("says only that it repeats when the file says more than the card tells", () => {
    expect(repeatLabel(rule({ freq: "other" }), wall())).toBe("Повторяется");
  });
});

describe("the answers of those invited", () => {
  const attendee = (status: Attendee["status"]): Attendee => ({ name: "Кто-то", email: `${status}@example.org`, role: "required", status });

  it("are counted in the words of the language", () => {
    expect(answersLine([attendee("accepted"), attendee("needs_action"), attendee("needs_action")])).toBe("1 принял, 2 ждут");
    expect(answersLine([attendee("accepted"), attendee("accepted")])).toBe("2 приняли");
    expect(answersLine([])).toBe("0 приняли");
    i18n.lang = "en";
    expect(answersLine([attendee("accepted"), attendee("needs_action")])).toBe("1 accepted, 1 waiting");
  });
});
