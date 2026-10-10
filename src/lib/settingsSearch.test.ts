import { describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import { PAGES } from "./settingsCatalog";
import { buildSettingsIndex } from "./settingsFields";
import { matchesText, searchSettings, words, type SearchEntry } from "./settingsSearch";

// The search of the settings window (#68, frame 4А): it looks through the descriptions of the
// pages, so a new page joins by declaring its fields; Russian endings are matched by the
// beginning of a word, as "уведом" finds «Уведомления».

function index(): SearchEntry[] {
  i18n.lang = "ru";
  return buildSettingsIndex();
}

describe("the words of a text", () => {
  it("splits on anything that is not a letter or a digit, in lower case", () => {
    expect(words("Найти настройку")).toEqual(["найти", "настройку"]);
    expect(words("HTML / Markdown")).toEqual(["html", "markdown"]);
    expect(words("")).toEqual([]);
  });

  it("matches a word by its beginning, so Russian endings do not matter", () => {
    expect(matchesText("Уведомления", "уведом")).toBe(true);
    expect(matchesText("Формат новых писем", "форм")).toBe(true);
    expect(matchesText("Формат новых писем", "формат")).toBe(true);
    expect(matchesText("Обновления", "уведом")).toBe(false);
  });
});

describe("finding a setting by name", () => {
  it("finds a page by its name", () => {
    const hits = searchSettings(index(), "хранение");
    expect(hits.some((h) => h.page === "storage" && h.label === "Хранение")).toBe(true);
  });

  it("finds a field and says which page and section it is on", () => {
    const hits = searchSettings(index(), "крупного письма");
    const hit = hits.find((h) => h.label === "Порог крупного письма");
    expect(hit).toBeDefined();
    expect(hit!.page).toBe("storage");
    expect(hit!.section).toBe("Поиск");
  });

  it("finds the fields of a person's card, though the card is in the main window now and a hit leads there (#104)", () => {
    const send = searchSettings(index(), "формат писем").find((h) => h.anchor === "people-send");
    expect(send).toBeDefined();
    expect(send!.page).toBe("people");
    const all = index().filter((e) => e.page === "people").map((e) => e.anchor);
    for (const a of ["people-name", "people-send", "people-view", "people-note", "people-hide", "people-addresses"]) expect(all).toContain(a);
  });

  it("finds the format field by «markdown», though the word is only a synonym", () => {
    const hits = searchSettings(index(), "markdown");
    const hit = hits.find((h) => h.label === "Формат новых писем");
    expect(hit).toBeDefined();
    expect(hit!.page).toBe("writing");
    // The label of the field is Russian; the word is found in what it can take.
    expect(hit!.anchor).toBe("compose_format");
  });

  it("puts a label match above a page-name match, and keeps the index order within a rank", () => {
    const hits = searchSettings(index(), "писем");
    const labels = hits.map((h) => h.label);
    // "Формат новых писем" holds the word in its label; a field that has it only in its
    // section («Список писем») comes after.
    expect(labels.indexOf("Формат новых писем")).toBeLessThan(labels.indexOf("Собирать переписку в цепочки"));
  });

  it("finds nothing for an empty query", () => {
    expect(searchSettings(index(), "   ")).toEqual([]);
  });

  it("finds the page «People» and the hints (#66, #69)", () => {
    expect(searchSettings(index(), "контакты").some((h) => h.page === "people")).toBe(true);
    // The old name still finds it.
    expect(searchSettings(index(), "люди").some((h) => h.page === "people")).toBe(true);
    expect(searchSettings(index(), "подсказки").some((h) => h.page === "look" && h.anchor === "hints")).toBe(true);
  });

  it("finds a switch put back by the closed note about the parts of a letter (#103)", () => {
    expect(searchSettings(index(), "три части").some((h) => h.anchor === "markdown_parts_note")).toBe(true);
  });
});

describe("ё and е are the same letter", () => {
  // No page or field of the core holds «ё», so the pair is checked on index data of its own:
  // one label written with «ё», one with «е».
  const entries: SearchEntry[] = [
    { page: "storage", group: "Хранение", section: "Поиск", label: "Объём кэша писем", anchor: "cache" },
    { page: "writing", group: "Написание", section: "Отправка", label: "Объем вложений", anchor: "size" },
  ];

  it("finds a label with «ё» by a query that spells it with «е»", () => {
    const hits = searchSettings(entries, "объем");
    expect(hits.map((h) => h.label)).toContain("Объём кэша писем");
  });

  it("finds a label with «е» by a query that spells it with «ё»", () => {
    const hits = searchSettings(entries, "объём");
    expect(hits.map((h) => h.label)).toContain("Объем вложений");
  });

  it("reads the two letters as one in the words of a text", () => {
    expect(words("Объём")).toEqual(words("Объем"));
    expect(matchesText("Объём письма", "объем")).toBe(true);
    expect(matchesText("Объем письма", "объём")).toBe(true);
  });
});

describe("the case of the query does not matter", () => {
  it("finds the same hits whether the query is upper or lower case", () => {
    const idx = index();
    expect(searchSettings(idx, "УВЕДОМ")).toEqual(searchSettings(idx, "уведом"));
    expect(searchSettings(idx, "Markdown")).toEqual(searchSettings(idx, "markdown"));
    expect(searchSettings(idx, "MARKDOWN")).toEqual(searchSettings(idx, "markdown"));
  });
});

describe("several words are all required", () => {
  it("finds «Формат новых писем» by «нов пис»", () => {
    const hits = searchSettings(index(), "нов пис");
    expect(hits.map((h) => h.label)).toContain("Формат новых писем");
  });

  it("finds nothing when one of the words matches no word of the entry", () => {
    expect(searchSettings(index(), "нов письмо")).toEqual([]);
  });

  it("finds an entry when its words come from different fields", () => {
    // "написание" names the page, "формат" the field on it.
    const hits = searchSettings(index(), "написание формат");
    expect(hits.map((h) => h.label)).toContain("Формат новых писем");
  });
});

describe("the index is declared, not read off the window", () => {
  const rows = PAGES.flatMap((p) => p.groups.flatMap((g) => g.rows.filter((r) => r.kind !== "layer" && !r.visible).map((r) => ({ page: p.id, id: r.id }))));

  it("has an entry for every page of the menu and every row", () => {
    const built = index();
    for (const p of new Set(PAGES.map((x) => x.id))) {
      expect(built.some((e) => e.page === p && e.anchor === null)).toBe(true);
    }
    for (const r of rows) {
      expect(built.some((e) => e.page === r.page && e.anchor === r.id)).toBe(true);
    }
  });

  it("gives every row an id to scroll to", () => {
    for (const r of rows) expect(r.id).toBeTruthy();
  });
});
