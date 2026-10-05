import { afterEach, describe, expect, it } from "vitest";
import { asksLarge, folderOperator, readyQueries, recentYears, threshold } from "./largeMail";
import { size } from "./format";
import { i18n } from "./i18n.svelte";

afterEach(() => {
  i18n.lang = "en";
});

describe("large mail", () => {
  it("builds the ready queries from the threshold, in the language of the search box", () => {
    const now = new Date(2026, 9, 5);
    i18n.lang = "ru";
    expect(readyQueries(25, now).map((q) => [q.title, q.text])).toEqual([
      ["Крупные (больше 25 МБ)", "больше:25М"],
      ["Крупные старше года", "больше:25М старше:1г"],
      ["Крупные старше двух лет", "больше:25М старше:2г"],
      ["Крупные за 2025 год", "больше:25М год:2025"],
      ["Крупные за 2024 год", "больше:25М год:2024"],
      ["С вложениями старше года", "есть:вложение старше:1г"],
    ]);
    i18n.lang = "en";
    const en = readyQueries(40, now, "Work/Clients");
    expect(en[0]).toEqual({ id: "large", title: "Large (over 40 MB)", text: "larger:40M" });
    expect(en.at(-1)).toEqual({ id: "folder", title: "Large in this folder and its subfolders", text: "larger:40M in:Work/Clients/*" });
  });

  it("quotes a folder with spaces", () => {
    expect(folderOperator("My Folder", true, "en")).toBe('in:"My Folder/*"');
    expect(folderOperator("Работа", false, "ru")).toBe("в:Работа");
  });

  it("puts the largest first only when the query asks for large letters", () => {
    expect(asksLarge("больше:25М год:2024")).toBe(true);
    expect(asksLarge("Larger:5M")).toBe(true);
    expect(asksLarge("меньше:1М")).toBe(false);
    expect(asksLarge("larger things")).toBe(false);
    expect(asksLarge("from:larger@example.com")).toBe(false);
  });

  it("takes a threshold only as whole megabytes", () => {
    expect(threshold(30)).toBe(30);
    expect(threshold(12.6)).toBe(13);
    expect(threshold(0)).toBe(25);
    expect(threshold(Number.NaN, 40)).toBe(40);
  });

  it("offers this year and the ones before it", () => {
    expect(recentYears(new Date(2026, 9, 5), 3)).toEqual([2026, 2025, 2024]);
  });

  it("names sizes up to gigabytes in the interface language", () => {
    expect(size(512)).toBe("512 B");
    expect(size(25 * 1024 * 1024)).toBe("25.0 MB");
    expect(size(148 * 1024 * 1024)).toBe("148 MB");
    expect(size(25 * 1024 * 1024, 0)).toBe("25 MB");
    expect(size(3.5 * 1024 ** 3)).toBe("3.5 GB");
    i18n.lang = "ru";
    // Thousands grouped as the language groups them.
    expect(size(1023 * 1024)).toMatch(/^1\s023 КБ$/);
    expect(size(96.4 * 1024 * 1024)).toBe("96,4 МБ");
  });
});
