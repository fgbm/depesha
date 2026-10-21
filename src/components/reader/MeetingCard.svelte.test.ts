// @vitest-environment jsdom
// The card of a meeting invitation (0.8.13): an invitation, its update, its cancellation, an
// answer to it, a meeting of the whole day, several meetings in one file, and a file that did
// not read — each says what the decisions 1.1 А–8.1 А ask, in the reader's own language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("../../lib/testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("../../lib/testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("../../lib/testing").then((m) => m.appModule));
vi.mock("../../lib/api", async (orig) => ({ ...(await orig<object>()), api: (await import("../../lib/testing")).api }));
vi.mock("../../lib/theme", async (orig) => ({ ...(await orig<object>()), applyTheme: () => {} }));

import { flushSync, mount, tick, unmount } from "svelte";
import MeetingCard from "./MeetingCard.svelte";
import { i18n } from "../../lib/i18n.svelte";
import { settings } from "../../lib/testing";
import { app } from "../../lib/store.svelte";
import type { AttachmentInfo, Meeting, Notice, Wall } from "../../lib/types";

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
  title: "Планёрка по выпуску: сроки, заявки",
  cancelled: false,
  start: wall(),
  end: wall({ hour: 16 }),
  all_day: false,
  location: "Переговорная 2",
  link: null,
  organizer: { name: "Анна Соколова", email: "anna@example.org" },
  attendees: [
    { name: "Олег Тимофеев", email: "oleg@example.org", role: "required", status: "accepted" },
    { name: "Ирина Дьяченко", email: "irina@example.org", role: "optional", status: "needs_action" },
    { name: "Пётр Примеров", email: "petr@example.org", role: "required", status: "needs_action" },
  ],
  repeat: null,
  description: "К следующей встрече: разбор заявок на выпуск.\nВторой абзац.",
  ...over,
});

const notice = (over: Partial<Notice> = {}): Notice => ({
  method: "request",
  cancelled: false,
  sequence: 0,
  file: 0,
  problem: null,
  events: [meeting()],
  previous: null,
  ...over,
});

const ics: AttachmentInfo = { index: 0, name: "invite.ics", mime: "text/calendar", size: 2600, content_id: null, inline: false };

let view: ReturnType<typeof mount> | null = null;
let asked: string[] = [];

/** Draws the card; `null` for a calendar that came as no file of the letter at all. */
function draw(n: Notice, attachment: AttachmentInfo | null = ics): HTMLElement {
  app.settingsCtl.settings = settings();
  asked = [];
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(MeetingCard, {
    target,
    props: {
      notice: n,
      attachment: attachment ?? undefined,
      onAdd: () => asked.push("add"),
      onSave: () => asked.push("save"),
      onOpenAsText: () => asked.push("text"),
    },
  });
  flushSync();
  return target;
}

/** The buttons of the card, by their label. */
function buttons(t: HTMLElement): string[] {
  return [...t.querySelectorAll<HTMLElement>(".cal-a .btn")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "");
}

function press(t: HTMLElement, label: string) {
  const button = [...t.querySelectorAll<HTMLElement>("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent)?.trim().includes(label));
  if (!button) throw new Error(`no button «${label}»`);
  button.click();
  flushSync();
}

beforeEach(() => {
  i18n.lang = "ru";
});
afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
});

describe("an invitation", () => {
  it("says the name, the time, the place, who holds it and who is coming", () => {
    const t = draw(notice());
    expect(t.querySelector(".cal-h")?.textContent).toContain("Приглашение");
    expect(t.querySelector(".cal-t")?.textContent).toBe("Планёрка по выпуску: сроки, заявки");
    expect(t.querySelector(".cr.strong")?.textContent).toContain("15:00–16:00");
    expect(t.textContent).toContain("Переговорная 2");
    expect(t.textContent).toContain("Организатор: Анна Соколова");
    expect(t.textContent).toContain("Участники: 3 · 1 принял, 2 ждут");
  });

  it("shows the first lines of the description and the rest by «Ещё»", () => {
    const t = draw(notice());
    const text = t.querySelector(".cal-d p")!;
    expect(text.classList.contains("fade")).toBe(true);
    press(t, "Ещё");
    expect(t.querySelector(".cal-d p")!.classList.contains("fade")).toBe(false);
  });

  it("has the actions of its file: the calendar of the system and the file itself", () => {
    const t = draw(notice());
    expect(buttons(t).join("|")).toContain("Добавить в календарь");
    expect(buttons(t)).toContain("Сохранить .ics");
    press(t, "Добавить в календарь");
    expect(asked).toEqual(["add"]);
    press(t, "Сохранить .ics");
    expect(asked).toEqual(["add", "save"]);
  });

  it("copies the link of the meeting from its own button", async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
    const t = draw(notice({ events: [meeting({ link: "https://meet.example.org/room-1" })] }));
    // The address itself is in the button's title: the link is pressed, not read.
    const join = [...t.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.includes("Подключиться"));
    expect(join?.title).toBe("https://meet.example.org/room-1");
    press(t, "Скопировать ссылку встречи");
    await tick();
    expect(write).toHaveBeenCalledWith("https://meet.example.org/room-1");
    vi.unstubAllGlobals();
  });

  it("carries no action when the calendar is one of the letter's own forms: there is no file", () => {
    const t = draw(notice({ file: null }), null);
    expect(t.querySelector(".cal-t")?.textContent).toContain("Планёрка");
    expect(buttons(t)).toEqual([]);
  });

  it("opens the answers of the participants, with their role and answer", () => {
    const t = draw(notice());
    expect(t.querySelector(".people")).toBeNull();
    press(t, "Показать");
    const people = t.querySelector(".people")!;
    expect(people.textContent).toContain("Олег Тимофеев");
    expect(people.textContent).toContain("нужен");
    expect(people.textContent).toContain("Принято");
  });
});

describe("a cancelled meeting", () => {
  it("is framed in red with the time struck through, and offers no visit to the calendar", () => {
    const cancelled = meeting({ cancelled: true });
    const t = draw(notice({ method: "cancel", cancelled: true, events: [cancelled] }));
    expect(t.querySelector(".cal")!.classList.contains("off")).toBe(true);
    expect(t.querySelector(".cal-h .pill.bad")?.textContent).toBe("Отменена");
    expect(t.querySelector(".cr.strong")!.classList.contains("struck")).toBe(true);
    expect(t.textContent).toContain("Отменена организатором, Анна Соколова");
    expect(t.textContent).toContain("Место в календаре освободилось");
    expect(buttons(t).join("|")).not.toContain("Добавить в календарь");
    expect(buttons(t)).toContain("Сохранить .ics");
    // The description of a cancelled meeting is not the point of the card any more.
    expect(t.querySelector(".cal-d")).toBeNull();
  });

  it("is red also when only the meeting itself says so", () => {
    const t = draw(notice({ events: [meeting({ cancelled: true })] }));
    expect(t.querySelector(".cal")!.classList.contains("off")).toBe(true);
  });
});

describe("an update", () => {
  const was = meeting({ start: wall({ day: 4, hour: 15 }), end: wall({ day: 4, hour: 16 }), location: "Переговорная 2" });
  const now = meeting({ sequence: 2, start: wall({ day: 6, hour: 15 }), end: wall({ day: 6, hour: 16 }), location: "Переговорная 4" });

  it("shows what it was against what it is", () => {
    const t = draw(notice({ sequence: 2, previous: was, events: [now] }));
    expect(t.querySelector(".cal-h .pill.warn")?.textContent).toBe("Изменено");
    const struck = t.querySelector(".cr.sub .struck")?.textContent ?? "";
    expect(struck).toContain("4 ноября");
    expect(t.querySelector(".cr.strong")?.textContent).toContain("6 ноября");
    expect(t.textContent).toContain("Переговорная 4");
    expect(t.textContent).toContain("было: Переговорная 2");
    expect(t.querySelector(".note")?.textContent).toContain("Версия 2 приглашения");
  });

  it("says only that it changed when the earlier letter is not in the case", () => {
    const t = draw(notice({ sequence: 2, previous: null, events: [now] }));
    expect(t.querySelector(".cal-h .pill.warn")?.textContent).toBe("Изменено");
    expect(t.querySelector(".cr.sub")).toBeNull();
    expect(t.textContent).not.toContain("было:");
    expect(t.querySelector(".note")).toBeNull();
  });
});

describe("an answer to the invitation", () => {
  const answered = meeting({
    attendees: [
      { name: "Олег Тимофеев", email: "oleg@example.org", role: "required", status: "accepted" },
      { name: "Ирина Дьяченко", email: "irina@example.org", role: "optional", status: "needs_action" },
    ],
  });

  it("is quiet, names the answer and adds nothing to the calendar", () => {
    const t = draw(notice({ method: "reply", events: [answered] }));
    expect(t.querySelector(".cal")!.classList.contains("quiet")).toBe(true);
    expect(t.querySelector(".cal-h")?.textContent).toContain("Ответ участника");
    expect(t.querySelector(".cal-h .pill.ok")?.textContent).toBe("Принято");
    expect(t.textContent).toContain("Это не новое приглашение");
    expect(buttons(t).join("|")).not.toContain("Добавить в календарь");
  });
});

describe("the whole day, several meetings and a file that did not read", () => {
  it("says a meeting of the whole day in a word", () => {
    const t = draw(
      notice({
        events: [meeting({ all_day: true, start: wall({ hour: 0, minute: 0, all_day: true }), end: wall({ day: 7, hour: 0, minute: 0, all_day: true }) })],
      }),
    );
    expect(t.querySelector(".cr.strong")?.textContent).toContain("весь день");
    expect(t.querySelector(".cal-h")?.textContent).toContain("Весь день");
  });

  it("shows the first meeting of a file of several and counts the rest", () => {
    const second = meeting({ uid: "u2@example.org", title: "Вторая", start: wall({ day: 16 }) });
    const third = meeting({ uid: "u3@example.org", title: "Третья", start: wall({ day: 23 }) });
    const t = draw(notice({ events: [meeting(), second, third] }));
    expect(t.querySelector(".cal-h")?.textContent).toContain("Приглашение · 3 события");
    expect(t.querySelector(".cal-t")?.textContent).toContain("Планёрка");
    expect(t.textContent).toContain("Ещё 2 события");
    expect(t.textContent).toContain("16 ноября");
  });

  it("keeps a file that did not read as an attachment and says why", () => {
    const t = draw(notice({ problem: "not_calendar", events: [], file: 0 }));
    expect(t.querySelector(".cal")!.classList.contains("quiet")).toBe(true);
    expect(t.querySelector(".cal-h")?.textContent).toContain("Вложение");
    expect(t.textContent).toContain("Приглашение не прочитано");
    expect(t.textContent).toContain("Файл не похож на приглашение");
    expect(buttons(t)).toEqual(["Сохранить .ics", "Открыть как текст"]);
    press(t, "Открыть как текст");
    expect(asked).toEqual(["text"]);
  });
});
