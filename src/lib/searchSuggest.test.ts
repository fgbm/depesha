import { afterEach, describe, expect, it } from "vitest";
import { applyCompletion, awaitsValue, completions, lastToken, type SuggestContext } from "./searchSuggest";
import { RecentSearches } from "./recentSearches.svelte";
import { i18n } from "./i18n.svelte";

afterEach(() => {
  i18n.lang = "en";
});

// display_name is the whole path decoded, as the IMAP backend gives it.
const folder = (name: string, display_name = name) => ({ name, display_name, delimiter: "/" });
const ctx = (lang: "en" | "ru"): SuggestContext => ({
  lang,
  now: new Date(2026, 9, 5),
  folders: [folder("INBOX"), folder("Работа"), folder("Работа/Проекты"), folder("Работа/Счета"), folder("Архив")],
  accounts: [{ email: "carol@example.com" }, { email: "ivan@example.org" }],
  labels: ["Срочно", "Клиент Север", "Счета"],
});

describe("search suggestions", () => {
  it("find the word being typed, a quoted value included", () => {
    expect(lastToken("больше:25М го")).toEqual({ start: 11, token: "го" });
    expect(lastToken('в:"Мои папки')).toEqual({ start: 0, token: 'в:"Мои папки' });
    expect(lastToken("from:ivan ")).toEqual({ start: 10, token: "" });
  });

  it("complete the operator being typed", () => {
    i18n.lang = "ru";
    const ops = completions("больше:25М го", ctx("ru"));
    expect(ops.map((c) => c.token)).toEqual(["год:"]);
    expect(applyCompletion("больше:25М го", ops[0])).toBe("больше:25М год:");
    expect(completions("lar", ctx("ru")).map((c) => c.token)).toEqual(["larger:"]);
  });

  it("offer years with their exact range", () => {
    i18n.lang = "ru";
    const years = completions("больше:25М год:20", ctx("ru"));
    expect(years.map((c) => c.token)).toEqual(["год:2026", "год:2025", "год:2024", "год:2023", "год:2022", "год:2021"]);
    expect(years[2].detail).toMatch(/^1 янв\.? 2024 г?\.? — 31 дек\.? 2024 г?\.? включительно$/);
    expect(applyCompletion("больше:25М год:20", years[2])).toBe("больше:25М год:2024 ");
    expect(completions("year:2024", ctx("en"))).toEqual([]);
  });

  it("offer a folder alone or with its subfolders", () => {
    i18n.lang = "ru";
    const found = completions("в:раб", ctx("ru"));
    expect(found.map((c) => [c.token, c.detail])).toEqual([
      ["в:Работа", "только папка"],
      ["в:Работа/*", "папка и подпапки (2)"],
      ["в:Работа/Проекты", "только папка"],
      ["в:Работа/Счета", "только папка"],
    ]);
    i18n.lang = "en";
    expect(completions("in:Архив", ctx("en")).map((c) => c.token)).toEqual(["in:Архив"]);
  });

  it("offer the readable folder name, not modified UTF-7 (#197)", () => {
    i18n.lang = "ru";
    const raw = "&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-";
    const c = { ...ctx("ru"), folders: [folder(raw, "Отправленные"), folder(`${raw}/&BB8-`, "Отправленные/П")] };
    expect(completions("в:отправ", c).map((x) => x.token)).toEqual(["в:Отправленные", "в:Отправленные/*", "в:Отправленные/П"]);
    expect(completions("в:BB4EQ", c).map((x) => x.token)).toContain("в:Отправленные");
    expect(applyCompletion("в:отправ", completions("в:отправ", c)[1])).toBe("в:Отправленные/* ");
  });

  it("name a folder with a role as the sidebar does, the server's name in its hint (А11)", () => {
    i18n.lang = "ru";
    const c = { ...ctx("ru"), folders: [{ ...folder("INBOX"), role: "inbox" as const }, { ...folder("Trash"), role: "trash" as const }, folder("Работа")] };
    const found = completions("в:", c);
    expect(found.map((x) => x.token)).toEqual(["в:Входящие", "в:Корзина", "в:Работа"]);
    expect(found.map((x) => x.title)).toEqual(["INBOX", "Trash", undefined]);
    expect(completions("в:вход", c).map((x) => x.token)).toEqual(["в:Входящие"]);
  });

  it("offer thresholds and mailboxes", () => {
    expect(completions("larger:2", ctx("en")).map((c) => c.token)).toEqual(["larger:25M"]);
    expect(completions("account:iv", ctx("en")).map((c) => c.token)).toEqual(["account:ivan@example.org"]);
  });

  it("offer label names for «метка:», quoting the ones with spaces (#42)", () => {
    i18n.lang = "ru";
    expect(completions("метка:сро", ctx("ru")).map((c) => c.token)).toEqual(["метка:Срочно"]);
    expect(completions("метка:кли", ctx("ru")).map((c) => c.token)).toEqual(['метка:"Клиент Север"']);
    i18n.lang = "en";
    expect(completions("label:сч", ctx("en")).map((c) => c.token)).toEqual(["label:Счета"]);
  });
});

describe("recent searches", () => {
  it("keep the last five, the newest on top, each once, across restarts", () => {
    let saved: string | null = null;
    const storage = { get: () => saved, set: (v: string) => (saved = v) };
    const r = new RecentSearches(storage);
    for (const q of ["a", "b", "c", "d", "e", "f"]) r.remember(q);
    r.remember("  c  ");
    r.remember("");
    expect(r.list).toEqual(["c", "f", "e", "d", "b"]);
    expect(new RecentSearches(storage).list).toEqual(["c", "f", "e", "d", "b"]);
    expect(new RecentSearches({ get: () => "not json", set: () => {} }).list).toEqual([]);
  });
});

describe("awaitsValue (А2)", () => {
  const inbox = { kind: "folder" as const, token: "в:Входящие", detail: "", done: true };
  it("waits for an empty value and for a value still offered, not for a free one", () => {
    expect(awaitsValue("в:", [])).toBe(true);
    expect(awaitsValue("от:ann есть:", [])).toBe(true);
    expect(awaitsValue("в:Вх", [inbox])).toBe(true);
    expect(awaitsValue("в:Входящие", [inbox])).toBe(false);
    expect(awaitsValue("от:ann", [])).toBe(false);
    expect(awaitsValue("в: ", [])).toBe(false);
    expect(awaitsValue("счёт", [])).toBe(false);
  });
});
