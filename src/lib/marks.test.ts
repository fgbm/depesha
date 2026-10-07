import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import { headerMarks, rowMarks } from "./marks";

// Wednesday 7 October 2026, noon.
const now = new Date(2026, 9, 7, 12, 0);
const at = (d: number, h: number, m: number, month = 9, year = 2026) => new Date(year, month, d, h, m).getTime() / 1000;

beforeEach(() => {
  i18n.lang = "ru";
});

describe("the marks of a row", () => {
  it("none for a letter nothing was done with", () => {
    expect(rowMarks([], now)).toEqual([]);
    expect(rowMarks(undefined, now)).toEqual([]);
  });

  it("a reply with its time; one from the server says the time is unknown", () => {
    expect(rowMarks([{ act: "reply", at: at(5, 14, 20) }], now)).toEqual([{ act: "reply", label: "Отвечено", title: "Отвечено: 5 окт, 14:20" }]);
    expect(rowMarks([{ act: "reply", at: null }], now)).toEqual([{ act: "reply", label: "Отвечено", title: "Отвечено · отметка сервера, время неизвестно" }]);
  });

  it("a reply and a reply to all are one mark, the fuller one, with both in the tooltip", () => {
    const marks = rowMarks([{ act: "reply", at: at(5, 14, 20) }, { act: "reply_all", at: at(6, 9, 0) }], now);
    expect(marks).toEqual([{ act: "reply_all", label: "Отвечено всем", title: "Отвечено: 5 окт, 14:20\nОтвечено всем: 6 окт, 09:00" }]);
  });

  it("the reply first, the forward after it, always in that order", () => {
    const marks = rowMarks([{ act: "forward", at: at(6, 9, 5) }, { act: "reply_all", at: null }], now);
    expect(marks.map((m) => m.act)).toEqual(["reply_all", "forward"]);
    expect(marks[1]).toEqual({ act: "forward", label: "Переслано", title: "Переслано: 6 окт, 09:05" });
  });

  it("today and another year are said so", () => {
    expect(rowMarks([{ act: "forward", at: at(7, 9, 5) }], now)[0].title).toBe("Переслано: сегодня, 09:05");
    expect(rowMarks([{ act: "forward", at: at(5, 9, 5, 9, 2025) }], now)[0].title).toBe("Переслано: 5 окт 2025, 09:05");
  });

  it("speaks English too", () => {
    i18n.lang = "en";
    expect(rowMarks([{ act: "reply_all", at: null }], now)[0]).toEqual({ act: "reply_all", label: "Replied to all", title: "Replied to all · server mark, time unknown" });
  });
});

describe("the marks in the header of a letter", () => {
  it("says what was done and when, in words", () => {
    expect(headerMarks([{ act: "reply", at: at(5, 14, 20) }, { act: "forward", at: at(6, 9, 5) }], now)).toEqual([
      { act: "reply", text: "Вы ответили 5 окт в 14:20", answer: true },
      { act: "forward", text: "Переслано 6 окт в 09:05", answer: false },
    ]);
  });

  it("a reply to all is told as one, the fuller one", () => {
    expect(headerMarks([{ act: "reply", at: at(5, 14, 20) }, { act: "reply_all", at: at(6, 16, 40) }], now)).toEqual([
      { act: "reply_all", text: "Вы ответили всем 6 окт в 16:40", answer: true },
    ]);
  });

  it("only the word when the server alone knows it", () => {
    expect(headerMarks([{ act: "reply", at: null }, { act: "forward", at: null }], now)).toEqual([
      { act: "reply", text: "Отвечено", answer: true },
      { act: "forward", text: "Переслано", answer: false },
    ]);
    expect(headerMarks([], now)).toEqual([]);
  });
});
