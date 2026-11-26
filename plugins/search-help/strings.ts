import type { Text } from "@depesha/plugin-api";

export const S = {
  name: { en: "Search syntax", ru: "Синтаксис поиска" },
  about: {
    en: "A floating cheat sheet for a complex search query: operators, combinations, examples.",
    ru: "Плавающая памятка для сложного поиска: операторы, сочетания, примеры.",
  },
  command: { en: "How to search: operators and examples", ru: "Как искать: операторы и примеры" },
  title: { en: "How to search", ru: "Как искать" },
  lead: {
    en: "A complex query is operators separated by spaces. Choose a row to copy it, then paste it into the search box.",
    ru: "Сложный запрос — это операторы через пробел. Выберите строку, она скопируется, вставьте её в поле поиска.",
  },
  filter: { en: "Operator or example: from, attachment, size…", ru: "Оператор или пример: от, вложение, размер…" },
  operators: { en: "Operators", ru: "Операторы" },
  examples: { en: "Complex queries", ru: "Сложные запросы" },
  tips: { en: "Details", ru: "Подробности" },
  empty: { en: "Nothing found", ru: "Ничего не найдено" },
  copied: { en: "Copied", ru: "Скопировано" },
  copyFailed: { en: "Could not copy", ru: "Не удалось скопировать" },
  footer: {
    en: "Esc close · ↑ ↓ choose · Enter copy · a click copies too",
    ru: "Esc — закрыть · ↑ ↓ — выбрать · Enter — скопировать · клик тоже копирует",
  },
} satisfies Record<string, Text>;
