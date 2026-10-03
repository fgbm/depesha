import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import { sendLaterPresets, snoozePresets, when } from "./later";
import { ownText, preflight } from "./preflight";
import { avatarColor, matches } from "./format";
import { emptyDraft } from "./compose";

const me = { name: "Иван", email: "ivan@corp.example" };

// These tests check the Russian wording; English has its own tests in i18n.test.ts.
beforeEach(() => {
  i18n.lang = "ru";
});

describe("snooze presets", () => {
  it("offers the evening only before it starts, and Monday morning", () => {
    const friday = new Date(2026, 9, 2, 10, 0); // Fri 2 Oct 2026, 10:00
    const labels = snoozePresets(friday).map((p) => p.label);
    expect(labels).toEqual(["Через час", "Сегодня вечером", "Завтра утром", "В понедельник", "Через неделю"]);
    const monday = snoozePresets(friday).find((p) => p.label === "В понедельник")!;
    expect(new Date(monday.at * 1000).getDay()).toBe(1);
    expect(new Date(monday.at * 1000).getHours()).toBe(9);
    expect(snoozePresets(new Date(2026, 9, 2, 19, 0)).map((p) => p.label)).not.toContain("Сегодня вечером");
  });

  it("does not repeat the same moment", () => {
    // Sunday: tomorrow morning is Monday morning.
    const sunday = new Date(2026, 9, 4, 12, 0);
    const ats = sendLaterPresets(sunday).map((p) => p.at);
    expect(new Set(ats).size).toBe(ats.length);
  });

  it("says when in words", () => {
    const now = new Date(2026, 9, 2, 10, 0);
    expect(when(new Date(2026, 9, 2, 18, 0).getTime() / 1000, now)).toBe("сегодня в 18:00");
    expect(when(new Date(2026, 9, 3, 9, 0).getTime() / 1000, now)).toBe("завтра в 09:00");
  });
});

describe("preflight", () => {
  it("catches a forgotten attachment, but not in the quote", () => {
    const d = { ...emptyDraft(me), to: [{ name: null, email: "a@corp.example" }], subject: "x", text: "Счёт во вложении." };
    expect(preflight(d, me.email).map((w) => w.kind)).toEqual(["attachment"]);
    const quoted = { ...d, text: "Спасибо!\n\n01.10.2026 10:00, Пётр пишет:\n> прилагаю счёт" };
    expect(preflight(quoted, me.email)).toEqual([]);
    expect(ownText("Привет\n\n-- \nИван, прилагаю всегда")).toBe("Привет");
  });

  it("warns when colleagues and outsiders share a letter", () => {
    const d = {
      ...emptyDraft(me),
      subject: "x",
      to: [{ name: null, email: "boss@corp.example" }],
      cc: [{ name: null, email: "partner@other.example" }],
    };
    expect(preflight(d, me.email).map((w) => w.kind)).toEqual(["external"]);
    // Personal mailboxes: everyone is "external", that is normal.
    expect(preflight({ ...d }, "me@gmail.com")).toEqual([]);
  });

  it("counts recipients and notices an empty subject", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ name: null, email: `u${i}@corp.example` }));
    expect(preflight({ ...emptyDraft(me), to: many }, me.email).map((w) => w.kind)).toEqual(["many", "subject"]);
  });
});

describe("helpers", () => {
  it("gives every sender a stable colour", () => {
    expect(avatarColor("a@x.example")).toBe(avatarColor("A@X.example"));
    expect(avatarColor("a@x.example")).not.toBe(avatarColor("b@x.example"));
  });

  it("matches palette commands by word starts", () => {
    expect(matches("Переместить в «Работа/Отчёты»", "пер отч")).toBe(true);
    expect(matches("Отложить", "лож")).toBe(false);
    expect(matches("Архив", "")).toBe(true);
  });
});
