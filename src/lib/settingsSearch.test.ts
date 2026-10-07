import { describe, expect, it } from "vitest";
import { SETTINGS_FIELDS, buildSettingsIndex } from "./settingsFields";
import { matchesText, searchSettings, words, type SearchEntry } from "./settingsSearch";

// The search of the settings window (#68, frame 4А): it looks through the descriptions of the
// pages, so a new page joins by declaring its fields; Russian endings are matched by the
// beginning of a word, as "уведом" finds «Уведомления».

function index(): SearchEntry[] {
  // Titles as the window shows them; keys resolved to Russian, as the scenario reads it.
  const titles: Record<string, string> = {
    general: "Общие",
    updates: "Обновления",
    mail: "Почта",
    notifications: "Уведомления",
    background: "Фон и запуск",
    offline: "Офлайн-доступ",
  };
  const ru: Record<string, string> = {
    "settings.language": "Язык",
    "settings.appearance": "Оформление",
    "settings.search": "Поиск",
    "settings.largeMail": "Порог крупного письма",
    "settings.updates": "Обновления",
    "settings.updatesAuto": "Устанавливать автоматически",
    "settings.updatesNotify": "Только сообщать",
    "settings.updatesOff": "Никогда",
    "settings.checkNow": "Проверить сейчас",
    "settings.list": "Список писем",
    "settings.threads": "Собирать переписку в цепочки",
    "settings.senderLogos": "Логотипы компаний рядом с их письмами",
    "settings.newMessages": "Новые письма",
    "settings.composeFormat": "Формат новых писем",
    "format.html": "HTML",
    "format.markdown": "Markdown",
    "format.plain": "Обычный текст",
    "settings.defaultAccount": "Ящик по умолчанию",
    "settings.reading": "Чтение",
    "settings.letterView": "Показывать письма",
    "settings.letterView.markdown": "Предпочитать Markdown",
    "settings.letterView.text": "Предпочитать обычный текст",
    "settings.attachmentsDir": "Папка для вложений",
    "settings.sending": "Отправка",
    "settings.undoSend": "Можно отменить отправку в течение",
    "settings.notifications": "Уведомления",
    "settings.notifyPeople": "Только о письмах от людей",
    "settings.notifyAll": "Обо всех новых письмах",
    "settings.notifyNone": "Не показывать",
    "settings.quota": "Квота ящика",
    "bg.onClose": "Когда закрываю окно",
    "bg.atLogin": "При входе в систему",
    "bg.trayIcon": "Значок в трее",
    "settings.offline": "Офлайн-доступ",
    "settings.offlineKeep": "Скачивать письма целиком",
    "settings.offlineYear": "за последний год",
    "settings.offlineAll": "все письма",
  };
  return buildSettingsIndex((p) => titles[p] ?? p, (k) => ru[k] ?? k);
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
    const hits = searchSettings(index(), "почта");
    expect(hits.some((h) => h.page === "mail" && h.label === "Почта")).toBe(true);
  });

  it("finds a field and says which page and section it is on", () => {
    const hits = searchSettings(index(), "крупного письма");
    const hit = hits.find((h) => h.label === "Порог крупного письма");
    expect(hit).toBeDefined();
    expect(hit!.page).toBe("general");
    expect(hit!.section).toBe("Поиск");
  });

  it("finds the format field by «markdown», though the word is only a synonym", () => {
    const hits = searchSettings(index(), "markdown");
    const hit = hits.find((h) => h.label === "Формат новых писем");
    expect(hit).toBeDefined();
    expect(hit!.page).toBe("mail");
    // The label of the field is Russian; the word is found in what it can take.
    expect(hit!.anchor).toBe("mail-new");
  });

  it("puts a label match above a page-name match, and keeps the index order within a rank", () => {
    const hits = searchSettings(index(), "писем");
    const labels = hits.map((h) => h.label);
    // "Формат новых писем" and "Скачивать письма целиком" hold the word; the page «Почта»
    // alone does not. A field whose label holds it comes before one only in its synonyms.
    expect(labels.indexOf("Формат новых писем")).toBeLessThan(labels.indexOf("Собирать переписку в цепочки"));
  });

  it("finds nothing for an empty query", () => {
    expect(searchSettings(index(), "   ")).toEqual([]);
  });
});

describe("the index is declared, not read off the window", () => {
  const pages = [...new Set(SETTINGS_FIELDS.map((f) => f.page))];

  it("has an entry for every page and every field", () => {
    const built = index();
    for (const p of pages) {
      expect(built.some((e) => e.page === p && e.anchor === null)).toBe(true);
    }
    for (const f of SETTINGS_FIELDS) {
      expect(built.some((e) => e.page === f.page && e.anchor === f.anchor)).toBe(true);
    }
  });

  it("gives every field a section to scroll to", () => {
    for (const f of SETTINGS_FIELDS) expect(f.anchor).toBeTruthy();
  });
});
