import { describe, expect, it } from "vitest";
import { DEFAULT_WORK_TIME, type Lang, type WorkTime } from "@depesha/plugin-api";
import { SnoozeMenu, type KeyInfo, type Outcome } from "./menu.svelte";

const thursday = new Date(2026, 9, 8, 14, 30); // Thu 8 Oct 2026, 14:30

function open(work: WorkTime = DEFAULT_WORK_TIME, now = thursday, lang: Lang = "ru") {
  return new SnoozeMenu(() => ({ now, work, lang, say: (key) => key }));
}

const press = (code: string, key = "", rest: Partial<KeyInfo> = {}): KeyInfo => ({ code, key: key || code, ...rest });
const stamp = (o: Outcome | null) => (o?.type === "pick" ? `${o.at.getMonth() + 1}.${o.at.getDate()} ${o.at.getHours()}:${String(o.at.getMinutes()).padStart(2, "0")}` : o?.type);

/** Types one character like the window does: the key first, then the line changes. */
function type(menu: SnoozeMenu, code: string, char: string) {
  menu.key(press(code, char));
  menu.setQuery(menu.q + char);
}

const lit = (menu: SnoozeMenu) => menu.rows[menu.cur]?.id ?? null;

describe("the Snooze menu from the keyboard", () => {
  it("lights «Tomorrow» on opening, and Enter does it", () => {
    const menu = open();
    expect(lit(menu)).toBe("tomorrow");
    expect(stamp(menu.key(press("Enter")))).toBe("10.9 9:00");
  });

  it("has the seven items in the decided order, the date on the right", () => {
    const rows = open().rows;
    expect(rows.map((r) => r.id)).toEqual(["evening", "tomorrow", "weekend", "nextWeek", "nextMonth", "days", "custom"]);
    expect(rows.map((r) => r.hint).slice(0, 5)).toEqual(["чт, 8 окт", "пт, 9 окт", "сб, 10 окт", "пн, 12 окт", "пн, 2 нояб"]);
    expect(rows.every((r) => r.key.length === 1)).toBe(true);
  });

  it("moves with the arrows, round the ends, over items that are off", () => {
    const late = open(DEFAULT_WORK_TIME, new Date(2026, 9, 8, 19, 0));
    expect(late.rows[0].off).toBe(true);
    late.cur = late.rowIndex("custom");
    late.key(press("ArrowDown"));
    expect(lit(late)).toBe("tomorrow"); // not «Evening»: it has passed
    late.key(press("ArrowUp"));
    expect(lit(late)).toBe("custom");
  });

});

describe("the letters and the line of the Snooze menu", () => {
  it("lights an item by its letter, which goes into the line; Enter does it", () => {
    const menu = open();
    type(menu, "KeyD", "в");
    expect(lit(menu)).toBe("evening");
    expect(menu.hot).toBe(true);
    expect(menu.q).toBe("в");
    expect(stamp(menu.key(press("Enter")))).toBe("10.8 18:00");
  });

  it("takes the letter by the key's place: the Latin layout does the same", () => {
    const menu = open();
    menu.key(press("KeyP", "p"));
    menu.setQuery("p");
    expect(lit(menu)).toBe("tomorrow");
    const weekend = open();
    weekend.key(press("Quote", "'"));
    weekend.setQuery("'");
    expect(stamp(weekend.key(press("Enter")))).toBe("10.10 9:00");
  });

  it("gives the English menu English letters", () => {
    const menu = open(DEFAULT_WORK_TIME, thursday, "en");
    expect(menu.rows.map((r) => r.key)).toEqual(["E", "T", "W", "N", "M", "D", "C"]);
    menu.key(press("KeyW", "w"));
    expect(lit(menu)).toBe("weekend");
  });

  it("lights nothing for a letter whose item is off", () => {
    const menu = open(DEFAULT_WORK_TIME, new Date(2026, 9, 8, 19, 0));
    type(menu, "KeyD", "в");
    expect(lit(menu)).toBeNull();
    expect(menu.key(press("Enter"))).toEqual({ type: "stay" });
  });

  it("reads the line as text once it goes on, and Enter does the time read", () => {
    const menu = open();
    type(menu, "KeyP", "з");
    menu.setQuery("завтра 18");
    expect(menu.hot).toBe(false);
    expect(menu.rows[0]).toMatchObject({ id: "parsed", key: "", hint: "fromYou" });
    expect(menu.rows[0].label).toBe("пт, 9 окт, 18:00");
    expect(lit(menu)).toBe("parsed");
    expect(stamp(menu.key(press("Enter")))).toBe("10.9 18:00");
  });

  it("does nothing on Enter for a text it cannot read, and says so under the line", () => {
    const menu = open();
    menu.setQuery("когда-нибудь");
    expect(lit(menu)).toBeNull();
    expect(menu.key(press("Enter"))).toEqual({ type: "stay" });
    expect(menu.note).toEqual({ text: "notUnderstood", bad: false });
    menu.setQuery("сегодня 9");
    expect(menu.note).toEqual({ text: "timePassed", bad: true });
    expect(menu.key(press("Enter"))).toEqual({ type: "stay" });
  });

  it("goes back to the plain list when the line is emptied", () => {
    const menu = open();
    menu.setQuery("пт 9");
    menu.setQuery("");
    expect(lit(menu)).toBe("tomorrow");
    expect(menu.note).toBeNull();
  });
});

describe("the submenu «Working days»", () => {
  it("opens with → on its row and goes back with ←; the parent stays", () => {
    const menu = open();
    menu.cur = menu.rowIndex("days");
    expect(menu.key(press("ArrowRight", "", { atEnd: true }))).toEqual({ type: "stay" });
    expect(menu.subOpen).toBe(true);
    expect(lit(menu)).toBe("days");
    menu.key(press("ArrowDown"));
    expect(menu.subCur).toBe(1);
    menu.key(press("ArrowLeft"));
    expect(menu.subOpen).toBe(false);
    expect(lit(menu)).toBe("days");
  });

  it("does not take → while the caret is inside the text", () => {
    const menu = open();
    menu.cur = menu.rowIndex("days");
    expect(menu.key(press("ArrowRight", "", { atEnd: false }))).toBeNull();
    expect(menu.subOpen).toBe(false);
  });

  it("opens with Enter on the row and picks the day under the cursor", () => {
    const menu = open();
    type(menu, "KeyL", "д");
    expect(lit(menu)).toBe("days");
    expect(menu.key(press("Enter"))).toEqual({ type: "stay" });
    expect(menu.subOpen).toBe(true);
    menu.key(press("ArrowDown"));
    menu.key(press("ArrowDown"));
    expect(stamp(menu.key(press("Enter")))).toBe("10.14 9:00"); // Wednesday
  });

  it("a digit lights that ISO day: 5 is Friday, and Enter picks it", () => {
    const menu = open();
    type(menu, "Digit5", "5");
    expect(menu.subOpen).toBe(true);
    expect(menu.days[menu.subCur].iso).toBe(5);
    expect(lit(menu)).toBe("days");
    expect(stamp(menu.key(press("Enter")))).toBe("10.9 9:00");
    const numpad = open();
    type(numpad, "Numpad1", "1");
    expect(stamp(numpad.key(press("Enter")))).toBe("10.12 9:00");
  });

  it("lights nothing for a day that is off, and lists no such day", () => {
    const noFriday = open({ ...DEFAULT_WORK_TIME, days: [1, 2, 3, 4] });
    expect(noFriday.days.map((d) => d.iso)).toEqual([1, 2, 3, 4]);
    type(noFriday, "Digit5", "5");
    expect(noFriday.subOpen).toBe(false);
    expect(lit(noFriday)).toBeNull();
    expect(noFriday.key(press("Enter"))).toEqual({ type: "stay" });
    const saturday = open();
    type(saturday, "Digit6", "6");
    expect(lit(saturday)).toBeNull();
  });

  it("is off, with a hint, when no day is a working one", () => {
    const menu = open({ ...DEFAULT_WORK_TIME, days: [] });
    const days = menu.rows.find((r) => r.id === "days")!;
    expect(days).toMatchObject({ off: true, hint: "noneChosen" });
    expect(menu.rows.filter((r) => r.off).map((r) => r.id)).toEqual(["nextWeek", "nextMonth", "days"]);
  });
});

describe("Esc, one level at a time", () => {
  it("closes the submenu, then clears the line, then the menu", () => {
    const menu = open();
    type(menu, "KeyL", "д");
    menu.key(press("Enter"));
    expect(menu.key(press("Escape"))).toEqual({ type: "stay" });
    expect(menu.subOpen).toBe(false);
    expect(menu.q).toBe("д");
    expect(menu.key(press("Escape"))).toEqual({ type: "stay" });
    expect(menu.q).toBe("");
    expect(menu.key(press("Escape"))).toEqual({ type: "close" });
  });
});

describe("the calendar item", () => {
  it("opens the calendar with its letter and Enter, or a click", () => {
    const menu = open();
    type(menu, "KeyR", "к");
    expect(menu.key(press("Enter"))).toEqual({ type: "custom" });
    expect(open().click(open().rowIndex("custom"))).toEqual({ type: "custom" });
  });
});

describe("the mouse", () => {
  it("lights the row under the pointer, closes the submenu elsewhere, and a click does the row", () => {
    const menu = open();
    menu.cur = menu.rowIndex("days");
    menu.key(press("ArrowRight", "", { atEnd: true }));
    menu.hover(menu.rowIndex("weekend"));
    expect(menu.subOpen).toBe(false);
    expect(stamp(menu.click(menu.rowIndex("nextWeek")))).toBe("10.12 9:00");
    menu.hover(menu.rowIndex("evening"));
    expect(lit(menu)).toBe("evening");
  });
});

describe("the reminder's menu: the same one with two more rows (#103, 4.4 А)", () => {
  const reminder = (none: boolean, lang: Lang = "ru") =>
    new SnoozeMenu(() => ({ now: thursday, work: DEFAULT_WORK_TIME, lang, say: (key) => key, extras: { none, noneLabel: "Без напоминания", setupLabel: "Настроить…" } }));

  it("adds «No reminder» and «Set up…» under the seven items, and the snooze menu has neither", () => {
    expect(reminder(true).rows.map((r) => r.id)).toEqual(["evening", "tomorrow", "weekend", "nextWeek", "nextMonth", "days", "custom", "none", "setup"]);
    expect(open().rows.some((r) => r.id === "none" || r.id === "setup")).toBe(false);
  });

  it("ticks «No reminder» while none is chosen", () => {
    expect(reminder(true).rows.find((r) => r.id === "none")?.tick).toBe(true);
    expect(reminder(false).rows.find((r) => r.id === "none")?.tick).toBe(false);
  });

  it("does «No reminder» by its letter (Б, or O in English) and «Set up…» by Enter", () => {
    const ru = reminder(false);
    type(ru, "Comma", "б");
    expect(lit(ru)).toBe("none");
    expect(ru.key(press("Enter"))?.type).toBe("none");
    const en = reminder(false, "en");
    type(en, "KeyO", "o");
    expect(en.key(press("Enter"))?.type).toBe("none");
    const setup = reminder(false);
    setup.cur = setup.rowIndex("setup");
    expect(setup.key(press("Enter"))?.type).toBe("setup");
  });

  it("takes the letter of «No reminder» as plain text in the snooze menu, lighting nothing", () => {
    const menu = open();
    type(menu, "Comma", "б");
    expect(menu.hot).toBe(false);
    expect(lit(menu)).toBe(null);
  });
});

describe("a reminder cannot come before the letter leaves (#103)", () => {
  // Scheduled for Sat 10 Oct, 12:00: «Evening», «Tomorrow» and «Weekend» come at or before it.
  const leaving = new Date(2026, 9, 10, 12, 0);
  const scheduled = () => new SnoozeMenu(() => ({ now: thursday, work: DEFAULT_WORK_TIME, lang: "ru", say: (key) => key, after: leaving }));

  it("hides the moments not later than the sending time, and keeps the rest", () => {
    expect(scheduled().rows.map((r) => r.id)).toEqual(["nextWeek", "nextMonth", "days", "custom"]);
  });

  it("leaves out the working days not later than it", () => {
    expect(scheduled().days.every((d) => d.at.getTime() > leaving.getTime())).toBe(true);
  });

  it("reads a typed moment before it as passed", () => {
    const menu = scheduled();
    menu.setQuery("завтра 18");
    expect(menu.parsed).toEqual({ ok: false, reason: "passed" });
    menu.setQuery("пн 9:00");
    expect(menu.parsed?.ok).toBe(true);
  });
});
