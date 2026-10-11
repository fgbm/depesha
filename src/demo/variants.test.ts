// The variants mechanism: the URL and localStorage carry the choices, and an unanswered
// question answers «как сейчас».

import { beforeEach, describe, expect, it } from "vitest";
import { NOW, parseUrl, variant, variants } from "./variants.svelte";

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
  beforeEach(() => variants.init(""));

  it("по умолчанию «как сейчас»", () => {
    expect(variant("1.1")).toBe(NOW);
  });

  it("после выбора отвечает выбранным вариантом", () => {
    variants.set("1.1", "B");
    expect(variant("1.1")).toBe("B");
  });

  it("сброс возвращает «как сейчас»", () => {
    variants.set("1.1", "B");
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
