// The variants mechanism: the URL and localStorage carry the choices, an unanswered question
// answers «как сейчас», an unknown option is dropped, and the panel's notes are kept.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, parseUrl, variant, variants } from "./variants.svelte";
import { VERSION } from "./mockups/0.8.3";
import type { Question } from "./variants.svelte";

const QUESTIONS: Question[] = [
  { id: "1.1", title: "вопрос", options: [{ id: "V", title: "первый" }, { id: "Б", title: "второй" }] },
  { id: "2.1", title: "другой", options: [{ id: "B", title: "третий" }] },
];

/** A localStorage that keeps what is written, for the tests that check persistence. */
function storage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("разбор ?v=", () => {
  it("читает пары «вопрос:вариант»", () => {
    expect(parseUrl("?v=1.1:V,2.1:B")).toEqual({ "1.1": "V", "2.1": "B" });
  });

  it("без параметра — ничего", () => {
    expect(parseUrl("")).toEqual({});
    expect(parseUrl("?other=1")).toEqual({});
  });
});

describe("variant()", () => {
  beforeEach(() => {
    variants.questions = QUESTIONS;
    variants.init("");
  });

  it("по умолчанию «как сейчас»", () => {
    expect(variant("1.1")).toBe(NOW);
  });

  it("после выбора отвечает выбранным вариантом", () => {
    variants.set("1.1", "Б");
    expect(variant("1.1")).toBe("Б");
  });

  it("сброс возвращает «как сейчас»", () => {
    variants.set("1.1", "Б");
    variants.clear("1.1");
    expect(variant("1.1")).toBe(NOW);
  });

  it("ссылка ?v= задаёт выбор", () => {
    variants.init("?v=1.1:V,2.1:B");
    expect(variant("1.1")).toBe("V");
    expect(variant("2.1")).toBe("B");
    expect(variant("3.1")).toBe(NOW);
  });
});

describe("неизвестный вариант", () => {
  beforeEach(() => {
    variants.questions = QUESTIONS;
    variants.init("");
  });

  it("отбрасывается в init: вариант вне списка — «как сейчас»", () => {
    variants.init("?v=1.1:Z");
    expect(variant("1.1")).toBe(NOW);
  });

  it("вариант неизвестного вопроса тоже отбрасывается", () => {
    variants.init("?v=9.9:V");
    expect(variant("9.9")).toBe(NOW);
  });

  it("известный рядом с неизвестным остаётся", () => {
    variants.init("?v=1.1:V,1.2:Z");
    expect(variant("1.1")).toBe("V");
    expect(variant("1.2")).toBe(NOW);
  });
});

describe("?v= в ссылке отменяет сохранённое", () => {
  beforeEach(() => {
    variants.questions = QUESTIONS;
  });

  it("ответы берутся только из URL, не смешиваются с сохранёнными", () => {
    vi.stubGlobal("localStorage", storage());
    variants.init("?v=1.1:V");
    variants.set("2.1", "B");
    // Ссылка с ?v=: 2.1 из хранилища не подхватывается, 1.1 берётся из ссылки.
    variants.init("?v=1.1:Б");
    expect(variant("1.1")).toBe("Б");
    expect(variant("2.1")).toBe(NOW);
    vi.unstubAllGlobals();
  });

  it("без ?v= сохранённые ответы читаются", () => {
    vi.stubGlobal("localStorage", storage());
    variants.init("");
    variants.set("1.1", "V");
    variants.init("");
    expect(variant("1.1")).toBe("V");
    vi.unstubAllGlobals();
  });
});

describe("ключ хранилища и заметки", () => {
  beforeEach(() => {
    variants.questions = QUESTIONS;
  });

  it("ключ хранилища содержит версию макета", () => {
    const store = storage();
    vi.stubGlobal("localStorage", store);
    variants.init("");
    variants.set("1.1", "V");
    expect([...Array(store.length)].map((_, i) => store.key(i)).join(" ")).toContain(`depesha.demo.variants.${VERSION}`);
    vi.unstubAllGlobals();
  });

  it("заметки сохраняются и читаются при следующем запуске", () => {
    const store = storage();
    vi.stubGlobal("localStorage", store);
    variants.init("");
    variants.notes = [];
    variants.addNote("  поправить отступ  ");
    expect(variants.notes).toEqual(["поправить отступ"]);
    variants.notes = [];
    variants.init("");
    expect(variants.notes).toEqual(["поправить отступ"]);
    vi.unstubAllGlobals();
  });
});
