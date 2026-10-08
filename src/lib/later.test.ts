import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import { sendLaterPresets, when } from "./later";
import { avatarColor, matches } from "./format";
import { emptyDraft } from "./compose";

const me = { name: "Иван", email: "ivan@corp.example" };

// These tests check the Russian wording; English has its own tests in i18n.test.ts.
beforeEach(() => {
  i18n.lang = "ru";
});

describe("send later presets", () => {
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
